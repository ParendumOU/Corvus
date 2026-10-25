import { GROUP_COLORS, type Bookmark, type GroupColor } from "@corvus/shared";
import { OTHER_FOLDER_ID, ROOT_IDS, childrenOf } from "../shared/bookmark-tree";
import {
  bookmarkEvents,
  chromeTree,
  isBookmarkableUrl,
  recentBookmarks,
  searchBookmarks,
  toChromeNode,
  type BookmarkQuery,
  type ChromeBookmarkNode,
} from "../shared/chrome-bookmarks";
import { searchHistory, toHistoryItem, visitsFor, type HistoryQuery } from "../shared/chrome-history";
import { groupEvents, queryGroups, toChromeGroup, type ChromeTabGroup, type GroupPlacement, type TabGroupQuery } from "../shared/chrome-tab-groups";
import { closedSessions, deviceSessions, type ChromeSessionTab, type ClosedTabEntry } from "../shared/chrome-sessions";
import { effectiveOptions, sidePanelUrl, type SidePanelOptions } from "../shared/chrome-side-panel";
import { DownloadIdMap, downloadEvents, searchDownloads, toDownloadItem, toDownloadQuery, type ChromeDownloadItem } from "../shared/chrome-downloads";
import { isExecutableFilename, type DownloadAction, type DownloadRecord } from "../shared/downloads";
import { activeShortcuts, manifestCommands } from "../shared/extension-commands";
import type { RemoteDeviceTabs } from "../shared/open-tabs";
import type { GroupPatch } from "../shared/tab-strip";
import type { HistoryRecord } from "../shared/history-ops";
import type { RouterCallback } from "./extensions";

/** What the chrome.* namespaces Corvus adds need from the profile's extension host. */
export interface ExtensionApiHost {
  /** Registers a handler; the router refuses extensions whose manifest lacks `permission`. */
  handle(name: string, callback: RouterCallback, permission?: string): void;
  /** Sends an event to every extension with `permission`. */
  emit(permission: string, event: string, ...args: unknown[]): void;
}

export interface BookmarkSource {
  list(): Bookmark[];
  get(id: string): Bookmark | undefined;
  create(node: { parentId: string; kind: "folder" | "bookmark"; title: string; url?: string; index?: number }): Bookmark;
  update(id: string, patch: { title?: string; url?: string }): void;
  move(id: string, parentId: string, index?: number): void;
  remove(id: string): void;
  changes: { on(listener: () => void): () => void };
}

export interface HistorySource {
  all(): HistoryRecord[];
  recordVisit(url: string, title: string): void;
  /** The most visited sites, most visited first. */
  top(limit: number): HistoryRecord[];
  remove(ids: string[]): void;
  clear(): void;
  onVisit(listener: (entry: HistoryRecord) => void): () => void;
  onRemove(listener: (urls: string[] | "all") => void): () => void;
}

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/**
 * chrome.bookmarks and chrome.history for extensions, over the profile's own stores. The preload
 * (preload/extension-api.ts) adds the namespaces to extensions that declare the permission; the
 * router checks the permission again on every call. Changes made anywhere (the person, sync, an
 * extension) reach the extensions as Chrome's events.
 */
export function registerExtensionApis(host: ExtensionApiHost, bookmarks: BookmarkSource, history: HistorySource, now: () => number = Date.now): () => void {
  registerBookmarks(host, bookmarks);
  registerHistory(host, history, now);
  // chrome.topSites (the preload, preload/extension-sw.ts, points the library stub here).
  host.handle("topSites.get", () => history.top(10).map((h) => ({ url: h.url, title: h.title })), "topSites");
  let last = bookmarks.list();
  const offs = [
    bookmarks.changes.on(() => {
      const next = bookmarks.list();
      for (const e of bookmarkEvents(last, next)) host.emit("bookmarks", `bookmarks.${e.event}`, ...e.args);
      last = next;
    }),
    history.onVisit((entry) => host.emit("history", "history.onVisited", toHistoryItem(entry))),
    history.onRemove((urls) => host.emit("history", "history.onVisitRemoved", urls === "all" ? { allHistory: true, urls: [] } : { allHistory: false, urls })),
  ];
  return () => offs.forEach((off) => off());
}

