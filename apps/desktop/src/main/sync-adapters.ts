/**
 * Bridges each local store to @corvus/sync-core's SyncEngine. Electron-free so the whole set can be
 * exercised end to end against a real sync server in tests.
 */
import {
  SENT_TAB_ID_RE,
  isSyncedBookmark,
  parseDeviceWatchStatus,
  parseSentTab,
  type Bookmark,
  type DeviceWatchStatus,
  type SyncCollection,
} from "@corvus/shared";
import type { LocalItem, SyncAdapter } from "@corvus/sync-core";
import { isAnnotation, type Annotation } from "../shared/annotations";
import { ROOT_IDS } from "../shared/bookmark-tree";
import { isValidCredential, type Credential } from "../shared/credentials";
import { parseDeviceExtensions, type DeviceExtensions } from "../shared/extension-suggestions";
import { parseSyncedHistory, toSyncedHistory, type SyncedHistoryEntry } from "../shared/history-ops";
import { isSyncedWatch, type SyncedWatch } from "../shared/page-watch";
import { isReadingItem, type ReadingItem } from "../shared/reading";
import { parseDeviceTabs, type DeviceTabs } from "../shared/open-tabs";
import type { Settings, SettingsPatch } from "../shared/settings";
import type { Workspace } from "../shared/workspaces";
import { WIPE_RECORD_ID, parseSiteMemoryWipe, parseSyncedSiteMemory, type SiteMemoryWipe, type SyncedSiteMemory } from "../shared/site-memory-sync";
import { parseSyncedWorkflow, type SyncedWorkflow } from "../shared/workflow-sync";
import { readSetting, settingsPatch, syncedSettingKeys, type SyncedSettingKey } from "../shared/sync-settings";
import { JsonFile } from "./json-file";
import type { BookmarkStore, HistoryStore } from "./stores";

export interface SettingsAccess {
  get(): Settings;
  update(patch: SettingsPatch): void;
}

export interface ProfileMeta {
  name: string;
  avatar?: string;
}

export interface ProfileAccess {
  get(): ProfileMeta;
  set(meta: ProfileMeta): void;
}

/** The single record of the `profiles` collection: a chain belongs to exactly one profile. */
export const PROFILE_RECORD_ID = "profile";

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export function bookmarksAdapter(store: BookmarkStore): SyncAdapter<Bookmark> {
  return {
    // The two root folders exist on every device and never change, so they are not synced.
    list: () => store.list().filter((b) => !ROOT_IDS.has(b.id)).map((b) => ({ id: b.id, payload: b })),
    apply: (items) => {
      const changes: Array<{ id: string; node: Bookmark | null }> = [];
      for (const item of items) {
        if (item.deleted) changes.push({ id: item.id, node: null });
        else if (isSyncedBookmark(item.payload)) changes.push({ id: item.id, node: item.payload });
      }
      store.applyRemote(changes);
    },
  };
}

/** History records are keyed by URL, so visits to the same page on two devices merge into one. */
export function historyAdapter(store: HistoryStore): SyncAdapter<SyncedHistoryEntry> {
  return {
    list: () => store.all().map((e) => ({ id: e.url, payload: toSyncedHistory(e) })),
    apply: (items) => {
      const changes: Array<{ url: string; entry: SyncedHistoryEntry | null }> = [];
      for (const item of items) {
        if (item.deleted) {
          changes.push({ url: item.id, entry: null });
          continue;
        }
        const entry = parseSyncedHistory(item.payload);
        if (entry) changes.push({ url: entry.url, entry });
      }
      store.applyRemote(changes);
    },
  };
}

export interface CredentialStore {
  all(): Credential[];
  applyRemote(changes: Array<{ id: string; cred: Credential | null }>): void;
}

