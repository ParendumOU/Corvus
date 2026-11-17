/**
 * Bridges each local store to @corvus/sync-core's SyncEngine. Electron-free so the whole set can be
 * exercised end to end against a real sync server in tests.
 */
import {
  ASK_ID_RE,
  CHAIN_SERVER_ID,
  SENT_TAB_ID_RE,
  isSyncedBookmark,
  parseAsk,
  parseDeviceWatchStatus,
  parseChainServer,
  parseSentTab,
  type Bookmark,
  type ChainServer,
  type DeviceWatchStatus,
  type SyncCollection,
} from "@corvus/shared";
import type { LocalItem, SyncAdapter } from "@corvus/sync-core";
import { isValidAddress, type AutofillAddress } from "../shared/addresses";
import { isValidCard, type AutofillCard } from "../shared/cards";
import { isAnnotation, type Annotation } from "../shared/annotations";
import { ROOT_IDS } from "../shared/bookmark-tree";
import { isDeletedLoginMemory, isValidCredential, type Credential, type DeletedLoginMemory } from "../shared/credentials";
import { parseDeviceExtensions, type DeviceExtensions } from "../shared/extension-suggestions";
import { parseSyncedHistory, toSyncedHistory, type SyncedHistoryEntry } from "../shared/history-ops";
import { isSyncedWatch, type SyncedWatch } from "../shared/page-watch";
import { isReadingItem, type ReadingItem } from "../shared/reading";
import { parseDeviceTabs, type DeviceTabs } from "../shared/open-tabs";
import type { Settings, SettingsPatch } from "../shared/settings";
import type { Workspace } from "../shared/workspaces";
import { WIPE_RECORD_ID, parseSiteMemoryWipe, parseSyncedSiteMemory, type SiteMemoryWipe, type SyncedSiteMemory } from "../shared/site-memory-sync";
import { parseSyncedWorkflow, type SyncedWorkflow } from "../shared/workflow-sync";
import { parseCommandRecent, type CommandRecent } from "../shared/command-history";
import { reviveConversation, type AssistConversation } from "../shared/assist-history";
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

/**
 * What a synced store says about records it lacks although nobody deleted them here. The engine then
 * forgets them (adapter.retain) instead of deleting them on every other device.
 */
export interface LossAware {
  /** Its file was missing or unreadable at load: what it lacks may have been lost, not deleted. */
  readonly loadedFresh?: boolean;
  /** A record it still holds but cannot read (a damaged entry). */
  isUnreadable?(id: string): boolean;
}

/**
 * One per profile. A store that started from nothing keeps every record it lacks on the chain until a
 * sync cycle has gone through (the engine has forgotten them by then); deletions after that sync as
 * usual.
 */
export class SyncLossGuard {
  private readonly settled = new WeakSet<object>();
  private readonly watched = new Set<object>();

  /** Whether `id`, missing from the store's list, was lost rather than deleted here. */
  lost(store: LossAware, id: string, unreadable = (key: string) => store.isUnreadable?.(key) === true): boolean {
    if (unreadable(id)) return true;
    return !this.settled.has(store) && store.loadedFresh === true;
  }

  /** A sync cycle went through: from now on what the stores lack was deleted. */
  settle(): void {
    for (const store of this.watched) this.settled.add(store);
    this.watched.clear();
  }

  /** The adapter's retain(): lost records, then the store's own rule. */
  retain(store: LossAware, own?: (id: string) => boolean, unreadable?: (id: string) => boolean): (id: string) => boolean {
    this.watched.add(store);
    return (id) => this.lost(store, id, unreadable) || own?.(id) === true;
  }
}

