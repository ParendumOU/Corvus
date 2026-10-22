import fs from "node:fs/promises";
import path from "node:path";
import { app, clipboard, dialog, ipcMain, shell, type IpcMainInvokeEvent, type WebContents } from "electron";
import { OTHER_FOLDER_ID } from "../shared/bookmark-tree";
import { countBookmarks, isImportedFolder, parseBookmarkFile, type ImportedNode } from "../shared/bookmark-import";
import type { BookmarkImportResult } from "../shared/ipc";
import { CHROME_RPC, INTERNAL_RPC, type ChromeRpc, type InternalRpc } from "../shared/ipc";
import { internalPageOf, type InternalPage } from "../shared/internal-urls";
import { clampInterval, isWatchableUrl } from "../shared/page-watch";
import type { ScheduleInput } from "../shared/schedule-ipc";
import type { SiteProfileInput, SiteProfileMatch } from "../shared/site-profile-ipc";
import { capAccessLevel } from "../shared/site-profiles";
import { buildSuggestions } from "../shared/suggest";
import { GROUP_COLORS, type GroupPatch } from "../shared/tab-strip";
import type { SecretKey, SettingsPatch } from "../shared/settings";
import { toRecordView } from "./agent-run-store";
import { ANNOTATIONS_INTERNAL_PERMISSIONS, annotationsInternalHandlers, registerAnnotationCapture } from "./ipc-annotations";
import type { AppContext } from "./context";
import { showExtensionMenu } from "./extension-windows";
import { assistChromeHandlers, registerAssistIpc } from "./ipc-assist";
import { BROWSER_INTERNAL_PERMISSIONS, browserChromeHandlers, browserInternalHandlers } from "./ipc-browser";
import { CREDENTIALS_INTERNAL_PERMISSIONS, KEEPASS_INTERNAL_PERMISSIONS, autofillChromeHandlers, credentialsInternalHandlers, keepassInternalHandlers, registerAutofillCapture } from "./ipc-credentials";
import { FLOW_INTERNAL_PERMISSIONS, flowChromeHandlers, flowInternalHandlers, registerFlowCapture } from "./ipc-flow";
import { READING_INTERNAL_PERMISSIONS, readerChromeHandlers, readingInternalHandlers, registerReaderIpc } from "./ipc-reader";
import { PDF_INTERNAL_PERMISSIONS, pdfInternalHandlers } from "./ipc-pdf";
import { SEMANTIC_INTERNAL_PERMISSIONS, semanticChromeHandlers, semanticInternalHandlers } from "./ipc-semantic";
import { WEBSCOPE_INTERNAL_PERMISSIONS, webscopeInternalHandlers } from "./ipc-webscope";
import {
  showAppMenu,
  showBookmarkFolderMenu,
  showBookmarkMenu,
  showGroupMenu,
  showProfileMenu,
  showTabMenu,
} from "./menus";
import type { ProfileRuntime } from "./profiles";
import type { BookmarkStore } from "./stores";
import { registerSplitIpc } from "./split-view";
import type { BrowserWindowCtl } from "./window";

class IpcError extends Error {}

const MAX_IMPORTED_BOOKMARKS = 5000;

/** Recreate an imported bookmark tree under `parentId`, counting leaves and folders added. */
function createImportedTree(store: BookmarkStore, parentId: string, nodes: ImportedNode[], counts: { imported: number; folders: number }): void {
  for (const node of nodes) {
    if (counts.imported >= MAX_IMPORTED_BOOKMARKS) return;
    if (isImportedFolder(node)) {
      if (countBookmarks(node.children) === 0) continue;
      const folder = store.create({ parentId, kind: "folder", title: node.title || "Imported" });
      counts.folders++;
      createImportedTree(store, folder.id, node.children, counts);
    } else if (/^(https?|ftp|file|corvus):/i.test(node.url)) {
      store.create({ parentId, kind: "bookmark", title: node.title || node.url, url: node.url });
      counts.imported++;
    }
  }
}

const str = (value: unknown, name: string, max = 8192): string => {
  if (typeof value !== "string" || value.length > max) throw new IpcError(`Invalid ${name}`);
  return value;
};
const num = (value: unknown, name: string): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new IpcError(`Invalid ${name}`);
  return value;
};
const strArray = (value: unknown, name: string): string[] => {
  if (!Array.isArray(value) || value.length > 500 || !value.every((v) => typeof v === "string")) throw new IpcError(`Invalid ${name}`);
  return value as string[];
};
const optStr = (value: unknown, name: string): string | undefined => (value === undefined || value === null ? undefined : str(value, name));