function registerBookmarks(host: ExtensionApiHost, store: BookmarkSource): void {
  const h = (name: string, fn: (...args: unknown[]) => unknown): void => host.handle(`bookmarks.${name}`, (_event, ...args) => fn(...args), "bookmarks");
  const node = (id: unknown): Bookmark => {
    const found = typeof id === "string" ? store.get(id) : undefined;
    if (!found) throw new Error("Can't find bookmark for id.");
    return found;
  };
  const writable = (id: unknown): Bookmark => {
    const found = node(id);
    if (ROOT_IDS.has(found.id)) throw new Error("Can't modify the root bookmark folders.");
    return found;
  };
  const chrome = (id: string, withChildren = false): ChromeBookmarkNode => toChromeNode(store.list(), node(id), withChildren);

  h("get", (idOrList) => (Array.isArray(idOrList) ? idOrList : [idOrList]).map((id) => chrome(String(id))));
  h("getChildren", (id) => childrenOf(store.list(), node(id).id).map((c) => chrome(c.id)));
  h("getRecent", (count) => recentBookmarks(store.list(), num(count) ?? 10).map((b) => chrome(b.id)));
  h("getTree", () => chromeTree(store.list()));
  h("getSubTree", (id) => [chrome(node(id).id, true)]);
  h("search", (query) => searchBookmarks(store.list(), (typeof query === "string" ? query : obj(query)) as BookmarkQuery).map((b) => chrome(b.id)));
  h("create", (details) => {
    const d = obj(details);
    const url = str(d.url);
    if (url !== undefined && !isBookmarkableUrl(url)) throw new Error("Invalid URL.");
    const parent = node(str(d.parentId) ?? OTHER_FOLDER_ID);
    if (parent.kind !== "folder") throw new Error("Parameter 'parentId' does not specify a folder.");
    const created = store.create({
      parentId: parent.id,
      kind: url ? "bookmark" : "folder",
      title: (str(d.title) ?? "").slice(0, 1000),
      ...(url ? { url } : {}),
      ...(num(d.index) !== undefined ? { index: num(d.index) } : {}),
    });
    return chrome(created.id);
  });
  h("update", (id, changes) => {
    const target = writable(id);
    const c = obj(changes);
    const url = str(c.url);
    if (url !== undefined && (target.kind === "folder" || !isBookmarkableUrl(url))) throw new Error(target.kind === "folder" ? "Can't set URL of a bookmark folder." : "Invalid URL.");
    store.update(target.id, { ...(str(c.title) !== undefined ? { title: str(c.title)!.slice(0, 1000) } : {}), ...(url ? { url } : {}) });
    return chrome(target.id);
  });
  h("move", (id, destination) => {
    const target = writable(id);
    const d = obj(destination);
    const parent = node(str(d.parentId) ?? target.parentId ?? OTHER_FOLDER_ID);
    if (parent.kind !== "folder") throw new Error("Parameter 'parentId' does not specify a folder.");
    store.move(target.id, parent.id, num(d.index));
    return chrome(target.id);
  });
  h("remove", (id) => {
    const target = writable(id);
    if (target.kind === "folder" && childrenOf(store.list(), target.id).length > 0) throw new Error("Can't remove non-empty folder (use recursive to remove).");
    store.remove(target.id);
  });
  h("removeTree", (id) => {
    store.remove(writable(id).id);
  });
}

function registerHistory(host: ExtensionApiHost, store: HistorySource, now: () => number): void {
  const h = (name: string, fn: (...args: unknown[]) => unknown): void => host.handle(`history.${name}`, (_event, ...args) => fn(...args), "history");
  const urlOf = (details: unknown): string => {
    const url = str(obj(details).url);
    if (!url) throw new Error("Invalid URL.");
    return url;
  };
  h("search", (query) => {
    const q = obj(query);
    return searchHistory(store.all(), { text: str(q.text) ?? "", ...pick(q, ["startTime", "endTime", "maxResults"]) } as HistoryQuery, now());
  });
  h("getVisits", (details) => visitsFor(store.all(), urlOf(details)));
  h("addUrl", (details) => {
    const url = urlOf(details);
    if (!isBookmarkableUrl(url)) throw new Error("Invalid URL.");
    store.recordVisit(url, "");
  });
  h("deleteUrl", (details) => {
    const url = urlOf(details);
    const ids = store.all().filter((e) => e.url === url).map((e) => e.id);
    if (ids.length > 0) store.remove(ids);
  });
  h("deleteRange", (range) => {
    const r = obj(range);
    const start = num(r.startTime);
    const end = num(r.endTime);
    if (start === undefined || end === undefined) throw new Error("startTime and endTime are required.");
    const ids = store.all().filter((e) => e.visitedAt >= start && e.visitedAt <= end).map((e) => e.id);
    if (ids.length > 0) store.remove(ids);
  });
  h("deleteAll", () => store.clear());
}

