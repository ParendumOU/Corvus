import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CHAIN_SERVER_ID,
  MAX_WATCH_STATUS,
  askList,
  chainServerMove,
  decodePairing,
  encodePairing,
  normalizeServerUrl,
  parseChainServer,
  phoneServerAddresses,
  sentTabs,
  type ChainServer,
  type DeviceInfo,
  type NetworkInterfaceMap,
  type SentTab,
  type SyncCollection,
  type SyncStateStorage,
} from "@corvus/shared";
import { Notification } from "electron";
import type { CorvusSyncClient, SyncAdapter, SyncEngine } from "@corvus/sync-core";
import { extensionSuggestions, webstoreExtensions, type ExtensionSuggestion, type SyncedExtension } from "../shared/extension-suggestions";
import { SYNC_INTERVALS_MINUTES, type PairingAddress, type PairingCodeView, type LocalServerView, type ServerCheck, type SyncDeviceView, type SyncEnableOptions, type SyncMode, type SyncOptions, type SyncStatus, type SyncTarget } from "../shared/ipc";
import { OpenTabsPublisher, collectTabs, parseDeviceTabs, type RemoteDeviceTabs } from "../shared/open-tabs";
import { toWatchStatus } from "../shared/page-watch";
import { StampedRecord } from "../shared/stamped-record";
import { CONFLICT_COLLECTIONS, conflictView, freshVersion, type SyncConflictView } from "../shared/sync-conflicts";
import { answerAsk, toAnswer } from "./ask-relay";
import type { AppContext } from "./context";
import { JsonFile } from "./json-file";
import { loadOptionalModule } from "./module-loader";
import { LocalSyncServer } from "./local-sync-server";
import { phonePairingAddress, probeHealth } from "./pairing-address";
import type { ProfileRuntime } from "./profiles";
import type { SecretCipher } from "./settings-store";
import { ReadingFiller } from "./reading-fill";
import { SyncRemoteStore, createSyncAdapters } from "./sync-adapters";
import { SyncConflictStore } from "./sync-conflict-store";
import { SyncScheduler } from "./sync-scheduler";
import { ownChainServer, reviveSyncState, type ProfileSyncState } from "./sync-state";
import { tr } from "./menu-i18n";

type SyncCoreModule = typeof import("@corvus/sync-core");


/** Everything that runs while sync is on for one loaded profile. */
interface Runtime {
  profile: ProfileRuntime;
  client: CorvusSyncClient;
  scheduler: SyncScheduler;
  tabs: OpenTabsPublisher;
  /** The engine's adapters (bringing a lost local version back writes through them). */
  adapters: Partial<Record<SyncCollection, SyncAdapter>>;
  /** Last observed state of things without a change event (see localChanged). */
  seen: { extensionIds: string; meta: string };
  dispose: Array<() => void>;
}

const DEFAULT_INTERVAL_MINUTES = 5;
const CHANGE_DEBOUNCE_MS = 10_000;
const CHANGE_MAX_WAIT_MS = 60_000;
/** How often to look for pages sent to this device between full syncs (one cheap request). */
const INBOX_POLL_MS = 30_000;
/** How often to look for questions from the phone: someone is waiting for the answer. */
const ASKS_POLL_MS = 2_000;
/** How often open tabs, installed extensions and profile metadata are checked for changes. */
const WATCH_INTERVAL_MS = 3_000;
const WIPE_CONFIRMATION = "DELETE";
/** How long the built-in server keeps answering after the chain moved away (devices follow meanwhile). */
const RETIRE_LOCAL_MS = 14 * 24 * 60 * 60_000;
/** How long "Check" and a move wait for an own server to answer. */
const SERVER_CHECK_TIMEOUT_MS = 6000;

/** The phone (or computer) cannot reach the server: down, wrong address, or not on this network. */
function unreachable(err: unknown): boolean {
  return err instanceof TypeError && /fetch failed/i.test(err.message);
}

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
  if (unreachable(err)) return tr("Cannot reach the sync server at {url}.", { url: serverUrl });
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