function groupPatch(value: unknown): GroupPatch {
  if (typeof value !== "object" || value === null) throw new IpcError("Invalid group patch");
  const v = value as Record<string, unknown>;
  const patch: GroupPatch = {};
  if (typeof v.title === "string") patch.title = v.title.slice(0, 80);
  if (typeof v.color === "string" && (GROUP_COLORS as readonly string[]).includes(v.color)) patch.color = v.color as GroupPatch["color"];
  if (typeof v.collapsed === "boolean") patch.collapsed = v.collapsed;
  return patch;
}

type Handlers<T, C> = {
  [K in keyof T]: T[K] extends (...args: infer A) => infer R ? (context: C, ...args: A) => R | Promise<Awaited<R>> : never;
};

// ------------------------------------------------------------------------- chrome UI

function chromeHandlers(ctx: AppContext): Handlers<ChromeRpc, BrowserWindowCtl> {
  return {
    ...browserChromeHandlers(ctx),
    ...assistChromeHandlers(ctx),
    ...readerChromeHandlers(ctx),
    ...autofillChromeHandlers(ctx),
    ...semanticChromeHandlers(ctx),
    ...flowChromeHandlers(ctx),
    "state.get": (w) => w.state(),
    "ui.setChromeHeight": (w, h) => w.setChromeHeight(num(h, "height")),
    "ui.setOverlay": (w, open) => w.setOverlay(open === true),
    "ui.appMenu": (w, x, y) => showAppMenu(ctx, w, num(x, "x"), num(y, "y")),
    "ui.profileMenu": (w, x, y) => showProfileMenu(ctx, w, num(x, "x"), num(y, "y")),
    "ui.tabMenu": (w, id, x, y) => showTabMenu(ctx, w, str(id, "tab"), num(x, "x"), num(y, "y")),
    "ui.groupMenu": (w, id, x, y) => showGroupMenu(w, str(id, "group"), num(x, "x"), num(y, "y")),
    "ui.bookmarkFolderMenu": (w, id, x, y) => showBookmarkFolderMenu(w, str(id, "folder"), num(x, "x"), num(y, "y")),
    "ui.bookmarkMenu": (w, id, x, y) => showBookmarkMenu(w, str(id, "bookmark"), num(x, "x"), num(y, "y")),
    "ui.focusContent": (w) => w.focusContent(),
    "tabs.create": (w, opts) => {
      const o = (opts ?? {}) as { url?: unknown; groupId?: unknown; background?: unknown };
      const url = optStr(o.url, "url") ?? "corvus://newtab/";
      const groupId = optStr(o.groupId, "group");
      return w.createTab(url, { activate: o.background !== true, ...(groupId ? { groupId } : {}) }).id;
    },
    "tabs.close": (w, id) => w.closeTab(str(id, "tab")),
    "tabs.activate": (w, id) => w.activate(str(id, "tab")),
    "tabs.move": (w, id, toIndex, groupId) => w.moveTab(str(id, "tab"), num(toIndex, "index"), groupId === null ? null : str(groupId, "group")),
    "tabs.pin": (w, id, pinned) => w.pin(str(id, "tab"), pinned === true),
    "tabs.navigate": (w, id, input) => w.navigateInput(str(id, "tab"), str(input, "input")),
    "tabs.openUrl": (w, url, disposition) =>
      w.openUrl(str(url, "url"), disposition === "new-tab" || disposition === "background-tab" ? disposition : "current"),
    "tabs.back": (w, id) => w.goBack(str(id, "tab")),
    "tabs.forward": (w, id) => w.goForward(str(id, "tab")),
    "tabs.reload": (w, id) => w.reload(str(id, "tab")),
    "tabs.stop": (w, id) => w.stop(str(id, "tab")),
    "tabs.reopenClosed": (w) => w.reopenClosed(),
    "groups.create": (w, ids) => w.createGroup(strArray(ids, "tabs"))?.id ?? null,
    "groups.update": (w, id, patch) => w.updateGroup(str(id, "group"), groupPatch(patch)),
    "groups.ungroup": (w, id) => w.ungroup(str(id, "group")),
    "groups.close": (w, id) => w.closeGroup(str(id, "group")),
    "groups.move": (w, id, toIndex) => w.moveGroup(str(id, "group"), num(toIndex, "index")),
    "groups.newTab": (w, id) => w.newTabInGroup(str(id, "group")),
    "omnibox.suggest": (w, input) =>
      buildSuggestions(str(input, "input", 2048), w.profile.history.all(), w.profile.bookmarks.list(), Date.now()),
    "bookmarks.toggleActive": (w) => w.toggleBookmark(),
    "profiles.openWindow": (w, id) => {
      const profileId = str(id, "profile");
      const existing = ctx.windows.forProfile(profileId)[0];
      if (existing && existing !== w) existing.win.focus();
      else ctx.windows.open(profileId);
    },
    "extensions.toolbar": (w) => w.profile.extensions.toolbar(),
    "extensions.setPinned": (w, id, pinned) => w.profile.extensions.setPinned(str(id, "id"), pinned === true),
    "extensions.menu": (w, id, x, y) => showExtensionMenu(w, str(id, "id"), num(x, "x"), num(y, "y")),
    "adblock.setEnabled": (w, enabled) => w.setAdblockEnabled(enabled === true),
    "adblock.pauseSite": (w, paused) => w.pauseAdblockSite(paused === true),
    "split.with": (w, tabId) => w.enterSplit(w.activeTab()?.id ?? str(tabId, "tab"), str(tabId, "tab")),
    "split.focus": (w, tabId) => w.focusSplitPane(str(tabId, "tab")),
    "split.exit": (w) => w.exitSplit(),
    "ui.setTabLayout": (_w, layout) => void ctx.settings.update({ appearance: { tabLayout: layout === "vertical" ? "vertical" : "horizontal" } }),
    "ui.setSidebarWidth": (_w, width) => void ctx.settings.update({ appearance: { sidebarWidth: num(width, "width") } }),
    "ui.setSidebarCollapsed": (_w, collapsed) => void ctx.settings.update({ appearance: { sidebarCollapsed: collapsed === true } }),
    "watch.addActive": (w) => ctx.monitor.addActive(w),
    "workspaces.list": (w) => w.profile.workspaces.summaries(),
    "workspaces.saveCurrent": (w, name) => w.profile.workspaces.save(str(name, "name", 120), w.workspaceTabs(), w.listGroups()),
    "workspaces.open": (w, id, mode) =>
      w.openWorkspace(str(id, "id"), mode === "new-window" || mode === "merge" ? mode : "replace"),
    "workspaces.rename": (w, id, name) => w.profile.workspaces.rename(str(id, "id"), str(name, "name", 120)),
    "workspaces.remove": (w, id) => w.profile.workspaces.remove(str(id, "id")),
    "agent.start": (w, task) => ctx.agentRunner.start(w, str(task, "task", 4000)),
    "agent.stop": (w) => ctx.agentRunner.stop(w),
    "agent.pause": (w, paused) => ctx.agentRunner.pause(w, paused === true),
    "agent.approve": (w, decision) => {
      if (decision !== "approve" && decision !== "skip" && decision !== "stop") throw new IpcError("Invalid decision");
      ctx.agentRunner.approve(w, decision);
    },
    "agent.clear": (w) => ctx.agentRunner.clear(w),
  };
}