export function bookmarksAdapter(store: BookmarkStore, guard?: SyncLossGuard): SyncAdapter<Bookmark> {
  return {
    ...(guard ? { retain: guard.retain(store) } : {}),
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

/**
 * History records are keyed by URL, so visits to the same page on two devices merge into one. Pages
 * known only from another browser's live history stay on this computer.
 */
export function historyAdapter(store: HistoryStore, guard?: SyncLossGuard): SyncAdapter<SyncedHistoryEntry> {
  return {
    ...(guard ? { retain: guard.retain(store) } : {}),
    list: () => store.all().flatMap((e) => (e.source ? [] : [{ id: e.url, payload: toSyncedHistory(e) }])),
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

export interface CredentialStore extends LossAware {
  all(): Credential[];
  applyRemote(changes: Array<{ id: string; cred: Credential | null }>): void;
  deletionItems(): Array<{ id: string; memory: DeletedLoginMemory }>;
  applyRemoteDeletions(changes: Array<{ id: string; memory: DeletedLoginMemory | null }>): void;
  /** A deleted-login memory it still holds but cannot read. */
  isUnreadableDeletion?(key: string): boolean;
}

/** Logins are keyed by their stable id; the full record (including the password) is the synced payload. */
export function credentialsAdapter(store: CredentialStore, guard?: SyncLossGuard): SyncAdapter<Credential> {
  return {
    ...(guard ? { retain: guard.retain(store) } : {}),
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

/** Deleted-login memory, keyed by its stable natural id, merged by union. */
export function credentialDeletionsAdapter(store: CredentialStore, guard?: SyncLossGuard): SyncAdapter<DeletedLoginMemory> {
  return {
    ...(guard ? { retain: guard.retain(store, undefined, (key) => store.isUnreadableDeletion?.(key) === true) } : {}),
    list: () => store.deletionItems().map((d) => ({ id: d.id, payload: d.memory })),
    apply: (items) => {
      const changes: Array<{ id: string; memory: DeletedLoginMemory | null }> = [];
      for (const item of items) {
        if (item.deleted) changes.push({ id: item.id, memory: null });
        else if (isDeletedLoginMemory(item.payload)) changes.push({ id: item.id, memory: item.payload });
      }
      store.applyRemoteDeletions(changes);
    },
  };
}

export interface AddressSyncStore extends LossAware {
  all(): AutofillAddress[];
  applyRemote(changes: Array<{ id: string; address: AutofillAddress | null }>): void;
}

/** Saved addresses, keyed by their stable id; the full record is the synced payload (end to end encrypted). */
export function addressesAdapter(store: AddressSyncStore, guard?: SyncLossGuard): SyncAdapter<AutofillAddress> {
  return {
    ...(guard ? { retain: guard.retain(store) } : {}),
    list: () => store.all().map((a) => ({ id: a.id, payload: a })),
    apply: (items) => {
      const changes: Array<{ id: string; address: AutofillAddress | null }> = [];
      for (const item of items) {
        if (item.deleted) changes.push({ id: item.id, address: null });
        else {
          const address: unknown = { ...(item.payload as object), id: item.id };
          if (isValidAddress(address)) changes.push({ id: item.id, address });
        }
      }
      store.applyRemote(changes);
    },
  };
}

export interface CardSyncStore extends LossAware {
  all(): AutofillCard[];
  applyRemote(changes: Array<{ id: string; card: AutofillCard | null }>): void;
}

/** Saved payment cards (never a CVV), keyed by their stable id; the full record is the synced payload (end to end encrypted). */
export function cardsAdapter(store: CardSyncStore, guard?: SyncLossGuard): SyncAdapter<AutofillCard> {
  return {
    ...(guard ? { retain: guard.retain(store) } : {}),
    list: () => store.all().map((c) => ({ id: c.id, payload: c })),
    apply: (items) => {
      const changes: Array<{ id: string; card: AutofillCard | null }> = [];
      for (const item of items) {
        if (item.deleted) changes.push({ id: item.id, card: null });
        else {
          const card: unknown = { ...(item.payload as object), id: item.id };
          if (isValidCard(card)) changes.push({ id: item.id, card });
        }
      }
      store.applyRemote(changes);
    },
  };
}

export interface ReadingSyncStore extends LossAware {
  allItems(): ReadingItem[];
  applyRemote(changes: Array<{ url: string; item: ReadingItem | null }>): void;
}

/** Saved reader-mode articles, keyed by URL across devices (the store dedupes saves by URL). */
export function readingAdapter(store: ReadingSyncStore, guard?: SyncLossGuard): SyncAdapter<ReadingItem> {
  return {
    ...(guard ? { retain: guard.retain(store) } : {}),
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

export interface WatchSyncStore extends LossAware {
  syncList(): SyncedWatch[];
  applyRemote(changes: Array<{ url: string; def: SyncedWatch | null }>): void;
}

/** Watched pages, keyed by URL. Only the user's intent syncs; monitoring state stays per device. */
export function watchesAdapter(store: WatchSyncStore, guard?: SyncLossGuard): SyncAdapter<SyncedWatch> {
  return {
    ...(guard ? { retain: guard.retain(store) } : {}),
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

export interface WorkspaceSyncStore extends LossAware {
  list(): Workspace[];
  applyRemote(changes: Array<{ id: string; workspace: Workspace | null }>): void;
}

function looksLikeWorkspace(v: unknown): v is Workspace {
  return isObject(v) && typeof v.id === "string" && typeof v.name === "string" && Array.isArray(v.tabs);
}

/** Named workspaces, keyed by their stable id. The store fully validates upserts on apply. */
export function workspacesAdapter(store: WorkspaceSyncStore, guard?: SyncLossGuard): SyncAdapter<Workspace> {
  return {
    ...(guard ? { retain: guard.retain(store) } : {}),
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

export interface AnnotationSyncStore extends LossAware {
  all(): Annotation[];
  applyRemote(changes: Array<{ id: string; annotation: Annotation | null }>): void;
}

/** Page annotations, keyed by their stable id (distinct across devices, like workspaces). */
export function annotationsAdapter(store: AnnotationSyncStore, guard?: SyncLossGuard): SyncAdapter<Annotation> {
  return {
    ...(guard ? { retain: guard.retain(store) } : {}),
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

export interface WorkflowSyncStore extends LossAware {
  syncList(): SyncedWorkflow[];
  applyRemote(changes: ReadonlyArray<{ id: string; record: SyncedWorkflow | null }>): void;
  resetSyncMarkers(): void;
}

/**
 * Saved workflows, keyed by their stable id. Records merge (last writer wins by updatedAt, usage
 * per device) instead of replacing; deletions travel as dated records (shared/workflow-sync.ts).
 */
export function workflowsAdapter(store: WorkflowSyncStore, guard?: SyncLossGuard): SyncAdapter<SyncedWorkflow> {
  return {
    ...(guard ? { retain: guard.retain(store) } : {}),
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

export interface CommandHistorySyncStore extends LossAware {
  syncList(): Array<{ id: string; payload: unknown }>;
  applyRemote(changes: ReadonlyArray<{ id: string; recent: CommandRecent | null }>): void;
}

/**
 * Command Bar recents, one record per entry (random ids). The store keeps the newest 50, one per
 * kind and text: an entry it drops (older, or the same text again) is deleted on the chain too.
 */
export function commandHistoryAdapter(store: CommandHistorySyncStore, guard?: SyncLossGuard): SyncAdapter<unknown> {
  return {
    ...(guard ? { retain: guard.retain(store) } : {}),
    list: () => store.syncList(),
    apply: (items) => {
      const changes: Array<{ id: string; recent: CommandRecent | null }> = [];
      for (const item of items) {
        if (item.deleted) changes.push({ id: item.id, recent: null });
        else {
          const recent = parseCommandRecent(item.payload, item.id);
          if (recent) changes.push({ id: item.id, recent });
        }
      }
      store.applyRemote(changes);
    },
  };
}

export interface AssistHistorySyncStore extends LossAware {
  syncList(): Array<{ id: string; payload: AssistConversation }>;
  applyRemote(changes: ReadonlyArray<{ id: string; conversation: AssistConversation | null }>): void;
  retain(id: string): boolean;
}

/** Assist conversations, one record per conversation; the newer version wins (see the store). */
export function assistHistoryAdapter(store: AssistHistorySyncStore, guard?: SyncLossGuard): SyncAdapter<unknown> {
  return {
    list: () => store.syncList(),
    apply: (items) => {
      const changes: Array<{ id: string; conversation: AssistConversation | null }> = [];
      for (const item of items) {
        if (item.deleted) changes.push({ id: item.id, conversation: null });
        else {
          const conversation = reviveConversation({ ...(item.payload as object), id: item.id });
          if (conversation) changes.push({ id: item.id, conversation });
        }
      }
      store.applyRemote(changes);
    },
    retain: guard ? guard.retain(store, (id) => store.retain(id)) : (id) => store.retain(id),
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
  /** Retains what a lost sync-remote.json no longer lists. */
  retain?: (id: string) => boolean;
}): SyncAdapter<unknown> {
  return {
    ...(opts.retain ? { retain: opts.retain } : {}),
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
export function sentTabsAdapter(records: DeviceRecords, retain?: (id: string) => boolean): SyncAdapter<unknown> {
  return {
    ...(retain ? { retain } : {}),
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

/**
 * Questions asked from the phone (one record per question). Kept verbatim like sent pages; the
 * computer a question went to answers it in place (SyncService pushes each write itself), and the
 * phone deletes it. Only brought in: the engine never pushes these records again, since a copy it
 * pushed late could bring back a question the phone has just deleted.
 */
export function asksAdapter(records: DeviceRecords): SyncAdapter<unknown> {
  return {
    list: () => [],
    retain: () => true,
    apply: (items) => {
      for (const item of items) {
        if (!ASK_ID_RE.test(item.id)) continue;
        if (item.deleted) records.delete(item.id);
        else if (parseAsk(item.payload)) records.set(item.id, item.payload);
      }
    },
  };
}

/**
 * Where the chain's sync server is (one record, see chain-server.ts in @corvus/shared). `own` is the
 * record this device writes (in "This computer" mode: its current addresses), or null to keep the
 * record as it came (SyncService follows the chain when it moved elsewhere).
 */
export function chainServerAdapter(opts: { records: DeviceRecords; own: () => Promise<ChainServer | null>; retain?: (id: string) => boolean }): SyncAdapter<unknown> {
  return {
    ...(opts.retain ? { retain: opts.retain } : {}),
    list: async () => {
      const own = await opts.own();
      if (own) opts.records.set(CHAIN_SERVER_ID, own);
      const stored = opts.records.all()[CHAIN_SERVER_ID];
      return stored === undefined ? [] : [{ id: CHAIN_SERVER_ID, payload: stored }];
    },
    apply: (items) => {
      for (const item of items) {
        if (item.id !== CHAIN_SERVER_ID) continue;
        if (item.deleted) {
          opts.records.delete(item.id);
          continue;
        }
        const record = parseChainServer(item.payload);
        if (!record) continue;
        opts.records.set(item.id, record);
      }
    },
  };
}

interface RemoteFile {
  chain_server: Record<string, unknown>;
  open_tabs: Record<string, unknown>;
  extensions: Record<string, unknown>;
  watch_status: Record<string, unknown>;
  sent_tabs: Record<string, unknown>;
  asks: Record<string, unknown>;
  dismissedExtensions: string[];
}

type RemoteCollection = "chain_server" | "open_tabs" | "extensions" | "watch_status" | "sent_tabs" | "asks";

function emptyRemote(): RemoteFile {
  return { chain_server: {}, open_tabs: {}, extensions: {}, watch_status: {}, sent_tabs: {}, asks: {}, dismissedExtensions: [] };
}

function reviveRemote(raw: unknown): RemoteFile {
  if (!isObject(raw)) return emptyRemote();
  const records = (v: unknown, key: RegExp): Record<string, unknown> =>
    isObject(v) ? Object.fromEntries(Object.entries(v).filter(([id]) => key.test(id))) : {};
  return {
    chain_server: records(raw.chain_server, /^current$/),
    open_tabs: records(raw.open_tabs, DEVICE_KEY_RE),
    extensions: records(raw.extensions, DEVICE_KEY_RE),
    watch_status: records(raw.watch_status, DEVICE_KEY_RE),
    sent_tabs: records(raw.sent_tabs, SENT_TAB_ID_RE),
    asks: records(raw.asks, ASK_ID_RE),
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

  /** The store's file was missing or unreadable at load (see JsonFile.fresh). */
  get loadedFresh(): boolean {
    return this.file.fresh;
  }
}

export interface SyncSources {
  bookmarks: BookmarkStore;
  history: HistoryStore;
  credentials: CredentialStore;
  addresses: AddressSyncStore;
  cards: CardSyncStore;
  reading: ReadingSyncStore;
  watches: WatchSyncStore;
  workspaces: WorkspaceSyncStore;
  annotations: AnnotationSyncStore;
  /** Saved workflows; left out when the user turned sync of workflows off on this device. */
  workflows?: WorkflowSyncStore;
  /** Site memory; left out when the user turned sync of site memory off on this device. */
  siteMemory?: SiteMemorySyncStore;
  /** Command Bar recents; left out when the user turned their sync off on this device. */
  commands?: CommandHistorySyncStore;
  /** Assist conversations; left out when the user turned their sync off on this device. */
  assistHistory?: AssistHistorySyncStore;
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
  /** The chain_server record this device writes, or null to keep the one that came (default: none). */
  chainServer?: () => Promise<ChainServer | null>;
  /** Keeps on the chain what a store lost rather than deleted (left out: every missing record is a deletion). */
  lossGuard?: SyncLossGuard;
}

export function createSyncAdapters(src: SyncSources): Partial<Record<SyncCollection, SyncAdapter<any>>> {
  const guard = src.lossGuard;
  const remoteRetain = guard?.retain(src.remote);
  return {
    bookmarks: bookmarksAdapter(src.bookmarks, guard),
    history: historyAdapter(src.history, guard),
    credentials: credentialsAdapter(src.credentials, guard),
    credential_deletions: credentialDeletionsAdapter(src.credentials, guard),
    addresses: addressesAdapter(src.addresses, guard),
    cards: cardsAdapter(src.cards, guard),
    reading: readingAdapter(src.reading, guard),
    watches: watchesAdapter(src.watches, guard),
    workspaces: workspacesAdapter(src.workspaces, guard),
    annotations: annotationsAdapter(src.annotations, guard),
    ...(src.workflows ? { workflows: workflowsAdapter(src.workflows, guard) } : {}),
    ...(src.siteMemory ? { site_memory: siteMemoryAdapter(src.siteMemory) } : {}),
    ...(src.commands ? { command_history: commandHistoryAdapter(src.commands, guard) } : {}),
    ...(src.assistHistory ? { assist_history: assistHistoryAdapter(src.assistHistory, guard) } : {}),
    settings: settingsAdapter(src.settings, src.includeServiceUrls),
    profiles: profileAdapter(src.profile),
    open_tabs: deviceRecordsAdapter({
      ownId: src.ownDeviceId,
      own: src.openTabs,
      records: src.remote.records("open_tabs"),
      retain: remoteRetain,
      valid: (raw) => parseDeviceTabs(raw) !== null,
    }),
    extensions: deviceRecordsAdapter({
      ownId: src.ownDeviceId,
      own: src.extensions,
      records: src.remote.records("extensions"),
      retain: remoteRetain,
      valid: (raw) => parseDeviceExtensions(raw) !== null,
    }),
    watch_status: deviceRecordsAdapter({
      ownId: src.ownDeviceId,
      own: src.watchStatus,
      records: src.remote.records("watch_status"),
      retain: remoteRetain,
      valid: (raw) => parseDeviceWatchStatus(raw) !== null,
    }),
    sent_tabs: sentTabsAdapter(src.remote.records("sent_tabs"), remoteRetain),
    asks: asksAdapter(src.remote.records("asks")),
    chain_server: chainServerAdapter({ records: src.remote.records("chain_server"), own: src.chainServer ?? (async () => null), retain: remoteRetain }),
  };
}