/** Logins are keyed by their stable id; the full record (including the password) is the synced payload. */
export function credentialsAdapter(store: CredentialStore): SyncAdapter<Credential> {
  return {
    list: () => store.all().map((c) => ({ id: c.id, payload: c })),
    apply: (items) => {
      const changes: Array<{ id: string; cred: Credential | null }> = [];
      for (const item of items) {
        if (item.deleted) changes.push({ id: item.id, cred: null });
        else if (isValidCredential(item.payload)) changes.push({ id: item.id, cred: { ...item.payload, id: item.id } });
      }
      store.applyRemote(changes);
    },
  };
}

export interface ReadingSyncStore {
  allItems(): ReadingItem[];
  applyRemote(changes: Array<{ url: string; item: ReadingItem | null }>): void;
}

/** Saved reader-mode articles, keyed by URL across devices (the store dedupes saves by URL). */
export function readingAdapter(store: ReadingSyncStore): SyncAdapter<ReadingItem> {
  return {
    list: () => store.allItems().map((item) => ({ id: item.url, payload: item })),
    apply: (items) => {
      const changes: Array<{ url: string; item: ReadingItem | null }> = [];
      for (const item of items) {
        if (item.deleted) changes.push({ url: item.id, item: null });
        else if (isReadingItem(item.payload)) changes.push({ url: item.id, item: { ...item.payload, url: item.id } });
      }
      store.applyRemote(changes);
    },
  };
}

export interface WatchSyncStore {
  syncList(): SyncedWatch[];
  applyRemote(changes: Array<{ url: string; def: SyncedWatch | null }>): void;
}

/** Watched pages, keyed by URL. Only the user's intent syncs; monitoring state stays per device. */
export function watchesAdapter(store: WatchSyncStore): SyncAdapter<SyncedWatch> {
  return {
    list: () => store.syncList().map((w) => ({ id: w.url, payload: w })),
    apply: (items) => {
      const changes: Array<{ url: string; def: SyncedWatch | null }> = [];
      for (const item of items) {
        if (item.deleted) changes.push({ url: item.id, def: null });
        else if (isSyncedWatch(item.payload)) changes.push({ url: item.id, def: { ...item.payload, url: item.id } });
      }
      store.applyRemote(changes);
    },
  };
}

export interface WorkspaceSyncStore {
  list(): Workspace[];
  applyRemote(changes: Array<{ id: string; workspace: Workspace | null }>): void;
}

function looksLikeWorkspace(v: unknown): v is Workspace {
  return isObject(v) && typeof v.id === "string" && typeof v.name === "string" && Array.isArray(v.tabs);
}

/** Named workspaces, keyed by their stable id. The store fully validates upserts on apply. */
export function workspacesAdapter(store: WorkspaceSyncStore): SyncAdapter<Workspace> {
  return {
    list: () => store.list().map((w) => ({ id: w.id, payload: w })),
    apply: (items) => {
      const changes: Array<{ id: string; workspace: Workspace | null }> = [];
      for (const item of items) {
        if (item.deleted) changes.push({ id: item.id, workspace: null });
        else if (looksLikeWorkspace(item.payload)) changes.push({ id: item.id, workspace: { ...item.payload, id: item.id } });
      }
      store.applyRemote(changes);
    },
  };
}

export interface AnnotationSyncStore {
  all(): Annotation[];
  applyRemote(changes: Array<{ id: string; annotation: Annotation | null }>): void;
}

/** Page annotations, keyed by their stable id (distinct across devices, like workspaces). */
export function annotationsAdapter(store: AnnotationSyncStore): SyncAdapter<Annotation> {
  return {
    list: () => store.all().map((a) => ({ id: a.id, payload: a })),
    apply: (items) => {
      const changes: Array<{ id: string; annotation: Annotation | null }> = [];
      for (const item of items) {
        if (item.deleted) changes.push({ id: item.id, annotation: null });
        else if (isAnnotation(item.payload)) changes.push({ id: item.id, annotation: { ...item.payload, id: item.id } });
      }
      store.applyRemote(changes);
    },
  };
}