// ------------------------------------------------------------------------- internal pages

interface InternalContext {
  sender: WebContents;
  page: InternalPage;
  profile: ProfileRuntime;
  window: BrowserWindowCtl | undefined;
}

/** Which internal pages may call which methods. Settings-level powers stay on corvus://settings. */
const PERMISSIONS: Record<keyof InternalRpc, readonly InternalPage[]> = {
  ...BROWSER_INTERNAL_PERMISSIONS,
  ...WEBSCOPE_INTERNAL_PERMISSIONS,
  ...READING_INTERNAL_PERMISSIONS,
  ...CREDENTIALS_INTERNAL_PERMISSIONS,
  ...KEEPASS_INTERNAL_PERMISSIONS,
  ...PDF_INTERNAL_PERMISSIONS,
  ...SEMANTIC_INTERNAL_PERMISSIONS,
  ...FLOW_INTERNAL_PERMISSIONS,
  ...ANNOTATIONS_INTERNAL_PERMISSIONS,
  "search.start": ["search"],
  "search.cancel": ["search"],
  "search.favicons": ["search"],
  "search.engineInfo": ["search", "newtab", "settings"],
  "bookmarks.list": ["bookmarks", "newtab"],
  "bookmarks.create": ["bookmarks"],
  "bookmarks.update": ["bookmarks"],
  "bookmarks.move": ["bookmarks"],
  "bookmarks.remove": ["bookmarks"],
  "history.query": ["history"],
  "history.remove": ["history"],
  "history.clear": ["history"],
  "newtab.data": ["newtab"],
  "settings.get": ["settings", "welcome"],
  "settings.update": ["settings", "welcome"],
  "settings.setSecret": ["settings", "welcome"],
  "settings.testConnection": ["settings", "welcome"],
  "mcp.status": ["settings"],
  "mcp.regenerateToken": ["settings"],
  "mcp.activity": ["settings"],
  "update.status": ["settings"],
  "update.check": ["settings"],
  "update.download": ["settings"],
  "update.install": ["settings"],
  "profiles.list": ["settings"],
  "profiles.create": ["settings"],
  "profiles.rename": ["settings"],
  "profiles.remove": ["settings"],
  "profiles.openWindow": ["settings"],
  "sync.status": ["settings", "devices", "welcome"],
  "sync.generatePhrase": ["settings", "welcome"],
  "sync.enable": ["settings", "welcome"],
  "sync.disable": ["settings"],
  "sync.now": ["settings"],
  "sync.setOptions": ["settings"],
  "sync.devices": ["settings", "devices"],
  "sync.removeDevice": ["settings", "devices"],
  "sync.renameDevice": ["settings", "devices"],
  "sync.revealPhrase": ["settings"],
  "sync.wipe": ["settings"],
  "sync.remoteTabs": ["history"],
  "sync.extensionSuggestions": ["settings"],
  "sync.installExtension": ["settings"],
  "sync.dismissExtension": ["settings"],
  "extensions.list": ["extensions"],
  "extensions.loadUnpacked": ["extensions"],
  "extensions.remove": ["extensions"],
  "extensions.installFromStore": ["extensions"],
  "extensions.setEnabled": ["extensions"],
  "extensions.setPinned": ["extensions"],
  "extensions.openOptions": ["extensions"],
  "extensions.checkUpdates": ["extensions"],
  "extensions.clearErrors": ["extensions"],
  "adblock.get": ["settings", "welcome"],
  "adblock.setEnabled": ["settings", "welcome"],
  "adblock.removeAllowed": ["settings"],
  "adblock.update": ["settings"],
  "clipboard.write": ["settings", "passwords"],
  "watch.list": ["watches"],
  "watch.add": ["watches"],
  "watch.remove": ["watches"],
  "watch.pause": ["watches"],
  "watch.setInterval": ["watches"],
  "watch.checkNow": ["watches"],
  "watch.open": ["watches"],
  "watch.acknowledge": ["watches"],
  "schedule.list": ["schedules"],
  "schedule.add": ["schedules"],
  "schedule.update": ["schedules"],
  "schedule.remove": ["schedules"],
  "schedule.pause": ["schedules"],
  "schedule.runNow": ["schedules"],
  "schedule.cancel": ["schedules"],
  "schedule.approve": ["schedules"],
  "siteProfile.list": ["site-profiles"],
  "siteProfile.add": ["site-profiles"],
  "siteProfile.update": ["site-profiles"],
  "siteProfile.remove": ["site-profiles"],
  "siteProfile.setEnabled": ["site-profiles"],
  "siteProfile.match": ["site-profiles"],
  "agentRuns.list": ["agent-runs"],
  "agentRuns.get": ["agent-runs"],
  "agentRuns.remove": ["agent-runs"],
  "agentRuns.clear": ["agent-runs"],
  "agentRuns.resume": ["agent-runs"],
  "crash.reload": ["crash"],
  "crashReports.openFolder": ["settings"],
  "app.openThirdPartyNotices": ["settings"],
  "crashReports.logPath": ["settings"],
  "onboarding.state": ["settings", "welcome"],
  "onboarding.complete": ["settings", "welcome"],
  "onboarding.importBookmarks": ["welcome"],
};

