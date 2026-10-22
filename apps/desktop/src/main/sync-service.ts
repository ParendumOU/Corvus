import os from "node:os";
import path from "node:path";
import type { SyncStateStorage } from "@corvus/shared";
import type { CorvusSyncClient, SyncEngine } from "@corvus/sync-core";
import { extensionSuggestions, webstoreExtensions, type ExtensionSuggestion, type SyncedExtension } from "../shared/extension-suggestions";
import { SYNC_INTERVALS_MINUTES, type SyncDeviceView, type SyncOptions, type SyncStatus } from "../shared/ipc";
import { OpenTabsPublisher, collectTabs, parseDeviceTabs, type RemoteDeviceTabs } from "../shared/open-tabs";
import type { AppContext } from "./context";
import { JsonFile } from "./json-file";
import { loadOptionalModule } from "./module-loader";
import type { ProfileRuntime } from "./profiles";
import type { SecretCipher } from "./settings-store";
import { SyncRemoteStore, createSyncAdapters } from "./sync-adapters";
import { SyncScheduler } from "./sync-scheduler";

type SyncCoreModule = typeof import("@corvus/sync-core");

interface ProfileSyncState {
  enabled: boolean;
  serverUrl: string;
  deviceName: string;
  chainId: string | null;
  phrase: { enc: boolean; data: string } | null;
  lastSyncAt: number | null;
  intervalMinutes: number;
  syncServiceUrls: boolean;
  /** Sync saved workflows (per device, default on; off keeps local data). */
  syncWorkflows: boolean;
  /** Sync site memory (per device, default on; off keeps local data). */
  syncSiteMemory: boolean;
  /** Client/engine state written by older versions; moved to sync-kv.json on first start. */
  kv?: Record<string, string>;
}

/** Everything that runs while sync is on for one loaded profile. */
interface Runtime {
  profile: ProfileRuntime;
  client: CorvusSyncClient;
  scheduler: SyncScheduler;
  tabs: OpenTabsPublisher;
  /** Last observed state of things without a change event (see localChanged). */
  seen: { extensionIds: string; meta: string };
  dispose: Array<() => void>;
}

const DEFAULT_INTERVAL_MINUTES = 5;
const CHANGE_DEBOUNCE_MS = 10_000;
const CHANGE_MAX_WAIT_MS = 60_000;
/** How often open tabs, installed extensions and profile metadata are checked for changes. */
const WATCH_INTERVAL_MS = 3_000;
const WIPE_CONFIRMATION = "DELETE";

function describeError(err: unknown, serverUrl: string): string {
  const { code, message } = err as { code?: unknown; message?: unknown };
  switch (code) {
    case "device_removed":
      return "This device was removed from the sync chain. Turn sync off, then join again with your recovery phrase.";
    case "chain_not_found":
      return "This sync chain no longer exists on the server (it may have been deleted from another device). Turn sync off to start over.";
    case "rate_limited":
      return "The sync server is busy. Corvus will retry automatically.";
    case "clock_skew":
      return "Your system clock is more than 5 minutes off, so the sync server rejected the request.";
    case "quota_exceeded":
      return `The sync server's storage limit was reached: ${String(message)}`;
  }
  if (err instanceof TypeError && /fetch failed/i.test(err.message)) return `Cannot reach the sync server at ${serverUrl}.`;
  return typeof message === "string" ? message : String(err);
}

function extensionIdsKey(profile: ProfileRuntime): string {
  return profile.session.extensions
    .getAllExtensions()
    .map((e) => e.id)
    .sort()
    .join(",");
}

function metaKey(profile: ProfileRuntime): string {
  return `${profile.profile.name}\u0000${profile.profile.avatar ?? ""}`;
}

/**
 * Per-profile, end-to-end encrypted sync through @corvus/sync-core's SyncEngine: bookmarks, history,
 * allowlisted settings, profile name/avatar, open tabs and installed extensions, reading list,
 * watches, workspaces, annotations, and (unless turned off on this device) workflows and site
 * memory (see sync-adapters.ts).
 * A sync chain belongs to exactly one profile. Crypto and the wire protocol live in sync-core.
 */