export interface WorkflowSyncStore {
  syncList(): SyncedWorkflow[];
  applyRemote(changes: ReadonlyArray<{ id: string; record: SyncedWorkflow | null }>): void;
  resetSyncMarkers(): void;
}

/**
 * Saved workflows, keyed by their stable id. Records merge (last writer wins by updatedAt, usage
 * per device) instead of replacing; deletions travel as dated records (shared/workflow-sync.ts).
 */
export function workflowsAdapter(store: WorkflowSyncStore): SyncAdapter<SyncedWorkflow> {
  return {
    list: () => store.syncList().map((w) => ({ id: w.id, payload: w })),
    apply: (items) => {
      const changes: Array<{ id: string; record: SyncedWorkflow | null }> = [];
      for (const item of items) {
        if (item.deleted) changes.push({ id: item.id, record: null });
        else {
          const record = parseSyncedWorkflow(item.payload, item.id);
          if (record) changes.push({ id: item.id, record });
        }
      }
      store.applyRemote(changes);
    },
    join: () => store.resetSyncMarkers(),
  };
}

export interface SiteMemorySyncStore {
  syncList(): Array<{ id: string; payload: SyncedSiteMemory | SiteMemoryWipe }>;
  applyRemote(changes: ReadonlyArray<{ id: string; record: SyncedSiteMemory | SiteMemoryWipe | null }>): void;
  resetSyncMarkers(): void;
}

/**
 * Site memory, one record per host plus the "Forget everything" marker. Records merge (see
 * shared/site-memory-sync.ts). A host this device evicts under its 200-host cap is only dropped
 * here (`retain`): eviction is never pushed as a deletion.
 */
export function siteMemoryAdapter(store: SiteMemorySyncStore): SyncAdapter<SyncedSiteMemory | SiteMemoryWipe> {
  return {
    list: () => store.syncList(),
    apply: (items) => {
      const changes: Array<{ id: string; record: SyncedSiteMemory | SiteMemoryWipe | null }> = [];
      for (const item of items) {
        if (item.deleted) {
          changes.push({ id: item.id, record: null });
          continue;
        }
        const record = item.id === WIPE_RECORD_ID ? parseSiteMemoryWipe(item.payload) : parseSyncedSiteMemory(item.payload, item.id);
        if (record) changes.push({ id: item.id, record });
      }
      store.applyRemote(changes);
    },
    join: () => store.resetSyncMarkers(),
    retain: () => true,
  };
}

export function settingsAdapter(settings: SettingsAccess, includeServiceUrls: () => boolean): SyncAdapter<{ v: unknown }> {
  return {
    list: () => {
      const current = settings.get();
      return syncedSettingKeys(includeServiceUrls()).map((key) => ({ id: key, payload: { v: readSetting(current, key) } }));
    },
    apply: (items) => {
      const allowed = new Set<string>(syncedSettingKeys(includeServiceUrls()));
      const entries: Array<[SyncedSettingKey, unknown]> = [];
      for (const item of items) {
        if (!item.deleted && allowed.has(item.id) && isObject(item.payload) && "v" in item.payload) {
          entries.push([item.id as SyncedSettingKey, item.payload.v]);
        }
      }
      if (entries.length > 0) settings.update(settingsPatch(entries));
    },
  };
}

export function parseProfileMeta(raw: unknown): ProfileMeta | null {
  if (!isObject(raw) || typeof raw.name !== "string") return null;
  const name = raw.name.trim().slice(0, 60);
  if (!name) return null;
  return typeof raw.avatar === "string" && /^#[0-9a-f]{6}$/i.test(raw.avatar) ? { name, avatar: raw.avatar } : { name };
}