function scheduleInput(value: unknown): ScheduleInput {
  if (typeof value !== "object" || value === null) throw new IpcError("Invalid schedule");
  const v = value as Record<string, unknown>;
  const input: ScheduleInput = {
    name: str(v.name ?? "", "name", 120),
    task: str(v.task ?? "", "task", 4000),
    kind: v.kind === "interval" ? "interval" : "cron",
  };
  if (typeof v.cron === "string") input.cron = v.cron.slice(0, 120);
  if (typeof v.intervalMinutes === "number") input.intervalMinutes = v.intervalMinutes;
  if (typeof v.maxSteps === "number") input.maxSteps = v.maxSteps;
  return input;
}

function siteProfileInput(value: unknown): SiteProfileInput {
  if (typeof value !== "object" || value === null) throw new IpcError("Invalid site profile");
  const v = value as Record<string, unknown>;
  const access = v.accessCap;
  const position = v.promptPosition;
  return {
    pattern: str(v.pattern ?? "", "pattern", 200),
    label: str(v.label ?? "", "label", 80),
    enabled: v.enabled !== false,
    promptAddendum: str(v.promptAddendum ?? "", "promptAddendum", 2000),
    promptPosition: position === "prepend" ? "prepend" : "append",
    accessCap: access === "read" || access === "standard" || access === "full" ? access : null,
    provider: typeof v.provider === "string" ? (v.provider as SiteProfileInput["provider"]) : null,
    model: typeof v.model === "string" ? v.model.slice(0, 120) : null,
  };
}