function pick(o: Record<string, unknown>, keys: string[]): Record<string, number> {
  return Object.fromEntries(keys.flatMap((k) => (num(o[k]) !== undefined ? [[k, num(o[k])!]] : [])));
}

/** What chrome.tabGroups and chrome.tabs.group need from the window layer (extension-windows.ts). */
export interface TabGroupAccess {
  /** Every group in the profile's windows. */
  groups(): GroupPlacement[];
  /** The window an extension context calls from (its tab's window, else the focused one). */
  currentWindowId(): number | undefined;
  update(id: number, patch: GroupPatch): void;
  move(id: number, index: number, windowId?: number): void;
  /** Puts tabs (webContents ids) in a group, an existing one or a new one; returns its id. */
  group(tabIds: number[], groupId?: number): number;
  ungroup(tabIds: number[]): void;
}

/**
 * chrome.tabGroups (permission "tabGroups") and chrome.tabs.group / ungroup (no permission, as in
 * Chrome) over Corvus's tab strip. Group changes reach extensions as Chrome's events.
 */
export function registerTabGroupApis(host: ExtensionApiHost & { onWindowChanged(listener: () => void): () => void }, access: TabGroupAccess): () => void {
  // Events: after each change an extension makes (so two changes in a row are two events, as in
  // Chrome) and whenever a window's tabs or groups change for any other reason.
  let last = access.groups();
  const refresh = (): void => {
    const next = access.groups();
    for (const e of groupEvents(last, next)) host.emit("tabGroups", `tabGroups.${e.event}`, e.group);
    last = next;
  };
  const changing =
    <A extends unknown[]>(fn: (...args: A) => unknown) =>
    (...args: A): unknown => {
      const result = fn(...args);
      refresh();
      return result;
    };
  const h = (name: string, fn: (...args: unknown[]) => unknown): void => host.handle(`tabGroups.${name}`, (_event, ...args) => fn(...args), "tabGroups");
  const find = (id: unknown): GroupPlacement => {
    const found = typeof id === "number" ? access.groups().find((g) => g.id === id) : undefined;
    if (!found) throw new Error(`No group with id: ${String(id)}.`);
    return found;
  };
  const current = (id: unknown): ChromeTabGroup => toChromeGroup(find(id));
  h("get", (id) => current(id));
  h("query", (query) => queryGroups(access.groups(), obj(query) as TabGroupQuery, access.currentWindowId()));
  h("update", changing((id: unknown, props: unknown) => {
    const p = obj(props);
    const patch: GroupPatch = {};
    if (typeof p.collapsed === "boolean") patch.collapsed = p.collapsed;
    if (typeof p.title === "string") patch.title = p.title.slice(0, 200);
    if (p.color !== undefined) {
      if (!GROUP_COLORS.includes(p.color as GroupColor)) throw new Error(`Invalid color: ${String(p.color)}.`);
      patch.color = p.color as GroupColor;
    }
    access.update(find(id).id, patch);
    return current(id);
  }));
  h("move", changing((id: unknown, props: unknown) => {
    const p = obj(props);
    const index = num(p.index);
    if (index === undefined) throw new Error("index is required.");
    access.move(find(id).id, index, num(p.windowId));
    return current(id);
  }));
  const tabList = (v: unknown): number[] => {
    const ids = (Array.isArray(v) ? v : [v]).filter((x): x is number => typeof x === "number");
    if (ids.length === 0) throw new Error("No tabs given.");
    return ids;
  };
  host.handle(
    "tabs.group",
    changing((_event: unknown, options: unknown) => {
      const o = obj(options);
      return access.group(tabList(o.tabIds), num(o.groupId));
    }),
  );
  host.handle(
    "tabs.ungroup",
    changing((_event: unknown, tabIds: unknown) => access.ungroup(tabList(tabIds))),
  );
  return host.onWindowChanged(refresh);
}