export class SyncService {
  private readonly states = new Map<string, JsonFile<ProfileSyncState>>();
  private readonly kvFiles = new Map<string, JsonFile<Record<string, string>>>();
  private readonly remotes = new Map<string, SyncRemoteStore>();
  private readonly runtimes = new Map<string, Runtime>();
  private readonly errors = new Map<string, string>();
  private readonly memoryPhrases = new Map<string, string>();
  private watcher: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly ctx: AppContext,
    private readonly cipher: SecretCipher,
    private readonly defaultServerUrl: string,
  ) {}

  private module(): Promise<SyncCoreModule | null> {
    return loadOptionalModule<SyncCoreModule>("@corvus/sync-core", "sync-core");
  }

  /** Background sync for every loaded profile with sync on: on start, after changes and periodically. */
  start(): void {
    if (this.watcher) return;
    this.ctx.settings.onChange((next, prev) => {
      if (next === prev) return;
      for (const rt of this.runtimes.values()) rt.scheduler.poke();
    });
    this.watcher = setInterval(() => void this.watch(), WATCH_INTERVAL_MS);
    this.watcher.unref?.();
    void this.watch();
  }

  stop(): void {
    if (this.watcher) clearInterval(this.watcher);
    this.watcher = null;
    for (const id of [...this.runtimes.keys()]) this.dispose(id);
    for (const kv of this.kvFiles.values()) kv.flush();
  }

  private async watch(): Promise<void> {
    const mod = await this.module();
    if (!mod) return;
    const alive = new Set(this.ctx.profiles.list().map((p) => p.id));
    for (const id of [...this.runtimes.keys()]) if (!alive.has(id)) this.dispose(id);
    for (const profile of this.ctx.profiles.loaded()) {
      const id = profile.profile.id;
      if (!alive.has(id)) continue;
      const rt = this.runtimes.get(id);
      if (rt) {
        if (this.localChanged(rt)) rt.scheduler.poke();
        continue;
      }
      if (!this.state(profile).get().enabled) continue;
      try {
        if (!this.phraseOf(profile)) continue;
        void this.runtime(profile, mod).scheduler.trigger();
      } catch (err) {
        this.errors.set(id, describeError(err, this.state(profile).get().serverUrl));
      }
    }
  }

  /** Changes that have no event of their own: open tabs, installed extensions, profile name/avatar. */
  private localChanged(rt: Runtime): boolean {
    const tabs = rt.tabs.refresh();
    const extensionIds = extensionIdsKey(rt.profile);
    const meta = metaKey(rt.profile);
    const changed = tabs || extensionIds !== rt.seen.extensionIds || meta !== rt.seen.meta;
    rt.seen = { extensionIds, meta };
    return changed;
  }

  private state(profile: ProfileRuntime): JsonFile<ProfileSyncState> {
    let file = this.states.get(profile.profile.id);
    if (!file) {
      const defaults = (): ProfileSyncState => ({
        enabled: false,
        serverUrl: this.defaultServerUrl,
        deviceName: os.hostname(),
        chainId: null,
        phrase: null,
        lastSyncAt: null,
        intervalMinutes: DEFAULT_INTERVAL_MINUTES,
        syncServiceUrls: false,
        syncWorkflows: true,
        syncSiteMemory: true,
      });
      file = JsonFile.load<ProfileSyncState>(
        path.join(profile.dataDir, "sync.json"),
        defaults,
        (raw) => ({ ...defaults(), ...(typeof raw === "object" && raw ? (raw as Partial<ProfileSyncState>) : {}) }),
        0,
      );
      this.states.set(profile.profile.id, file);
    }
    return file;
  }

  /** Client cursor/versions and engine fingerprints. Flushed after every cycle. */
  private kv(profile: ProfileRuntime): JsonFile<Record<string, string>> {
    let file = this.kvFiles.get(profile.profile.id);
    if (!file) {
      const legacy = this.state(profile).get().kv;
      file = JsonFile.load<Record<string, string>>(
        path.join(profile.dataDir, "sync-kv.json"),
        () => ({ ...legacy }),
        (raw) => (typeof raw === "object" && raw ? (raw as Record<string, string>) : {}),
        1000,
      );
      if (legacy) {
        file.flush();
        this.state(profile).update(({ kv: _legacy, ...rest }) => rest);
      }
      this.kvFiles.set(profile.profile.id, file);
    }
    return file;
  }

  private remote(profile: ProfileRuntime): SyncRemoteStore {
    let store = this.remotes.get(profile.profile.id);
    if (!store) {
      store = new SyncRemoteStore(path.join(profile.dataDir, "sync-remote.json"));
      this.remotes.set(profile.profile.id, store);
    }
    return store;
  }

  private phraseOf(profile: ProfileRuntime): string | null {
    const memory = this.memoryPhrases.get(profile.profile.id);
    if (memory) return memory;
    const stored = this.state(profile).get().phrase;
    if (!stored) return null;
    return stored.enc ? this.cipher.decryptString(Buffer.from(stored.data, "base64")) : stored.data;
  }

  private runtime(profile: ProfileRuntime, mod: SyncCoreModule): Runtime {
    const id = profile.profile.id;
    const existing = this.runtimes.get(id);
    if (existing) return existing;
    const phrase = this.phraseOf(profile);
    if (!phrase) throw new Error("Sync is not set up for this profile");
    const file = this.state(profile);
    const kv = this.kv(profile);
    const storage: SyncStateStorage = {
      get: async (key) => kv.get()[key],
      set: async (key, value) => {
        kv.update((all) => ({ ...all, [key]: value }));
      },
    };
    const client = mod.createSyncClient({
      serverUrl: file.get().serverUrl,
      phrase,
      deviceName: file.get().deviceName,
      platform: process.platform,
      storage,
      onInvalidRecord: (record, err) => console.warn(`[corvus] skipped sync record ${record.collection}/${record.id}:`, (err as Error).message),
    });
    const remote = this.remote(profile);
    const tabs = new OpenTabsPublisher(() => ({
      device: file.get().deviceName,
      platform: process.platform,
      tabs: collectTabs(this.ctx.windows.forProfile(id).map((w) => ({ tabs: w.listTabs(), groups: w.listGroups() }))),
    }));
    tabs.refresh();

    const seen = { extensionIds: extensionIdsKey(profile), meta: metaKey(profile) };
    // Workflows and site memory are categories the user can leave out on this device.
    const flows = file.get().syncWorkflows ? this.ctx.flows?.storeFor(profile) : undefined;
    const memory = file.get().syncSiteMemory ? this.ctx.flows?.memory.storeFor(profile) : undefined;
    const published = { key: "", extensions: [] as SyncedExtension[] };
    const engine = new mod.SyncEngine({
      client,
      storage,
      adapters: createSyncAdapters({
        bookmarks: profile.bookmarks,
        history: profile.history,
        credentials: profile.credentials,
        reading: profile.reading,
        watches: this.ctx.monitor.storeFor(profile),
        workspaces: profile.workspaces,
        annotations: profile.annotations,
        ...(flows ? { workflows: flows } : {}),
        ...(memory ? { siteMemory: memory } : {}),
        settings: this.ctx.settings,
        includeServiceUrls: () => file.get().syncServiceUrls,
        profile: {
          get: () => {
            const p = this.ctx.profiles.manager.require(id);
            return p.avatar ? { name: p.name, avatar: p.avatar } : { name: p.name };
          },
          set: (meta) => {
            this.ctx.profiles.setMeta(id, meta);
            this.ctx.windows.broadcastState();
          },
        },
        remote,
        ownDeviceId: () => client.getDeviceId(),
        openTabs: () => {
          tabs.refresh();
          return tabs.record();
        },
        extensions: () => {
          const key = extensionIdsKey(profile);
          if (key !== published.key) {
            published.key = key;
            published.extensions = webstoreExtensions(profile.extensions.list());
          }
          return { device: file.get().deviceName, extensions: published.extensions };
        },
      }),
    });
    const scheduler = new SyncScheduler({
      run: () => this.cycle(profile, engine),
      debounceMs: CHANGE_DEBOUNCE_MS,
      maxWaitMs: CHANGE_MAX_WAIT_MS,
      intervalMs: file.get().intervalMinutes * 60_000,
    });
    const rt: Runtime = {
      profile,
      client,
      scheduler,
      tabs,
      seen,
      dispose: [
        profile.bookmarks.changes.on(() => scheduler.poke()),
        profile.history.changes.on(() => scheduler.poke()),
        profile.credentials.changes.on(() => scheduler.poke()),
        profile.reading.onChange(() => scheduler.poke()),
        profile.workspaces.onChange(() => scheduler.poke()),
        profile.annotations.onChange(() => scheduler.poke()),
        this.ctx.monitor.storeFor(profile).onChange(() => scheduler.poke()),
        ...(flows ? [flows.onChange(() => scheduler.poke())] : []),
        ...(memory ? [memory.onChange(() => scheduler.poke())] : []),
      ],
    };
    this.runtimes.set(id, rt);
    return rt;
  }

  private dispose(profileId: string): void {
    const rt = this.runtimes.get(profileId);
    if (!rt) return;
    rt.scheduler.stop();
    for (const off of rt.dispose) off();
    this.runtimes.delete(profileId);
    this.kvFiles.get(profileId)?.flush();
  }

  private async cycle(profile: ProfileRuntime, engine: SyncEngine): Promise<void> {
    const id = profile.profile.id;
    const file = this.state(profile);
    try {
      // Local stores reach disk before the engine records anything as synced.
      profile.bookmarks.flush();
      profile.history.flush();
      profile.credentials.flush();
      profile.reading.flush();
      profile.workspaces.flush();
      profile.annotations.flush();
      this.ctx.monitor.storeFor(profile).flush();
      this.ctx.flows?.storeFor(profile).flush();
      this.ctx.flows?.memory.storeFor(profile).flush();
      await engine.sync();
      file.update((s) => ({ ...s, lastSyncAt: Date.now() }));
      this.errors.delete(id);
    } catch (err) {
      this.errors.set(id, describeError(err, file.get().serverUrl));
    } finally {
      this.kvFiles.get(id)?.flush();
    }
  }

  private async active(profile: ProfileRuntime): Promise<Runtime> {
    const mod = await this.module();
    if (!mod) throw new Error("Sync is not available in this build");
    if (!this.state(profile).get().enabled) throw new Error("Sync is off for this profile");
    return this.runtime(profile, mod);
  }

  async status(profile: ProfileRuntime): Promise<SyncStatus> {
    const mod = await this.module();
    const s = this.state(profile).get();
    const rt = this.runtimes.get(profile.profile.id);
    return {
      available: mod !== null,
      enabled: s.enabled,
      serverUrl: s.serverUrl,
      deviceName: s.deviceName,
      chainId: s.chainId,
      lastSyncAt: s.lastSyncAt,
      error: this.errors.get(profile.profile.id) ?? (mod ? null : "Sync engine (@corvus/sync-core) is not installed or not built."),
      deviceId: rt ? await rt.client.getDeviceId() : null,
      syncing: rt?.scheduler.busy ?? false,
      intervalMinutes: s.intervalMinutes,
      syncServiceUrls: s.syncServiceUrls,
      syncWorkflows: s.syncWorkflows,
      syncSiteMemory: s.syncSiteMemory,
    };
  }

  async generatePhrase(): Promise<string> {
    const mod = await this.module();
    if (!mod) throw new Error("Sync is not available in this build");
    return mod.generateRecoveryPhrase();
  }

  async enable(profile: ProfileRuntime, opts: { serverUrl: string; phrase: string; deviceName: string }): Promise<SyncStatus> {
    const mod = await this.module();
    if (!mod) throw new Error("Sync is not available in this build");
    const id = profile.profile.id;
    const phrase = mod.normalizeRecoveryPhrase(opts.phrase);
    if (!mod.validateRecoveryPhrase(phrase)) throw new Error("That recovery phrase is not valid");
    let serverUrl: string;
    try {
      serverUrl = new URL(opts.serverUrl).toString().replace(/\/$/, "");
    } catch {
      throw new Error("Enter a valid sync server URL");
    }
    const chainId = mod.deriveKeys(phrase).chainId;
    const clash = this.ctx.profiles.list().find((p) => p.id !== id && p.syncChainId === chainId);
    if (clash) throw new Error(`This recovery phrase already syncs the profile “${clash.name}” on this device. A sync chain belongs to one profile.`);

    this.dispose(id);
    const encrypted = this.cipher.isEncryptionAvailable();
    if (encrypted) this.memoryPhrases.delete(id);
    else this.memoryPhrases.set(id, phrase);
    this.state(profile).update((s) => ({
      ...s,
      enabled: false,
      chainId: null,
      lastSyncAt: null,
      serverUrl,
      deviceName: opts.deviceName.trim().slice(0, 64) || os.hostname(),
      phrase: encrypted ? { enc: true, data: this.cipher.encryptString(phrase).toString("base64") } : null,
    }));
    this.kv(profile).set({});
    this.remote(profile).clear();

    const rt = this.runtime(profile, mod);
    try {
      await rt.client.register();
    } catch (err) {
      this.dispose(id);
      const message = describeError(err, serverUrl);
      this.errors.set(id, message);
      throw new Error(message);
    }
    this.state(profile).update((s) => ({ ...s, enabled: true, chainId: rt.client.chainId }));
    this.ctx.profiles.setSyncChain(id, rt.client.chainId);
    this.errors.delete(id);
    await rt.scheduler.trigger();
    return this.status(profile);
  }

  /** Turn sync off on this device. Leaving also removes this device (and its tabs) from the chain. */
  async disable(profile: ProfileRuntime, leaveChain = true): Promise<SyncStatus> {
    const id = profile.profile.id;
    const rt = leaveChain && this.state(profile).get().enabled ? await this.active(profile).catch(() => undefined) : undefined;
    if (rt) {
      try {
        const own = await rt.client.getDeviceId();
        await rt.client.push([
          { collection: "open_tabs", id: own, payload: null, deleted: true },
          { collection: "extensions", id: own, payload: null, deleted: true },
        ]);
        await rt.client.removeDevice(own);
      } catch (err) {
        console.warn("[corvus] could not leave the sync chain cleanly:", (err as Error).message);
      }
    }
    this.dispose(id);
    this.memoryPhrases.delete(id);
    this.state(profile).update((s) => ({ ...s, enabled: false, chainId: null, phrase: null, lastSyncAt: null }));
    this.kv(profile).set({});
    this.kv(profile).flush();
    this.remote(profile).clear();
    this.ctx.profiles.setSyncChain(id, undefined);
    this.errors.delete(id);
    return this.status(profile);
  }

  async syncNow(profile: ProfileRuntime): Promise<SyncStatus> {
    if (!this.state(profile).get().enabled) return this.status(profile);
    await (await this.active(profile)).scheduler.trigger();
    return this.status(profile);
  }

  async setOptions(profile: ProfileRuntime, opts: SyncOptions): Promise<SyncStatus> {
    const s = this.state(profile).get();
    const intervalMinutes =
      opts.intervalMinutes !== undefined && (SYNC_INTERVALS_MINUTES as readonly number[]).includes(opts.intervalMinutes)
        ? opts.intervalMinutes
        : s.intervalMinutes;
    const syncServiceUrls = opts.syncServiceUrls ?? s.syncServiceUrls;
    const syncWorkflows = opts.syncWorkflows ?? s.syncWorkflows;
    const syncSiteMemory = opts.syncSiteMemory ?? s.syncSiteMemory;
    this.state(profile).update((st) => ({ ...st, intervalMinutes, syncServiceUrls, syncWorkflows, syncSiteMemory }));
    const rt = this.runtimes.get(profile.profile.id);
    if (rt && (syncWorkflows !== s.syncWorkflows || syncSiteMemory !== s.syncSiteMemory)) {
      // The engine's collections are fixed when it is built: rebuild it. A category turned off
      // forgets what it synced (local data stays); turned on, it joins with a full merge. A cycle
      // already running finishes first, so two engines never share the state.
      rt.scheduler.stop();
      await rt.scheduler.idle();
      this.dispose(profile.profile.id);
      (await this.active(profile)).scheduler.poke();
      return this.status(profile);
    }
    if (rt && intervalMinutes !== s.intervalMinutes) rt.scheduler.setIntervalMs(intervalMinutes * 60_000);
    if (rt && syncServiceUrls !== s.syncServiceUrls) rt.scheduler.poke();
    return this.status(profile);
  }

  async devices(profile: ProfileRuntime): Promise<SyncDeviceView[]> {
    const rt = await this.active(profile);
    try {
      const [list, own] = await Promise.all([rt.client.listDevices(), rt.client.getDeviceId()]);
      return list
        .map((d) => ({ ...d, current: d.id === own }))
        .sort((a, b) => Number(b.current) - Number(a.current) || b.lastSeen - a.lastSeen);
    } catch (err) {
      throw new Error(describeError(err, this.state(profile).get().serverUrl));
    }
  }

  /** Rename THIS device on the chain. The new name reaches other devices on the next sync cycle. */
  async renameDevice(profile: ProfileRuntime, name: string): Promise<SyncDeviceView[]> {
    const trimmed = name.trim().slice(0, 64);
    if (!trimmed) throw new Error("Enter a device name");
    const rt = await this.active(profile);
    this.state(profile).update((s) => ({ ...s, deviceName: trimmed }));
    try {
      await rt.client.renameDevice(trimmed);
    } catch (err) {
      throw new Error(describeError(err, this.state(profile).get().serverUrl));
    }
    rt.scheduler.poke();
    return this.devices(profile);
  }

  /** Revoke another device and delete its open tabs and extension list from the chain. */
  async removeDevice(profile: ProfileRuntime, deviceId: string): Promise<SyncDeviceView[]> {
    const rt = await this.active(profile);
    if (deviceId === (await rt.client.getDeviceId())) throw new Error("To remove this device, turn sync off.");
    try {
      await rt.client.removeDevice(deviceId);
    } catch (err) {
      throw new Error(describeError(err, this.state(profile).get().serverUrl));
    }
    this.remote(profile).forgetDevice(deviceId);
    await rt.scheduler.trigger();
    return this.devices(profile);
  }

  revealPhrase(profile: ProfileRuntime): string {
    if (!this.state(profile).get().enabled) throw new Error("Sync is off for this profile");
    const phrase = this.phraseOf(profile);
    if (!phrase) throw new Error("The recovery phrase is not available on this device");
    return phrase;
  }

  /** Delete the chain and all its data from the server, then turn sync off here. */
  async wipe(profile: ProfileRuntime, confirmation: string): Promise<SyncStatus> {
    if (confirmation.trim() !== WIPE_CONFIRMATION) throw new Error(`Type ${WIPE_CONFIRMATION} to confirm`);
    const rt = await this.active(profile);
    try {
      await rt.client.wipeChain();
    } catch (err) {
      throw new Error(describeError(err, this.state(profile).get().serverUrl));
    }
    return this.disable(profile, false);
  }

  async remoteTabs(profile: ProfileRuntime): Promise<RemoteDeviceTabs[]> {
    const rt = this.runtimes.get(profile.profile.id);
    if (!rt || !this.state(profile).get().enabled) return [];
    const own = await rt.client.getDeviceId();
    const out: RemoteDeviceTabs[] = [];
    for (const [deviceId, raw] of Object.entries(this.remote(profile).records("open_tabs").all())) {
      const record = deviceId === own ? null : parseDeviceTabs(raw);
      if (record) out.push({ deviceId, ...record });
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async extensionSuggestions(profile: ProfileRuntime): Promise<ExtensionSuggestion[]> {
    const rt = this.runtimes.get(profile.profile.id);
    if (!rt || !this.state(profile).get().enabled) return [];
    const remote = this.remote(profile);
    const installed = profile.session.extensions.getAllExtensions().map((e) => e.id);
    return extensionSuggestions(remote.records("extensions").all(), await rt.client.getDeviceId(), installed, remote.dismissed());
  }

  /** Install a suggested extension from the Chrome Web Store. Only ever runs on an explicit click. */
  async installExtension(profile: ProfileRuntime, extensionId: string): Promise<ExtensionSuggestion[]> {
    const suggested = (await this.extensionSuggestions(profile)).some((s) => s.id === extensionId);
    if (!suggested) throw new Error("That extension is not suggested by your other devices");
    // Same path as corvus://extensions: permission prompt first, then tracked by the extension host.
    await profile.extensions.installFromStore(extensionId);
    this.runtimes.get(profile.profile.id)?.scheduler.poke();
    return this.extensionSuggestions(profile);
  }

  async dismissExtension(profile: ProfileRuntime, extensionId: string): Promise<ExtensionSuggestion[]> {
    this.remote(profile).dismiss(extensionId);
    return this.extensionSuggestions(profile);
  }
}