function internalHandlers(ctx: AppContext): Handlers<InternalRpc, InternalContext> {
  return {
    ...browserInternalHandlers(ctx),
    ...webscopeInternalHandlers(ctx),
    ...readingInternalHandlers(),
    ...credentialsInternalHandlers(ctx),
    ...keepassInternalHandlers(ctx),
    ...pdfInternalHandlers(ctx),
    ...semanticInternalHandlers(ctx),
    ...flowInternalHandlers(ctx),
    ...annotationsInternalHandlers(ctx),
    "search.start": (c, query, opts) => {
      const o = opts as { depth?: unknown; category?: unknown } | undefined;
      const depth = o?.depth === "deep" ? "deep" : "quick";
      const category = o?.category === "news" || o?.category === "images" || o?.category === "videos" ? o.category : "general";
      return ctx.search.start(c.sender, str(query, "query", 2048), depth, category);
    },
    "search.favicons": (_c, domains) => ctx.search.favicons(strArray(domains, "domains").slice(0, 40)),
    "search.cancel": (_c, id) => ctx.search.cancel(str(id, "search")),
    "search.engineInfo": () => ctx.search.engineInfo(),
    "bookmarks.list": (c) => c.profile.bookmarks.list(),
    "bookmarks.create": (c, node) => {
      const n = node as Record<string, unknown>;
      const kind = n.kind === "folder" ? "folder" : "bookmark";
      const url = optStr(n.url, "url");
      return c.profile.bookmarks.create({
        parentId: str(n.parentId, "parent"),
        kind,
        title: str(n.title ?? "", "title", 500),
        ...(kind === "bookmark" && url ? { url } : {}),
        ...(typeof n.index === "number" ? { index: n.index } : {}),
      });
    },
    "bookmarks.update": (c, id, patch) => {
      const p = (patch ?? {}) as Record<string, unknown>;
      const title = optStr(p.title, "title");
      const url = optStr(p.url, "url");
      c.profile.bookmarks.update(str(id, "id"), { ...(title !== undefined ? { title } : {}), ...(url !== undefined ? { url } : {}) });
    },
    "bookmarks.move": (c, id, parentId, index) =>
      c.profile.bookmarks.move(str(id, "id"), str(parentId, "parent"), index === undefined ? undefined : num(index, "index")),
    "bookmarks.remove": (c, id) => c.profile.bookmarks.remove(str(id, "id")),
    "history.query": (c, q, offset, limit) =>
      c.profile.history.query(str(q, "query", 512), Math.max(0, num(offset, "offset")), Math.min(500, Math.max(1, num(limit, "limit")))),
    "history.remove": (c, ids) => c.profile.history.remove(strArray(ids, "ids")),
    "history.clear": (c) => c.profile.history.clear(),
    "newtab.data": (c) => ({
      topSites: c.profile.history.top(8),
      recent: c.profile.history.query("", 0, 6).entries,
      profileName: c.profile.profile.name,
      mcpRunning: ctx.mcp.isRunning(),
    }),
    "settings.get": () => ctx.settings.view(),
    "settings.update": (_c, patch) => {
      ctx.settings.update(patch as SettingsPatch);
      return ctx.settings.view();
    },
    "settings.setSecret": (_c, key, value) => {
      if (key !== "anthropicApiKey" && key !== "braveApiKey") throw new IpcError("Unknown secret");
      ctx.settings.setSecret(key as SecretKey, str(value, "value", 4096));
      return ctx.settings.view();
    },
    "settings.testConnection": () => ctx.search.testConnection(),
    "mcp.status": async () => {
      await ctx.mcp.apply();
      return ctx.mcp.status();
    },
    "mcp.regenerateToken": async () => {
      ctx.mcp.regenerateToken();
      await ctx.mcp.apply();
      return ctx.mcp.status();
    },
    "mcp.activity": () => ctx.mcp.recentActivity(),
    "update.status": () => ctx.updater.status(),
    "update.check": async () => {
      await ctx.updater.check();
      return ctx.updater.status();
    },
    "update.download": () => {
      ctx.updater.download();
      return ctx.updater.status();
    },
    "update.install": () => ctx.updater.install(),
    "profiles.list": (c) => ({ profiles: ctx.profiles.list(), current: c.profile.profile.id }),
    "profiles.create": (_c, name) => {
      const profile = ctx.profiles.create(str(name, "name", 200));
      ctx.windows.broadcastState();
      return profile;
    },
    "profiles.rename": (_c, id, name) => {
      ctx.profiles.rename(str(id, "id"), str(name, "name", 200));
      ctx.windows.broadcastState();
    },
    "profiles.remove": async (c, id) => {
      const profileId = str(id, "id");
      const others = ctx.profiles.list().filter((p) => p.id !== profileId);
      const fallback = others[0];
      if (!fallback) throw new IpcError("Cannot delete the only profile");
      const parent = c.window?.win;
      const confirmOptions: Electron.MessageBoxOptions = {
        type: "warning",
        buttons: ["Delete", "Cancel"],
        defaultId: 1,
        cancelId: 1,
        message: "Delete this profile?",
        detail: "Its bookmarks, history, cookies, saved site data and extensions will be removed from this device.",
      };
      const { response } = parent ? await dialog.showMessageBox(parent, confirmOptions) : await dialog.showMessageBox(confirmOptions);
      if (response !== 0) return;
      if (ctx.windows.all().every((w) => w.profile.profile.id === profileId)) ctx.windows.open(fallback.id);
      ctx.windows.closeProfileWindows(profileId);
      await ctx.profiles.remove(profileId);
      ctx.windows.broadcastState();
    },
    "profiles.openWindow": (_c, id) => {
      ctx.windows.open(str(id, "id"));
    },
    "sync.status": (c) => ctx.sync.status(c.profile),
    "sync.generatePhrase": () => ctx.sync.generatePhrase(),
    "sync.enable": (c, opts) => {
      const o = (opts ?? {}) as Record<string, unknown>;
      return ctx.sync.enable(c.profile, {
        serverUrl: str(o.serverUrl, "server URL", 2048),
        phrase: str(o.phrase, "phrase", 1024),
        deviceName: str(o.deviceName ?? "", "device name", 200),
      });
    },
    "sync.disable": (c) => ctx.sync.disable(c.profile),
    "sync.now": (c) => ctx.sync.syncNow(c.profile),
    "sync.setOptions": (c, opts) => {
      const o = (opts ?? {}) as Record<string, unknown>;
      return ctx.sync.setOptions(c.profile, {
        ...(typeof o.intervalMinutes === "number" ? { intervalMinutes: o.intervalMinutes } : {}),
        ...(typeof o.syncServiceUrls === "boolean" ? { syncServiceUrls: o.syncServiceUrls } : {}),
        ...(typeof o.syncWorkflows === "boolean" ? { syncWorkflows: o.syncWorkflows } : {}),
        ...(typeof o.syncSiteMemory === "boolean" ? { syncSiteMemory: o.syncSiteMemory } : {}),
      });
    },
    "sync.devices": (c) => ctx.sync.devices(c.profile),
    "sync.removeDevice": (c, id) => ctx.sync.removeDevice(c.profile, str(id, "device", 64)),
    "sync.renameDevice": (c, name) => ctx.sync.renameDevice(c.profile, str(name, "name", 64)),
    "sync.revealPhrase": (c) => ctx.sync.revealPhrase(c.profile),
    "sync.wipe": (c, confirmation) => ctx.sync.wipe(c.profile, str(confirmation, "confirmation", 64)),
    "sync.remoteTabs": (c) => ctx.sync.remoteTabs(c.profile),
    "sync.extensionSuggestions": (c) => ctx.sync.extensionSuggestions(c.profile),
    "sync.installExtension": (c, id) => ctx.sync.installExtension(c.profile, str(id, "extension", 64)),
    "sync.dismissExtension": (c, id) => ctx.sync.dismissExtension(c.profile, str(id, "extension", 64)),
    "extensions.list": (c) => c.profile.extensions.list(),
    "extensions.loadUnpacked": async (c) => {
      const options: Electron.OpenDialogOptions = { title: "Load unpacked extension", properties: ["openDirectory"] };
      const parent = c.window?.win;
      const result = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options);
      const dir = result.filePaths[0];
      if (result.canceled || !dir) return null;
      return c.profile.extensions.loadUnpacked(dir);
    },
    "extensions.remove": (c, id) => c.profile.extensions.remove(str(id, "id")),
    "extensions.installFromStore": (c, input) => c.profile.extensions.installFromStore(str(input, "extension", 2048), c.window?.win ?? null),
    "extensions.setEnabled": (c, id, enabled) => c.profile.extensions.setEnabled(str(id, "id"), enabled === true),
    "extensions.setPinned": (c, id, pinned) => c.profile.extensions.setPinned(str(id, "id"), pinned === true),
    "extensions.openOptions": (c, id) => c.profile.extensions.openOptions(str(id, "id")),
    "extensions.checkUpdates": (c) => c.profile.extensions.checkForUpdates(),
    "extensions.clearErrors": (c, id) => c.profile.extensions.clearErrors(str(id, "id")),
    "adblock.get": (c) => c.profile.adblock.view(ctx.adblock.listsInfo()),
    "adblock.setEnabled": (c, enabled) => {
      c.profile.adblock.setEnabled(enabled === true);
      return c.profile.adblock.view(ctx.adblock.listsInfo());
    },
    "adblock.removeAllowed": (c, host) => {
      c.profile.adblock.removeAllowed(str(host, "host", 256));
      return c.profile.adblock.view(ctx.adblock.listsInfo());
    },
    "adblock.update": async (c) => c.profile.adblock.view(await ctx.adblock.updateNow()),
    "clipboard.write": (_c, text) => clipboard.writeText(str(text, "text", 16384)),
    "watch.list": (c) => ctx.monitor.storeFor(c.profile).views(),
    "watch.add": (c, url, interval) => {
      const u = str(url, "url", 2048);
      if (!isWatchableUrl(u)) throw new IpcError("Only public http(s) pages can be watched");
      const store = ctx.monitor.storeFor(c.profile);
      const minutes = interval === undefined ? ctx.settings.get().monitor.defaultIntervalMinutes : clampInterval(num(interval, "interval"));
      const watch = store.add({ url: u, title: hostOf(u), intervalMinutes: minutes });
      if (!watch) throw new IpcError("The maximum number of watched pages has been reached");
      ctx.monitor.checkNow(c.profile, watch.id);
      return store.views();
    },
    "watch.remove": (c, id) => {
      ctx.monitor.storeFor(c.profile).remove(str(id, "id"));
      return ctx.monitor.storeFor(c.profile).views();
    },
    "watch.pause": (c, id, paused) => {
      ctx.monitor.storeFor(c.profile).pause(str(id, "id"), paused === true);
      return ctx.monitor.storeFor(c.profile).views();
    },
    "watch.setInterval": (c, id, minutes) => {
      ctx.monitor.storeFor(c.profile).setInterval(str(id, "id"), num(minutes, "interval"));
      return ctx.monitor.storeFor(c.profile).views();
    },
    "watch.checkNow": (c, id) => {
      ctx.monitor.checkNow(c.profile, str(id, "id"));
      return ctx.monitor.storeFor(c.profile).views();
    },
    "watch.open": (c, id, where) => {
      const watch = ctx.monitor.storeFor(c.profile).get(str(id, "id"));
      ctx.monitor.storeFor(c.profile).acknowledge(id as string);
      if (watch && c.window) c.window.openUrl(watch.url, where === "new-tab" ? "new-tab" : "current");
    },
    "watch.acknowledge": (c, id) => {
      ctx.monitor.storeFor(c.profile).acknowledge(id === undefined ? undefined : str(id, "id"));
      return ctx.monitor.storeFor(c.profile).views();
    },
    "schedule.list": (c) => ctx.scheduledAgents.list(c.profile),
    "schedule.add": (c, input) => ctx.scheduledAgents.add(c.profile, scheduleInput(input)),
    "schedule.update": (c, id, input) => ctx.scheduledAgents.update(c.profile, str(id, "id"), scheduleInput(input)),
    "schedule.remove": (c, id) => ctx.scheduledAgents.remove(c.profile, str(id, "id")),
    "schedule.pause": (c, id, paused) => ctx.scheduledAgents.pause(c.profile, str(id, "id"), paused === true),
    "schedule.runNow": (c, id) => ctx.scheduledAgents.runNow(c.profile, str(id, "id")),
    "schedule.cancel": (c, id) => ctx.scheduledAgents.cancel(c.profile, str(id, "id")),
    "schedule.approve": (c, id, decision) => {
      if (decision !== "approve" && decision !== "skip" && decision !== "stop") throw new IpcError("Invalid decision");
      return ctx.scheduledAgents.approve(c.profile, str(id, "id"), decision);
    },
    "siteProfile.list": (c) => c.profile.siteProfiles.list(),
    "siteProfile.add": (c, input) => {
      c.profile.siteProfiles.add(siteProfileInput(input));
      return c.profile.siteProfiles.list();
    },
    "siteProfile.update": (c, id, input) => {
      c.profile.siteProfiles.update(str(id, "id"), siteProfileInput(input));
      return c.profile.siteProfiles.list();
    },
    "siteProfile.remove": (c, id) => {
      c.profile.siteProfiles.remove(str(id, "id"));
      return c.profile.siteProfiles.list();
    },
    "siteProfile.setEnabled": (c, id, enabled) => {
      c.profile.siteProfiles.setEnabled(str(id, "id"), enabled === true);
      return c.profile.siteProfiles.list();
    },
    "siteProfile.match": (c, url): SiteProfileMatch => {
      const target = str(url, "url", 4096);
      const profile = c.profile.siteProfiles.match(target);
      const ai = ctx.settings.get().ai;
      return {
        url: target,
        profile,
        effectiveAccess: capAccessLevel("full", profile?.accessCap ?? null),
        provider: profile?.provider ?? ai.provider,
        model: profile?.model || ai.model,
      };
    },
    "agentRuns.list": (c) => c.profile.agentRuns.views(),
    "agentRuns.get": (c, id) => {
      const run = c.profile.agentRuns.get(str(id, "id"));
      return run ? toRecordView(run) : null;
    },
    "agentRuns.remove": (c, id) => c.profile.agentRuns.remove(str(id, "id")),
    "agentRuns.clear": (c) => c.profile.agentRuns.clear(),
    "agentRuns.resume": (c, id) => ctx.agentRunner.resume(c.window, str(id, "id")),
    "crash.reload": (c) => {
      const found = ctx.windows.byTabWebContents(c.sender);
      if (found) found.window.recoverCrashed(found.tab);
    },
    "crashReports.openFolder": () => ctx.crashReporter.openFolder(),
    "app.openThirdPartyNotices": async () => {
      // Packaged: extraResources next to the app. Development: the file the build writes into out/.
      const file = app.isPackaged ? path.join(process.resourcesPath, "THIRD_PARTY_NOTICES.md") : path.join(app.getAppPath(), "out", "THIRD_PARTY_NOTICES.md");
      try {
        await fs.access(file);
      } catch {
        return "The licence notices were not found. They are generated by the build (pnpm run build).";
      }
      return (await shell.openPath(file)) || null;
    },
    "crashReports.logPath": () => ctx.crashReporter.logFolder(),
    "onboarding.state": () => ({ completed: ctx.settings.get().onboarding.completed }),
    "onboarding.complete": () => {
      ctx.settings.update({ onboarding: { completed: true } });
      return { completed: true };
    },
    "onboarding.importBookmarks": async (c): Promise<BookmarkImportResult> => {
      const options: Electron.OpenDialogOptions = {
        title: "Import bookmarks",
        properties: ["openFile"],
        filters: [
          { name: "Bookmarks export", extensions: ["html", "htm", "json"] },
          { name: "All files", extensions: ["*"] },
        ],
      };
      const parent = c.window?.win;
      const result = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options);
      const file = result.filePaths[0];
      if (result.canceled || !file) return { imported: 0, folders: 0, canceled: true, source: null };
      const base = path.basename(file);
      const content = await fs.readFile(file, "utf8");
      const tree = parseBookmarkFile(base, content);
      if (countBookmarks(tree) === 0) return { imported: 0, folders: 0, canceled: false, source: base };
      const container = c.profile.bookmarks.create({ parentId: OTHER_FOLDER_ID, kind: "folder", title: `Imported from ${base}`.slice(0, 120) });
      const counts = { imported: 0, folders: 0 };
      createImportedTree(c.profile.bookmarks, container.id, tree, counts);
      return { imported: counts.imported, folders: counts.folders, canceled: false, source: base };
    },
  };
}