/** Between full syncs, asks the server for new records of `collection` and runs a sync when there are some. */
function pollInbox(client: CorvusSyncClient, collection: SyncCollection, everyMs: number, sync: () => void): () => void {
  let busy = false;
  const timer = setInterval(() => {
    if (busy) return;
    busy = true;
    client
      .hasNew(collection)
      .then((fresh) => {
        if (fresh) sync();
      })
      .catch(() => undefined)
      .finally(() => {
        busy = false;
      });
  }, everyMs);
  timer.unref();
  return () => clearInterval(timer);
}

/**
 * Per-profile, end-to-end encrypted sync through @corvus/sync-core's SyncEngine: bookmarks, history,
 * allowlisted settings, profile name/avatar, open tabs and installed extensions, reading list,
 * watches, workspaces, annotations, pages sent from other devices, and (unless turned off on this
 * device) workflows and site memory (see sync-adapters.ts).
 * A sync chain belongs to exactly one profile. Crypto and the wire protocol live in sync-core.
 */
export class SyncService {
  private readonly states = new Map<string, JsonFile<ProfileSyncState>>();
  private readonly kvFiles = new Map<string, JsonFile<Record<string, string>>>();
  private readonly remotes = new Map<string, SyncRemoteStore>();
  private readonly runtimes = new Map<string, Runtime>();
  private readonly conflictStores = new Map<string, SyncConflictStore>();
  private readonly errors = new Map<string, string>();
  private readonly filler = new ReadingFiller();
  private readonly memoryPhrases = new Map<string, string>();
  /** Questions from the phone being answered now (record ids). */
  private readonly answering = new Set<string>();
  /** The chain's devices as of the last sync, per profile (for "Send to your phone" without waiting). */
  private readonly chainDevices = new Map<string, DeviceInfo[]>();
  private watcher: ReturnType<typeof setInterval> | null = null;
  /** The built-in sync servers ("This computer"), per profile. */
  private readonly localServers = new Map<string, LocalSyncServer>();
  /** A note about the last move of the chain, per profile (shown in Settings > Sync). */
  private readonly notices = new Map<string, string>();
  /** Profiles following their chain to another server right now. */
  private readonly following = new Set<string>();

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
    for (const server of this.localServers.values()) void server.stop();
  }

  private async watch(): Promise<void> {
    const mod = await this.module();
    if (!mod) return;
    const alive = new Set(this.ctx.profiles.list().map((p) => p.id));
    for (const id of [...this.runtimes.keys()]) if (!alive.has(id)) this.dispose(id);
    for (const profile of this.ctx.profiles.loaded()) {
      const id = profile.profile.id;
      if (!alive.has(id)) continue;
      try {
        await this.keepLocalServer(profile);
      } catch (err) {
        this.errors.set(id, tr("The sync server on this computer could not start: {error}", { error: (err as Error).message }));
        continue;
      }
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
        mode: "local",
        serverUrl: this.defaultServerUrl,
        customServerUrl: this.defaultServerUrl,
        localPort: null,
        retireLocalUntil: null,
        deviceName: os.hostname(),
        chainId: null,
        phrase: null,
        lastSyncAt: null,
        intervalMinutes: DEFAULT_INTERVAL_MINUTES,
        syncServiceUrls: false,
        syncWorkflows: true,
        syncSiteMemory: true,
        syncCommandHistory: true,
        syncAssistHistory: true,
      });
      file = JsonFile.load<ProfileSyncState>(
        path.join(profile.dataDir, "sync.json"),
        defaults,
        (raw) => reviveSyncState(raw, defaults()),
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
      tabs: collectTabs(this.ctx.windows.forProfile(id).filter((w) => !w.isPrivate).map((w) => ({ tabs: w.listTabs(), groups: w.listGroups() }))),
    }));
    tabs.refresh();

    const seen = { extensionIds: extensionIdsKey(profile), meta: metaKey(profile) };
    // Workflows and site memory are categories the user can leave out on this device.
    const flows = file.get().syncWorkflows ? this.ctx.flows?.storeFor(profile) : undefined;
    const memory = file.get().syncSiteMemory ? this.ctx.flows?.memory.storeFor(profile) : undefined;
    const commands = file.get().syncCommandHistory ? profile.commands : undefined;
    const assistHistory = file.get().syncAssistHistory ? profile.assistHistory : undefined;
    const published = { key: "", extensions: [] as SyncedExtension[] };
    const watchStatus = new StampedRecord(() => ({
      device: file.get().deviceName,
      platform: process.platform,
      watches: this.ctx.monitor.storeFor(profile).list().slice(0, MAX_WATCH_STATUS).map(toWatchStatus),
    }));
    const adapters = createSyncAdapters({
      bookmarks: profile.bookmarks,
      history: profile.history,
      credentials: profile.credentials,
      reading: profile.reading,
      watches: this.ctx.monitor.storeFor(profile),
      workspaces: profile.workspaces,
      annotations: profile.annotations,
      ...(flows ? { workflows: flows } : {}),
      ...(memory ? { siteMemory: memory } : {}),
      ...(commands ? { commands } : {}),
      ...(assistHistory ? { assistHistory } : {}),
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
      watchStatus: () => watchStatus.record(),
      chainServer: async () => {
        if (file.get().mode !== "local") return null;
        const stored = remote.records("chain_server").all()[CHAIN_SERVER_ID];
        return ownChainServer(this.lanUrls(file.get().serverUrl), stored, await client.getDeviceId(), Date.now());
      },
      extensions: () => {
        const key = extensionIdsKey(profile);
        if (key !== published.key) {
          published.key = key;
          published.extensions = webstoreExtensions(profile.extensions.list());
        }
        return { device: file.get().deviceName, extensions: published.extensions };
      },
    });
    const conflicts = this.conflictStore(profile);
    const engine = new mod.SyncEngine({
      client,
      storage,
      adapters,
      // A local change another device's newer change replaced is kept for Settings > Sync.
      conflictCollections: CONFLICT_COLLECTIONS,
      onConflict: (conflict) => conflicts.add(conflict),
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
      adapters,
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
        ...(commands ? [commands.onChange(() => scheduler.poke())] : []),
        ...(assistHistory ? [assistHistory.onChange(() => scheduler.poke())] : []),
        pollInbox(client, "sent_tabs", INBOX_POLL_MS, () => scheduler.poke()),
        pollInbox(client, "asks", ASKS_POLL_MS, () => void scheduler.trigger().catch(() => undefined)),
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
      profile.commands.flush();
      profile.assistHistory.flush();
      await engine.sync();
      file.update((s) => ({ ...s, lastSyncAt: Date.now() }));
      this.errors.delete(id);
      void this.followChain(profile);
      // Opened pages leave the replica; the next cycle deletes them on the chain.
      if ((await this.openSentTabs(profile)) > 0) this.runtimes.get(id)?.scheduler.poke();
      this.answerAsks(profile);
      void this.runtimes
        .get(id)
        ?.client.listDevices()
        .then((list) => this.chainDevices.set(id, list))
        .catch(() => undefined);
      // Links saved from the phone get their article here (a filled item syncs on the next cycle).
      void this.filler.run(profile.reading);
    } catch (err) {
      // The built-in server lost the chain (its data was deleted): this computer has everything, so it starts it again there.
      if ((err as { code?: unknown }).code === "chain_not_found" && file.get().mode === "local") {
        void this.rebuildLocal(profile);
        return;
      }
      this.errors.set(id, describeError(err, file.get().serverUrl));
    } finally {
      this.kvFiles.get(id)?.flush();
    }
  }

  /**
   * Opens the pages other devices sent to this one as background tabs in a window of the profile,
   * then drops their records. Pages wait while the profile has no window. Returns how many opened.
   */
  private async openSentTabs(profile: ProfileRuntime): Promise<number> {
    const rt = this.runtimes.get(profile.profile.id);
    if (!rt) return 0;
    const own = await rt.client.getDeviceId();
    const records = this.remote(profile).records("sent_tabs");
    const pages = sentTabs(records.all(), (t) => t.to === own);
    const windows = this.ctx.windows.forProfile(profile.profile.id).filter((w) => !w.isPrivate);
    const focused = this.ctx.windows.focused();
    const win = windows.find((w) => w === focused) ?? windows[0];
    if (pages.length === 0 || !win) return 0;
    for (const page of pages) {
      win.createTab(page.url, { activate: false });
      records.delete(page.id);
    }
    if (Notification.isSupported()) {
      const senders = [...new Set(pages.map((p) => p.from || "another device"))].join(", ");
      const n = new Notification({
        title: pages.length === 1 ? tr("A page from {senders}", { senders }) : tr("{count} pages from {senders}", { count: pages.length, senders }),
        body: pages.map((p) => p.title || p.url).join("\n").slice(0, 200),
      });
      n.on("click", () => win.win.focus());
      n.show();
    }
    return pages.length;
  }

  /**
   * Answers the questions the phone sent to this computer with its AI search (ask-relay.ts):
   * new ones, and ones a computer started but stopped answering (Corvus quit meanwhile). Each answer
   * streams onto the chain as it comes; the phone deleting a question stops it (also when the person
   * stops the answer: the phone then writes the answer so far as a new "done" record, never answered).
   */
  private answerAsks(profile: ProfileRuntime): void {
    const rt = this.runtimes.get(profile.profile.id);
    if (!rt || !this.ctx.settings.get().phone.answerQuestions) return;
    void (async () => {
      const own = await rt.client.getDeviceId();
      const records = this.remote(profile).records("asks");
      const now = Date.now();
      const pending = askList(records.all(), (a) => toAnswer(a, own, now));
      for (const { id, ...ask } of pending) {
        if (this.answering.has(id)) continue;
        this.answering.add(id);
        void answerAsk(ask, {
          stream: (question, signal, context) => this.ctx.search.stream(question, { depth: "quick", signal, ...(context.length ? { context } : {}) }),
          push: async (next) => {
            const { conflicts } = await rt.client.push([{ collection: "asks", id, payload: next, deleted: false }]);
            if (conflicts.some((c) => c.collection === "asks" && c.id === id && c.deleted)) {
              records.delete(id);
              return false;
            }
            records.set(id, next);
            return true;
          },
          deviceName: this.state(profile).get().deviceName,
          now: Date.now,
        })
          .catch(() => undefined)
          .finally(() => this.answering.delete(id));
      }
    })().catch(() => undefined);
  }

  private async active(profile: ProfileRuntime): Promise<Runtime> {
    const mod = await this.module();
    if (!mod) throw new Error("Sync is not available in this build");
    if (!this.state(profile).get().enabled) throw new Error("Sync is off for this profile");
    return this.runtime(profile, mod);
  }

  private localDir(profile: ProfileRuntime): string {
    return path.join(profile.dataDir, "sync-server");
  }

  /** This computer's network adapters. The smoke test replaces them to show Settings with a fixed layout. */
  networkInterfaces: () => NetworkInterfaceMap = () => os.networkInterfaces();

  /** The addresses other devices reach a server on this computer at (network, then Tailscale). */
  private lanUrls(serverUrl: string): string[] {
    return (phoneServerAddresses(serverUrl, this.networkInterfaces()) ?? []).map((a) => a.url);
  }

  /**
   * Starts this profile's built-in sync server if needed and returns its loopback address. The port
   * used last time is tried first, so paired devices keep their address.
   */
  private async startLocal(profile: ProfileRuntime): Promise<string> {
    const id = profile.profile.id;
    let server = this.localServers.get(id);
    if (!server) {
      server = new LocalSyncServer(path.join(this.localDir(profile), "sync.db"));
      this.localServers.set(id, server);
    }
    const port = await server.start(this.state(profile).get().localPort);
    const url = `http://127.0.0.1:${port}`;
    const s = this.state(profile).get();
    if (s.localPort !== port) this.state(profile).update((st) => ({ ...st, localPort: port }));
    if (s.mode === "local" && s.serverUrl !== url) {
      this.state(profile).update((st) => ({ ...st, serverUrl: url }));
      // The client was made for the old address.
      this.dispose(id);
    }
    return url;
  }

  /**
   * The built-in server runs while the profile syncs through it, and for a while after its chain
   * moved away (devices read there where it went); then it stops and its copy of the chain is deleted.
   */
  private async keepLocalServer(profile: ProfileRuntime): Promise<void> {
    const id = profile.profile.id;
    const s = this.state(profile).get();
    const retiring = s.retireLocalUntil !== null && Date.now() < s.retireLocalUntil;
    if ((s.enabled && s.mode === "local") || retiring) {
      await this.startLocal(profile);
      return;
    }
    const server = this.localServers.get(id);
    if (server) {
      this.localServers.delete(id);
      await server.stop();
    }
    if (s.retireLocalUntil !== null) {
      this.state(profile).update((st) => ({ ...st, retireLocalUntil: null }));
      fs.rmSync(this.localDir(profile), { recursive: true, force: true });
    }
  }

  /**
   * Moves this profile's chain to another server: joins it there with this device's id, writes there
   * where the chain is (chain_server), then starts over on it, uploading everything this computer
   * has (end-to-end encrypted as always). With `announce`, the chain on the old server first gets
   * the new address too, so the devices that sync there follow. Returns whether they were told.
   */
  private async switchServer(profile: ProfileRuntime, target: SyncTarget, announce: boolean): Promise<boolean> {
    const mod = await this.module();
    if (!mod) throw new Error("Sync is not available in this build");
    const id = profile.profile.id;
    const phrase = this.phraseOf(profile);
    if (!phrase) throw new Error("The recovery phrase is not available on this device");
    const before = this.state(profile).get();
    const serverUrl = target.mode === "local" ? await this.startLocal(profile) : normalizeServerUrl(target.serverUrl);
    if (!serverUrl) throw new Error(tr("Enter a valid sync server address, starting with https:// or http://."));
    const kv = this.kv(profile);
    const keep = Object.fromEntries(Object.entries(kv.get()).filter(([key]) => key.endsWith("/deviceId")));
    const memory = new Map(Object.entries(keep));
    const next = mod.createSyncClient({
      serverUrl,
      phrase,
      deviceName: before.deviceName,
      platform: process.platform,
      storage: {
        get: async (key) => memory.get(key),
        set: async (key, value) => {
          memory.set(key, value);
        },
      },
    });
    const own = await next.getDeviceId();
    const record: ChainServer = { urls: target.mode === "local" ? this.lanUrls(serverUrl) : [serverUrl], at: Date.now(), from: own };
    try {
      await next.register();
      if (target.mode === "local") {
        // A clean start: an older copy of the chain here would bring back what was deleted since.
        await next.wipeChain();
        await next.register();
      }
      await next.pullCollection("chain_server", () => undefined);
      if (record.urls.length > 0) await next.push([{ collection: "chain_server", id: CHAIN_SERVER_ID, payload: record, deleted: false }]);
    } catch (err) {
      throw new Error(describeError(err, serverUrl));
    }
    let told = !announce;
    const rt = this.runtimes.get(id) ?? (announce ? await this.active(profile).catch(() => undefined) : undefined);
    if (rt) {
      rt.scheduler.stop();
      await rt.scheduler.idle();
      if (announce && record.urls.length > 0) {
        try {
          await rt.client.push([{ collection: "chain_server", id: CHAIN_SERVER_ID, payload: record, deleted: false }]);
          told = !rt.client.unsupported().has("chain_server");
        } catch (err) {
          console.warn("[corvus] could not tell the old sync server where the chain went:", (err as Error).message);
        }
      }
    }
    this.dispose(id);
    const leavingLocal = before.mode === "local" && target.mode === "custom";
    this.state(profile).update((s) => ({
      ...s,
      mode: target.mode,
      serverUrl,
      lastSyncAt: null,
      ...(target.mode === "custom" ? { customServerUrl: serverUrl } : {}),
      retireLocalUntil: target.mode === "local" ? null : leavingLocal ? Date.now() + RETIRE_LOCAL_MS : s.retireLocalUntil,
    }));
    kv.set({ ...keep });
    this.remote(profile).clear();
    this.remote(profile).records("chain_server").set(CHAIN_SERVER_ID, record);
    this.errors.delete(id);
    await (await this.active(profile)).scheduler.trigger();
    return told;
  }

  /** Settings > Sync: move the chain to this computer or to the person's own server, both ways. */
  async moveChain(profile: ProfileRuntime, target: SyncTarget): Promise<SyncStatus> {
    const id = profile.profile.id;
    const s = this.state(profile).get();
    if (!s.enabled) throw new Error(tr("Turn sync on first."));
    if (target.mode === "local" && s.mode === "local") throw new Error(tr("Your sync chain is already on this computer."));
    if (target.mode === "custom") {
      const check = await this.checkServer(target.serverUrl);
      if (!check.ok || !check.serverUrl) throw new Error(check.message);
      if (s.mode === "custom" && check.serverUrl === s.serverUrl) throw new Error(tr("Your sync chain is already on that server."));
      target = { mode: "custom", serverUrl: check.serverUrl };
    }
    this.notices.delete(id);
    const told = await this.switchServer(profile, target, true);
    this.notices.set(
      id,
      told
        ? tr("Moved. Your other devices follow the next time they sync with the old server.")
        : tr("Moved. The old server could not be told where the chain went: pair your other devices again."),
    );
    return this.status(profile);
  }

  /** A device of the chain moved it elsewhere: follow it (devices on "Your own server" only). */
  private async followChain(profile: ProfileRuntime): Promise<void> {
    const id = profile.profile.id;
    const s = this.state(profile).get();
    const rt = this.runtimes.get(id);
    if (!rt || !s.enabled || s.mode !== "custom" || this.following.has(id)) return;
    const urls = chainServerMove(this.remote(profile).records("chain_server").all()[CHAIN_SERVER_ID], s.serverUrl, await rt.client.getDeviceId());
    if (!urls) return;
    this.following.add(id);
    try {
      for (const url of urls) {
        if (!(await probeHealth(url, SERVER_CHECK_TIMEOUT_MS))) continue;
        await this.switchServer(profile, { mode: "custom", serverUrl: url }, false);
        this.notices.set(id, tr("Your sync chain moved to {url}. This device followed it.", { url }));
        return;
      }
      this.notices.set(id, tr("Your sync chain moved to {url}, which this computer cannot reach right now.", { url: urls[0]! }));
    } catch (err) {
      this.errors.set(id, (err as Error).message);
    } finally {
      this.following.delete(id);
    }
  }

  /** The built-in server lost the chain: start it again there from what this computer has. */
  private async rebuildLocal(profile: ProfileRuntime): Promise<void> {
    const id = profile.profile.id;
    if (this.following.has(id)) return;
    this.following.add(id);
    try {
      await this.switchServer(profile, { mode: "local" }, false);
      this.notices.set(id, tr("The sync data on this computer was missing, so it was uploaded again. Pair your phone again if it stopped syncing."));
    } catch (err) {
      this.errors.set(id, (err as Error).message);
    } finally {
      this.following.delete(id);
    }
  }

  /** "Check" next to an own server's address: whether a Corvus sync server answers there. */
  async checkServer(raw: string): Promise<ServerCheck> {
    const serverUrl = normalizeServerUrl(raw);
    if (!serverUrl) return { ok: false, serverUrl: null, message: tr("Enter a valid sync server address, starting with https:// or http://.") };
    if (await probeHealth(serverUrl, SERVER_CHECK_TIMEOUT_MS)) return { ok: true, serverUrl, message: tr("The sync server answers.") };
    return { ok: false, serverUrl, message: tr("No sync server answers at {url}. Check the address and that the server is running.", { url: serverUrl }) };
  }

  private localView(profile: ProfileRuntime): LocalServerView | null {
    const s = this.state(profile).get();
    const server = this.localServers.get(profile.profile.id);
    const retiring = s.retireLocalUntil !== null && Date.now() < s.retireLocalUntil;
    if (!server && !(s.enabled && s.mode === "local") && !retiring) return null;
    const st = server?.status ?? { running: false, port: null, error: null, lastClient: null };
    return {
      ...st,
      addresses: st.port !== null ? (phoneServerAddresses(`http://127.0.0.1:${st.port}`, this.networkInterfaces()) ?? []) : [],
      retiringUntil: retiring ? s.retireLocalUntil : null,
    };
  }

  async status(profile: ProfileRuntime): Promise<SyncStatus> {
    const mod = await this.module();
    const s = this.state(profile).get();
    const rt = this.runtimes.get(profile.profile.id);
    return {
      available: mod !== null,
      enabled: s.enabled,
      mode: s.mode,
      customServerUrl: s.customServerUrl,
      localServer: this.localView(profile),
      platform: process.platform,
      notice: this.notices.get(profile.profile.id) ?? null,
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
      syncCommandHistory: s.syncCommandHistory,
      syncAssistHistory: s.syncAssistHistory,
      conflicts: this.conflictStore(profile).list().length,
    };
  }

  private conflictStore(profile: ProfileRuntime): SyncConflictStore {
    let store = this.conflictStores.get(profile.profile.id);
    if (!store) {
      store = new SyncConflictStore(path.join(profile.dataDir, "sync-conflicts.json"));
      this.conflictStores.set(profile.profile.id, store);
    }
    return store;
  }

  /** This device's changes that a newer change from another device replaced, newest first. */
  conflicts(profile: ProfileRuntime): SyncConflictView[] {
    return this.conflictStore(profile).list().map(conflictView);
  }

  /**
   * "mine" brings this device's version back: it is written locally and syncs as a new change, so it
   * wins everywhere. "theirs" keeps the version in use. Either way the conflict is gone.
   */
  async resolveConflict(profile: ProfileRuntime, id: string, keep: "mine" | "theirs"): Promise<SyncConflictView[]> {
    const store = this.conflictStore(profile);
    const conflict = store.list().find((c) => c.id === id);
    if (!conflict) return this.conflicts(profile);
    if (keep === "mine") {
      const rt = this.state(profile).get().enabled ? await this.active(profile) : undefined;
      const adapter = rt?.adapters[conflict.collection];
      if (!rt || !adapter) throw new Error(tr("Turn sync on to bring this version back."));
      const payload = freshVersion(conflict.local, Date.now());
      await adapter.apply([{ collection: conflict.collection, id: conflict.recordId, payload, deleted: conflict.local === null }]);
      rt.scheduler.poke();
    }
    store.take(id);
    return this.conflicts(profile);
  }

  async generatePhrase(): Promise<string> {
    const mod = await this.module();
    if (!mod) throw new Error("Sync is not available in this build");
    return mod.generateRecoveryPhrase();
  }

  /**
   * Turns sync on: a new chain or one to join (its recovery phrase), on this computer's built-in
   * server ("local") or the person's own. A pairing code from another computer joins the chain
   * where that computer has it.
   */
  async enable(profile: ProfileRuntime, opts: SyncEnableOptions): Promise<SyncStatus> {
    const mod = await this.module();
    if (!mod) throw new Error("Sync is not available in this build");
    const id = profile.profile.id;
    const code = decodePairing(opts.phrase);
    const mode: SyncMode = code ? "custom" : (opts.mode ?? (opts.serverUrl ? "custom" : "local"));
    const phrase = mod.normalizeRecoveryPhrase(code ? code.phrase : opts.phrase);
    if (!mod.validateRecoveryPhrase(phrase)) throw new Error(tr("That recovery phrase is not valid"));
    const customUrl = mode === "custom" ? normalizeServerUrl(code?.serverUrl ?? opts.serverUrl ?? "") : null;
    if (mode === "custom" && !customUrl) throw new Error(tr("Enter a valid sync server address, starting with https:// or http://."));
    const chainId = mod.deriveKeys(phrase).chainId;
    const clash = this.ctx.profiles.list().find((p) => p.id !== id && p.syncChainId === chainId);
    if (clash) throw new Error(`This recovery phrase already syncs the profile “${clash.name}” on this device. A sync chain belongs to one profile.`);
    let serverUrl: string;
    try {
      serverUrl = customUrl ?? (await this.startLocal(profile));
    } catch (err) {
      throw new Error(tr("The sync server on this computer could not start: {error}", { error: (err as Error).message }));
    }

    this.dispose(id);
    const encrypted = this.cipher.isEncryptionAvailable();
    if (encrypted) this.memoryPhrases.delete(id);
    else this.memoryPhrases.set(id, phrase);
    this.state(profile).update((s) => ({
      ...s,
      enabled: false,
      chainId: null,
      lastSyncAt: null,
      mode,
      serverUrl,
      ...(customUrl ? { customServerUrl: customUrl } : { retireLocalUntil: null }),
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
          { collection: "watch_status", id: own, payload: null, deleted: true },
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
    this.conflictStore(profile).clear();
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
    const syncCommandHistory = opts.syncCommandHistory ?? s.syncCommandHistory;
    const syncAssistHistory = opts.syncAssistHistory ?? s.syncAssistHistory;
    this.state(profile).update((st) => ({ ...st, intervalMinutes, syncServiceUrls, syncWorkflows, syncSiteMemory, syncCommandHistory, syncAssistHistory }));
    const rt = this.runtimes.get(profile.profile.id);
    if (
      rt &&
      (syncWorkflows !== s.syncWorkflows || syncSiteMemory !== s.syncSiteMemory || syncCommandHistory !== s.syncCommandHistory || syncAssistHistory !== s.syncAssistHistory)
    ) {
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
      this.chainDevices.set(profile.profile.id, list);
      return list
        .map((d) => ({ ...d, current: d.id === own }))
        .sort((a, b) => Number(b.current) - Number(a.current) || b.lastSeen - a.lastSeen);
    } catch (err) {
      throw new Error(describeError(err, this.state(profile).get().serverUrl));
    }
  }

  /** The phones on this profile's sync chain, as of the last sync (none while sync is off). */
  phones(profile: ProfileRuntime): Array<{ id: string; name: string }> {
    if (!this.state(profile).get().enabled) return [];
    return (this.chainDevices.get(profile.profile.id) ?? [])
      .filter((d) => d.platform === "android" || d.platform === "ios")
      .sort((a, b) => b.lastSeen - a.lastSeen)
      .map((d) => ({ id: d.id, name: d.name }));
  }

  /** Sends a page to another device of the chain (a phone shows it and notifies). */
  async sendTab(profile: ProfileRuntime, to: string, url: string, title: string): Promise<void> {
    const rt = await this.active(profile);
    const payload: SentTab = { url, title: title.slice(0, 300), to, fromId: await rt.client.getDeviceId(), from: this.state(profile).get().deviceName, sentAt: Date.now() };
    const id = crypto.randomUUID();
    try {
      await rt.client.push([{ collection: "sent_tabs", id, payload, deleted: false }]);
    } catch (err) {
      throw new Error(describeError(err, this.state(profile).get().serverUrl));
    }
    if (rt.client.unsupported().has("sent_tabs")) throw new Error("Your sync server does not support sending pages yet: update it to the latest Corvus sync server.");
    this.remote(profile).records("sent_tabs").set(id, payload);
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

  /**
   * Where pairing codes point the phone (see phonePairingAddress). The smoke test replaces it to
   * show "Pair a phone" with a fixed network layout.
   */
  pairingAddress: (desktopServerUrl: string, prefer?: string) => Promise<PairingAddress> = (url, prefer) => phonePairingAddress(url, { prefer });

  /**
   * "Pair a phone": the pairing code (server address + recovery phrase) as text and as a QR code
   * for the Corvus mobile app. A sync server on this computer's loopback address goes in the code
   * as this computer's network address (`address`: another of its addresses), checked to answer
   * there; the profile's own server setting does not change.
   */
  async pairingCode(profile: ProfileRuntime, address?: string): Promise<PairingCodeView> {
    const phrase = this.revealPhrase(profile);
    const target = await this.pairingAddress(this.state(profile).get().serverUrl, address);
    const code = encodePairing({ serverUrl: target.serverUrl, phrase });
    const { encodeQR } = await import("qr");
    return { ...target, code, qrSvg: encodeQR(code, "svg", { border: 2 }) };
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