/** What chrome.sessions needs from the window layer and sync (extension-windows.ts). */
export interface SessionsAccess {
  /** Recently closed tabs of the profile's windows. */
  closed(): ClosedTabEntry[];
  /** Reopens a closed tab (the newest when no id), or another device's tab; null when there is none. */
  restore(sessionId?: string): Promise<ChromeSessionTab | null>;
  /** The profile's other devices and their open tabs (empty without sync). */
  devices(): Promise<RemoteDeviceTabs[]>;
}

/** chrome.sessions (permission "sessions"): recently closed tabs, other devices' tabs, restore. */
export function registerSessionApis(host: ExtensionApiHost & { onWindowChanged(listener: () => void): () => void }, access: SessionsAccess): () => void {
  const h = (name: string, fn: (...args: unknown[]) => unknown): void => host.handle(`sessions.${name}`, (_event, ...args) => fn(...args), "sessions");
  h("getRecentlyClosed", (filter) => closedSessions(access.closed(), num(obj(filter).maxResults)));
  h("getDevices", async (filter) => deviceSessions(await access.devices(), num(obj(filter).maxResults)));
  h("restore", async (sessionId) => {
    const tab = await access.restore(typeof sessionId === "string" ? sessionId : undefined);
    if (!tab) throw new Error(typeof sessionId === "string" ? `Invalid session id: "${sessionId}".` : "There are no recently closed sessions.");
    return { lastModified: Math.floor(Date.now() / 1000), tab };
  });
  // onChanged when the recently closed list changes (a tab closed or reopened).
  const signature = (): string => access.closed().map((c) => c.sessionId).join();
  let last = signature();
  return host.onWindowChanged(() => {
    const next = signature();
    if (next !== last) host.emit("sessions", "sessions.onChanged");
    last = next;
  });
}

/** What chrome.sidePanel needs from the window layer (extension-windows.ts). */
export interface SidePanelAccess {
  /** The window to act on: a tab's (webContents id), the given one, else the current one. */
  windowFor(opts: { tabId?: number; windowId?: number }): number | undefined;
  /** The active tab (webContents id) of a window. */
  activeTabId(windowId: number): number | undefined;
  /** The extension's own default path (manifest side_panel.default_path). */
  manifestPath(extensionId: string): string | undefined;
  /** The extension whose panel is open in a window. */
  openIn(windowId: number): string | null;
  open(windowId: number, extensionId: string, url: string): void;
  close(windowId: number): void;
  /** Called when a panel closes for any reason (its ✕, another panel, the window closing). */
  onClosed(listener: (windowId: number, extensionId: string) => void): void;
}

/**
 * chrome.sidePanel (permission "sidePanel"): options per extension and per tab, the toolbar
 * button opening the panel (openPanelOnActionClick), open and close, and onOpened / onClosed for
 * the extension that owns the panel.
 */