function hostOf(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

export function registerIpc(ctx: AppContext): void {
  const chrome = chromeHandlers(ctx);
  const internal = internalHandlers(ctx);
  registerAssistIpc(ctx);
  registerReaderIpc(ctx);
  registerAutofillCapture(ctx);
  registerFlowCapture(ctx);
  registerAnnotationCapture(ctx);
  registerSplitIpc();

  ipcMain.handle(CHROME_RPC, (event: IpcMainInvokeEvent, method: unknown, args: unknown) => {
    const window = ctx.windows.byChromeWebContents(event.sender);
    if (!window) throw new IpcError("Unauthorized sender");
    if (typeof method !== "string" || !Object.hasOwn(chrome, method)) throw new IpcError(`Unknown method ${String(method)}`);
    const handler = chrome[method as keyof ChromeRpc] as (w: BrowserWindowCtl, ...a: unknown[]) => unknown;
    return handler(window, ...(Array.isArray(args) ? args : []));
  });

  ipcMain.handle(INTERNAL_RPC, (event: IpcMainInvokeEvent, method: unknown, args: unknown) => {
    const frame = event.senderFrame;
    if (!frame || frame !== event.sender.mainFrame) throw new IpcError("Unauthorized frame");
    const page = internalPageOf(frame.url);
    if (!page || page === "chrome") throw new IpcError("Unauthorized sender");
    if (typeof method !== "string" || !Object.hasOwn(internal, method)) throw new IpcError(`Unknown method ${String(method)}`);
    if (!PERMISSIONS[method as keyof InternalRpc].includes(page)) throw new IpcError(`${method} is not allowed on corvus://${page}`);
    const found = ctx.windows.byTabWebContents(event.sender);
    const profile = ctx.profiles.bySession(event.sender.session);
    if (!profile) throw new IpcError("Unknown profile");
    const handler = internal[method as keyof InternalRpc] as (c: InternalContext, ...a: unknown[]) => unknown;
    return handler({ sender: event.sender, page, profile, window: found?.window }, ...(Array.isArray(args) ? args : []));
  });
}
