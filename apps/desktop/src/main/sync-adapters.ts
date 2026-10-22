/**
 * Bridges each local store to @corvus/sync-core's SyncEngine. Electron-free so the whole set can be
 * exercised end to end against a real sync server in tests.
 */
import type { Bookmark, SyncCollection } from "@corvus/shared";
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

function isSyncedBookmark(v: unknown): v is Bookmark {
  if (!isObject(v)) return false;
  return (
    typeof v.id === "string" &&
    typeof v.parentId === "string" &&
    (v.kind === "folder" || (v.kind === "bookmark" && typeof v.url === "string")) &&
    typeof v.title === "string" &&
    typeof v.position === "number" &&
    typeof v.createdAt === "number" &&
    typeof v.updatedAt === "number"
  );
}

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

interface RemoteFile {
  open_tabs: Record<string, unknown>;
  extensions: Record<string, unknown>;
  dismissedExtensions: string[];
}

type DeviceCollection = "open_tabs" | "extensions";

function emptyRemote(): RemoteFile {
  return { open_tabs: {}, extensions: {}, dismissedExtensions: [] };
}

function reviveRemote(raw: unknown): RemoteFile {
  if (!isObject(raw)) return emptyRemote();
  const records = (v: unknown): Record<string, unknown> =>
    isObject(v) ? Object.fromEntries(Object.entries(v).filter(([id]) => DEVICE_KEY_RE.test(id))) : {};
  return {
    open_tabs: records(raw.open_tabs),
    extensions: records(raw.extensions),
    dismissedExtensions: Array.isArray(raw.dismissedExtensions) ? raw.dismissedExtensions.filter((x): x is string => typeof x === "string") : [],
  };
}

/** Other devices' per-device records plus dismissed extension suggestions, persisted per profile. */
export class SyncRemoteStore {
  private readonly file: JsonFile<RemoteFile>;

  constructor(filePath: string) {
    this.file = JsonFile.load(filePath, emptyRemote, reviveRemote, 0);
  }

  records(collection: DeviceCollection): DeviceRecords {
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
  settings: SettingsAccess;
  /** User opt-in to also sync machine-specific service URLs (SearXNG). */
  includeServiceUrls: () => boolean;
  profile: ProfileAccess;
  remote: SyncRemoteStore;
  ownDeviceId: () => Promise<string>;
  openTabs: () => DeviceTabs;
  extensions: () => DeviceExtensions;
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
  };
}