export function profileAdapter(profile: ProfileAccess): SyncAdapter<ProfileMeta> {
  return {
    list: () => {
      const { name, avatar } = profile.get();
      return [{ id: PROFILE_RECORD_ID, payload: avatar ? { name, avatar } : { name } }];
    },
    apply: (items) => {
      for (const item of items) {
        if (item.id !== PROFILE_RECORD_ID || item.deleted) continue;
        const meta = parseProfileMeta(item.payload);
        if (meta) profile.set(meta);
      }
    },
  };
}

export interface DeviceRecords {
  all(): Record<string, unknown>;
  set(deviceId: string, payload: unknown): void;
  delete(deviceId: string): void;
}

const DEVICE_KEY_RE = /^[A-Za-z0-9-]{8,64}$/;

/**
 * Collections with one record per device (open tabs, installed extensions). This device publishes
 * its own record; other devices' records are kept verbatim so they are listed back unchanged (never
 * republished or deleted on their behalf). Removing a device drops its record, which the engine then
 * pushes as a deletion.
 */
export function deviceRecordsAdapter(opts: {
  ownId: () => Promise<string>;
  own: () => unknown;
  records: DeviceRecords;
  valid: (raw: unknown) => boolean;
}): SyncAdapter<unknown> {
  return {
    list: async () => {
      const ownId = await opts.ownId();
      const items: LocalItem[] = [{ id: ownId, payload: opts.own() }];
      for (const [id, payload] of Object.entries(opts.records.all())) if (id !== ownId) items.push({ id, payload });
      return items;
    },
    apply: async (items) => {
      const ownId = await opts.ownId();
      for (const item of items) {
        if (item.id === ownId || !DEVICE_KEY_RE.test(item.id)) continue;
        if (item.deleted) opts.records.delete(item.id);
        else if (opts.valid(item.payload)) opts.records.set(item.id, item.payload);
      }
    },
  };
}

/**
 * Pages sent between devices (one record per page). Every record is kept verbatim and listed back
 * unchanged, so the engine never deletes a page meant for another device. A page for this device
 * stays here until it has been opened (SyncService), and its removal is then pushed as a deletion,
 * which tells the sender it arrived.
 */
export function sentTabsAdapter(records: DeviceRecords): SyncAdapter<unknown> {
  return {
    list: () => Object.entries(records.all()).map(([id, payload]) => ({ id, payload })),
    apply: (items) => {
      for (const item of items) {
        if (!SENT_TAB_ID_RE.test(item.id)) continue;
        if (item.deleted) records.delete(item.id);
        else if (parseSentTab(item.payload)) records.set(item.id, item.payload);
      }
    },
  };
}

interface RemoteFile {
  open_tabs: Record<string, unknown>;
  extensions: Record<string, unknown>;
  watch_status: Record<string, unknown>;
  sent_tabs: Record<string, unknown>;
  dismissedExtensions: string[];
}

type RemoteCollection = "open_tabs" | "extensions" | "watch_status" | "sent_tabs";

function emptyRemote(): RemoteFile {
  return { open_tabs: {}, extensions: {}, watch_status: {}, sent_tabs: {}, dismissedExtensions: [] };
}

function reviveRemote(raw: unknown): RemoteFile {
  if (!isObject(raw)) return emptyRemote();
  const records = (v: unknown, key: RegExp): Record<string, unknown> =>
    isObject(v) ? Object.fromEntries(Object.entries(v).filter(([id]) => key.test(id))) : {};
  return {
    open_tabs: records(raw.open_tabs, DEVICE_KEY_RE),
    extensions: records(raw.extensions, DEVICE_KEY_RE),
    watch_status: records(raw.watch_status, DEVICE_KEY_RE),
    sent_tabs: records(raw.sent_tabs, SENT_TAB_ID_RE),
    dismissedExtensions: Array.isArray(raw.dismissedExtensions) ? raw.dismissedExtensions.filter((x): x is string => typeof x === "string") : [],
  };
}

/** Other devices' records (per-device ones and pages sent between devices) plus dismissed extension suggestions, persisted per profile. */
export class SyncRemoteStore {
  private readonly file: JsonFile<RemoteFile>;