export function registerSidePanelApis(
  host: ExtensionApiHost & { sendTo(extensionId: string, event: string, ...args: unknown[]): void; intercept(name: string, wrap: (original: RouterCallback) => RouterCallback): void },
  access: SidePanelAccess,
): void {
  const global = new Map<string, SidePanelOptions>();
  const perTab = new Map<string, Map<number, SidePanelOptions>>();
  const openOnAction = new Set<string>();
  const extensionOf = (event: { extension?: { id: string } }): string => {
    const id = event.extension?.id;
    if (!id) throw new Error("Only extensions can use chrome.sidePanel.");
    return id;
  };
  const options = (id: string, tabId?: number): Required<SidePanelOptions> | null =>
    effectiveOptions(global.get(id), tabId === undefined ? undefined : perTab.get(id)?.get(tabId), access.manifestPath(id));
  const h = (name: string, fn: (extensionId: string, ...args: unknown[]) => unknown): void =>
    host.handle(`sidePanel.${name}`, (event, ...args) => fn(extensionOf(event as { extension?: { id: string } }), ...args), "sidePanel");

  const openPanel = (id: string, windowId: number): void => {
    const opts = options(id, access.activeTabId(windowId));
    if (!opts || !opts.enabled) throw new Error(`No active side panel for windowId: ${windowId}`);
    access.open(windowId, id, sidePanelUrl(id, opts.path));
    host.sendTo(id, "sidePanel.onOpened", { windowId, path: opts.path });
  };
  access.onClosed((windowId, id) => host.sendTo(id, "sidePanel.onClosed", { windowId }));

  h("setOptions", (id, raw) => {
    const o = obj(raw);
    const next: SidePanelOptions = {};
    if (typeof o.path === "string") {
      sidePanelUrl(id, o.path);
      next.path = o.path;
    }
    if (typeof o.enabled === "boolean") next.enabled = o.enabled;
    const tabId = num(o.tabId);
    if (tabId === undefined) global.set(id, { ...global.get(id), ...next });
    else {
      const tabs = perTab.get(id) ?? new Map<number, SidePanelOptions>();
      tabs.set(tabId, { ...tabs.get(tabId), ...next });
      perTab.set(id, tabs);
    }
    // Turned off where it is showing: it closes.
    if (next.enabled === false) {
      const windowId = access.windowFor(tabId === undefined ? {} : { tabId });
      if (windowId !== undefined && access.openIn(windowId) === id) access.close(windowId);
    }
  });
  h("getOptions", (id, raw) => {
    const tabId = num(obj(raw).tabId);
    const opts = options(id, tabId);
    return { ...(tabId !== undefined ? { tabId } : {}), ...(opts ?? { enabled: false }) };
  });
  h("setPanelBehavior", (id, raw) => {
    const value = obj(raw).openPanelOnActionClick;
    if (typeof value === "boolean") {
      if (value) openOnAction.add(id);
      else openOnAction.delete(id);
    }
  });
  h("getPanelBehavior", (id) => ({ openPanelOnActionClick: openOnAction.has(id) }));
  h("open", (id, raw) => {
    const o = obj(raw);
    const windowId = access.windowFor({ ...(num(o.tabId) !== undefined ? { tabId: num(o.tabId)! } : {}), ...(num(o.windowId) !== undefined ? { windowId: num(o.windowId)! } : {}) });
    if (windowId === undefined) throw new Error("No window to open the side panel in.");
    openPanel(id, windowId);
  });
  h("close", (id, raw) => {
    const o = obj(raw);
    const windowId = access.windowFor({ ...(num(o.tabId) !== undefined ? { tabId: num(o.tabId)! } : {}), ...(num(o.windowId) !== undefined ? { windowId: num(o.windowId)! } : {}) });
    if (windowId !== undefined && access.openIn(windowId) === id) access.close(windowId);
  });

  // The toolbar button: with openPanelOnActionClick it opens the panel, or closes it when it shows.
  host.intercept("browserAction.activate", (original) => (event, ...args) => {
    const details = obj(args[0]);
    const id = typeof details.extensionId === "string" ? details.extensionId : "";
    if (!id || !openOnAction.has(id)) return original(event, ...args);
    const windowId = access.windowFor(num(details.tabId) !== undefined ? { tabId: num(details.tabId)! } : {});
    if (windowId === undefined) return original(event, ...args);
    if (access.openIn(windowId) === id) access.close(windowId);
    else openPanel(id, windowId);
    return undefined;
  });
}

/** What chrome.downloads needs from the download manager (extension-windows.ts). */
export interface DownloadsAccess {
  list(): DownloadRecord[];
  /** Starts a download for an extension; resolves with its id once it has started. */
  download(extensionId: string, url: string, opts: { filename?: string; saveAs?: boolean }): Promise<string>;
  act(id: string, action: DownloadAction): void;
  showDefaultFolder(): void;
  /** The file's icon as a data: URL. */
  fileIcon(file: string, size: "small" | "normal"): Promise<string>;
  onChange(listener: (before: readonly DownloadRecord[], after: readonly DownloadRecord[]) => void): void;
}

/**
 * chrome.downloads (permission "downloads"; open needs "downloads.open") over the profile's
 * download list: what an extension starts lands there like any other download, programs it asks
 * for wait for the person, and it never opens a program or keeps a blocked one itself.
 */