  constructor(filePath: string) {
    this.file = JsonFile.load(filePath, emptyRemote, reviveRemote, 0);
  }

  records(collection: RemoteCollection): DeviceRecords {
    return {
      all: () => this.file.get()[collection],
      set: (id, payload) => {
        this.file.update((f) => ({ ...f, [collection]: { ...f[collection], [id]: payload } }));
      },
      delete: (id) => {
        if (!Object.hasOwn(this.file.get()[collection], id)) return;
        this.file.update((f) => {
          const next = { ...f[collection] };
          delete next[id];
          return { ...f, [collection]: next };
        });
      },
    };
  }

  forgetDevice(deviceId: string): void {
    this.records("open_tabs").delete(deviceId);
    this.records("watch_status").delete(deviceId);
    this.records("extensions").delete(deviceId);
  }

  dismissed(): string[] {
    return this.file.get().dismissedExtensions;
  }

  dismiss(extensionId: string): void {
    if (!this.dismissed().includes(extensionId)) {
      this.file.update((f) => ({ ...f, dismissedExtensions: [...f.dismissedExtensions, extensionId] }));
    }
  }

  clear(): void {
    this.file.set(emptyRemote());
  }
}

export interface SyncSources {
  bookmarks: BookmarkStore;
  history: HistoryStore;
  credentials: CredentialStore;
  reading: ReadingSyncStore;
  watches: WatchSyncStore;
  workspaces: WorkspaceSyncStore;
  annotations: AnnotationSyncStore;
  /** Saved workflows; left out when the user turned sync of workflows off on this device. */
  workflows?: WorkflowSyncStore;
  /** Site memory; left out when the user turned sync of site memory off on this device. */
  siteMemory?: SiteMemorySyncStore;
  settings: SettingsAccess;
  /** User opt-in to also sync machine-specific service URLs (SearXNG). */
  includeServiceUrls: () => boolean;
  profile: ProfileAccess;
  remote: SyncRemoteStore;
  ownDeviceId: () => Promise<string>;
  openTabs: () => DeviceTabs;
  extensions: () => DeviceExtensions;
  /** What this device's monitor last saw of each watched page (for the phone). */
  watchStatus: () => DeviceWatchStatus;
}

export function createSyncAdapters(src: SyncSources): Partial<Record<SyncCollection, SyncAdapter<any>>> {
  return {
    bookmarks: bookmarksAdapter(src.bookmarks),
    history: historyAdapter(src.history),
    credentials: credentialsAdapter(src.credentials),
    reading: readingAdapter(src.reading),
    watches: watchesAdapter(src.watches),
    workspaces: workspacesAdapter(src.workspaces),
    annotations: annotationsAdapter(src.annotations),
    ...(src.workflows ? { workflows: workflowsAdapter(src.workflows) } : {}),
    ...(src.siteMemory ? { site_memory: siteMemoryAdapter(src.siteMemory) } : {}),
    settings: settingsAdapter(src.settings, src.includeServiceUrls),
    profiles: profileAdapter(src.profile),
    open_tabs: deviceRecordsAdapter({
      ownId: src.ownDeviceId,
      own: src.openTabs,
      records: src.remote.records("open_tabs"),
      valid: (raw) => parseDeviceTabs(raw) !== null,
    }),
    extensions: deviceRecordsAdapter({
      ownId: src.ownDeviceId,
      own: src.extensions,
      records: src.remote.records("extensions"),
      valid: (raw) => parseDeviceExtensions(raw) !== null,
    }),
    watch_status: deviceRecordsAdapter({
      ownId: src.ownDeviceId,
      own: src.watchStatus,
      records: src.remote.records("watch_status"),
      valid: (raw) => parseDeviceWatchStatus(raw) !== null,
    }),
    sent_tabs: sentTabsAdapter(src.remote.records("sent_tabs")),
  };
}