export function registerDownloadApis(host: ExtensionApiHost, access: DownloadsAccess): void {
  const ids = new DownloadIdMap();
  const items = (list: readonly DownloadRecord[]): ChromeDownloadItem[] => list.map((r) => toDownloadItem(r, ids.number(r.id)));
  const record = (raw: unknown): DownloadRecord => {
    const n = num(raw);
    const id = n === undefined ? undefined : ids.id(n);
    const found = id === undefined ? undefined : access.list().find((d) => d.id === id);
    if (!found) throw new Error(`Invalid download id ${String(raw)}`);
    return found;
  };
  const h = (name: string, fn: (event: { extension?: { id: string } }, ...args: unknown[]) => unknown, permission = "downloads"): void =>
    host.handle(`downloads.${name}`, (event, ...args) => fn(event as { extension?: { id: string } }, ...args), permission);

  h("download", async (event, raw) => {
    const extensionId = event.extension?.id;
    if (!extensionId) throw new Error("Only extensions can use chrome.downloads.");
    const o = obj(raw);
    const url = str(o.url);
    if (!url) throw new Error("Invalid URL.");
    if ((o.method !== undefined && o.method !== "GET") || o.body !== undefined || (Array.isArray(o.headers) && o.headers.length > 0)) {
      throw new Error("Only GET downloads without extra headers are supported.");
    }
    const filename = str(o.filename);
    const id = await access.download(extensionId, url, { ...(filename !== undefined ? { filename } : {}), saveAs: o.saveAs === true });
    return ids.number(id);
  });
  h("search", (_event, query) => searchDownloads(items(access.list()), toDownloadQuery(query)));
  h("pause", (_event, id) => {
    const r = record(id);
    if (r.state !== "progressing" && r.state !== "paused") throw new Error("Download must be in progress");
    access.act(r.id, "pause");
  });
  h("resume", (_event, id) => {
    const r = record(id);
    if (r.state !== "paused" && r.state !== "interrupted" && r.state !== "progressing") throw new Error("Download must be in progress");
    if (r.state !== "progressing") access.act(r.id, "resume");
  });
  h("cancel", (_event, id) => {
    const r = record(id);
    if (r.state === "progressing" || r.state === "paused") access.act(r.id, "cancel");
    else if (r.state === "blocked") access.act(r.id, "discard");
  });
  h("erase", (_event, query) => {
    const matches = searchDownloads(items(access.list()), toDownloadQuery(query));
    for (const m of matches) {
      const id = ids.id(m.id);
      if (id) access.act(id, "remove");
    }
    return matches.map((m) => m.id);
  });
  h(
    "open",
    (_event, id) => {
      const r = record(id);
      if (r.state !== "completed") throw new Error("Download must be complete");
      if (isExecutableFilename(r.filename)) throw new Error("Programs are opened by the person, from the downloads page.");
      access.act(r.id, "open");
    },
    "downloads.open",
  );
  h("show", (_event, id) => {
    const r = record(id);
    if (r.savePath) access.act(r.id, "show");
    return true;
  });
  h("showDefaultFolder", () => access.showDefaultFolder());
  h("getFileIcon", async (_event, id, options) => {
    const r = record(id);
    if (!r.savePath) throw new Error("Download is not complete");
    return access.fileIcon(r.savePath, num(obj(options).size) === 16 ? "small" : "normal");
  });
  h("acceptDanger", (_event, id) => {
    record(id);
    throw new Error("Blocked programs are kept or discarded by the person, from the downloads page.");
  });
  h("removeFile", () => {
    throw new Error("downloads.removeFile is not supported.");
  });
  h("setUiOptions", () => undefined, "downloads.ui");

  access.onChange((before, after) => {
    for (const e of downloadEvents(items(before), items(after))) host.emit("downloads", `downloads.${e.event}`, ...e.args);
  });
}

/**
 * chrome.commands.getAll with the shortcut each command really has here: the manifest's suggestion
 * for this platform, empty when it is not valid here or clashes with one of Corvus's own.
 */
export function registerCommandApis(host: { intercept(name: string, wrap: (original: RouterCallback) => RouterCallback): void }, platform: string): void {
  host.intercept("commands.getAll", () => (event) => {
    const manifest = (event as { extension?: { manifest?: unknown } }).extension?.manifest;
    const working = new Set(activeShortcuts(manifest, platform).map((c) => c.name));
    return manifestCommands(manifest, platform).map((c) => ({ ...c, shortcut: working.has(c.name) ? c.shortcut : "" }));
  });
}
