import type { HistoryFilter } from "../shared/history-ops";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { app, clipboard, dialog, ipcMain, safeStorage, shell, type IpcMainInvokeEvent, type WebContents } from "electron";
import type { GroupColor } from "@corvus/shared";
import { BAR_FOLDER_ID, OTHER_FOLDER_ID } from "../shared/bookmark-tree";
import { rejectNote } from "../shared/user-memory";
import { countBookmarks, parseBookmarkFile } from "../shared/bookmark-import";
import { EXTENSION_ID_RE, IMPORT_KINDS, type ImportKind, type ImportScan } from "../shared/browser-import";
import { SHOWN_COMMAND_RECENTS } from "../shared/command-history";
import { PROXY_KINDS, type ConnectionChoice } from "../shared/connections";
import { parsePasswordCsv } from "../shared/password-import";
import { isBigChange } from "../shared/backup-reminder";
import type { BookmarkImportResult, ConnectionsView, PasswordImportResult } from "../shared/ipc";
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
import { openBookmarkFolder, siteIcons } from "./bookmark-actions";
import { checkConnection, testProxy, type ProxyInput } from "./connections";
import { networkHelp, openNetworkSettings } from "./network-help";
import type { AppContext } from "./context";
import { showExtensionMenu } from "./extension-windows";
import { BundleError, MIN_BUNDLE_PASSWORD } from "./profile-bundle";
import { exportProfile, importProfile } from "./profile-transfer";
import { recordingBytes } from "./dictation-service";
import { assistChromeHandlers, registerAssistIpc } from "./ipc-assist";
import { BROWSER_INTERNAL_PERMISSIONS, browserChromeHandlers, browserInternalHandlers } from "./ipc-browser";
import { CREDENTIALS_INTERNAL_PERMISSIONS, KEEPASS_INTERNAL_PERMISSIONS, autofillChromeHandlers, credentialsInternalHandlers, keepassInternalHandlers, registerAutofillCapture } from "./ipc-credentials";
import { FLOW_INTERNAL_PERMISSIONS, flowChromeHandlers, flowInternalHandlers, registerFlowCapture } from "./ipc-flow";
import { NEWTAB_INTERNAL_PERMISSIONS, newtabInternalHandlers } from "./ipc-newtab";
import { READING_INTERNAL_PERMISSIONS, readerChromeHandlers, readingInternalHandlers, registerReaderIpc } from "./ipc-reader";
import { PDF_INTERNAL_PERMISSIONS, pdfInternalHandlers } from "./ipc-pdf";
import { SEMANTIC_INTERNAL_PERMISSIONS, semanticChromeHandlers, semanticInternalHandlers } from "./ipc-semantic";
import { WEBSCOPE_INTERNAL_PERMISSIONS, webscopeInternalHandlers } from "./ipc-webscope";
import {
  showAppMenu,
  showBookmarkFolderMenu,
  showBookmarkOverflowMenu,
  showBookmarkMenu,
  showGroupMenu,
  showConnectionMenu, showProfileMenu,
  showTabMenu,
} from "./menus";
import type { ProfileRuntime } from "./profiles";
import { registerSplitIpc } from "./split-view";
import type { BrowserWindowCtl } from "./window";
import { tr } from "./menu-i18n";

class IpcError extends Error {}

const str = (value: unknown, name: string, max = 8192): string => {
  if (typeof value !== "string" || value.length > max) throw new IpcError(`Invalid ${name}`);
  return value;
};
const num = (value: unknown, name: string): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new IpcError(`Invalid ${name}`);
  return value;
};
/** A "Clear history" filter from a page: only the known fields, with their types checked. */
function historyFilter(value: unknown): HistoryFilter {
  const v = (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>;
  return {
    ...(typeof v.since === "number" && Number.isFinite(v.since) && v.since > 0 ? { since: v.since } : {}),
    ...(typeof v.query === "string" && v.query.trim() ? { query: v.query.slice(0, 500) } : {}),
    ...(typeof v.site === "string" && v.site.trim() ? { site: v.site.slice(0, 300) } : {}),
  };
}

const strArray = (value: unknown, name: string): string[] => {
  if (!Array.isArray(value) || value.length > 500 || !value.every((v) => typeof v === "string")) throw new IpcError(`Invalid ${name}`);
  return value as string[];
};
const optStr = (value: unknown, name: string): string | undefined => (value === undefined || value === null ? undefined : str(value, name));

/** The "»" menu's icons from the chrome UI: PNG data: URLs by bookmark id; anything else is left out. */
function menuIcons(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null) return {};
  const icons: Record<string, string> = {};
  for (const [id, url] of Object.entries(value as Record<string, unknown>).slice(0, 500)) {
    if (typeof url === "string" && url.length <= 200_000 && url.startsWith("data:image/png;base64,")) icons[id] = url;
  }
  return icons;
}

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
    "dictation.transcribe": (_w, audio, mimeType) => ctx.dictation.transcribe(recordingBytes(audio), str(mimeType, "type", 200)),
    "ui.setChromeHeight": (w, h) => w.setChromeHeight(num(h, "height")),
    "ui.setOverlay": (w, open) => w.setOverlay(open === true),
    "ui.appMenu": (w, x, y) => showAppMenu(ctx, w, num(x, "x"), num(y, "y")),
    "ui.profileMenu": (w, x, y) => showProfileMenu(ctx, w, num(x, "x"), num(y, "y")),
    "ui.connectionMenu": (w, x, y) => showConnectionMenu(w, num(x, "x"), num(y, "y")),
    "ui.tabMenu": (w, id, x, y) => showTabMenu(ctx, w, str(id, "tab"), num(x, "x"), num(y, "y")),
    "ui.groupMenu": (w, id, x, y) => showGroupMenu(w, str(id, "group"), num(x, "x"), num(y, "y")),
    "dialog.answer": (w, id, button, checked, value, values, choice) =>
      ctx.dialogs.answer(w, str(id, "dialog", 64), {
        button: num(button, "button"),
        checked: checked === true,
        value: typeof value === "string" ? value : "",
        ...(values === undefined || values === null ? {} : { values: strArray(values, "values") }),
        ...(choice === undefined ? {} : { choice: num(choice, "choice") }),
      }),
    "ui.bookmarkFolderMenu": (w, id, x, y) => showBookmarkFolderMenu(ctx, w, str(id, "folder"), num(x, "x"), num(y, "y")),
    "ui.bookmarkOverflowMenu": (w, from, x, y, icons) => showBookmarkOverflowMenu(ctx, w, num(from, "index"), num(x, "x"), num(y, "y"), menuIcons(icons)),
    "ui.bookmarkMenu": (w, id, x, y) => showBookmarkMenu(ctx, w, str(id, "bookmark"), num(x, "x"), num(y, "y")),
    "ui.focusContent": (w) => w.focusContent(),
    "ui.keyboardElsewhere": (w) => {
      if (w.chrome.webContents.isFocused()) return false;
      const page = w.activeTab()?.view.webContents as WebContents | undefined;
      return Boolean(page && !page.isDestroyed() && page.isFocused()) || w.win.isFocused();
    },
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
    "tabs.home": (w, id, inNewTab) => w.home(str(id, "tab"), inNewTab === true),
    "tabs.stop": (w, id) => w.stop(str(id, "tab")),
    "tabs.reopenClosed": (w) => w.reopenClosed(),
    "groups.create": (w, ids) => w.createGroup(strArray(ids, "tabs"))?.id ?? null,
    "groups.update": (w, id, patch) => w.updateGroup(str(id, "group"), groupPatch(patch)),
    "groups.ungroup": (w, id) => w.ungroup(str(id, "group")),
    "groups.close": (w, id) => w.closeGroup(str(id, "group")),
    "groups.move": (w, id, toIndex) => w.moveGroup(str(id, "group"), num(toIndex, "index")),
    "groups.newTab": (w, id) => w.newTabInGroup(str(id, "group")),
    "omnibox.suggest": (w, input) =>
      buildSuggestions(str(input, "input", 2048), w.profile.history.all(), w.profile.bookmarks.list(), Date.now(), w.profile.siteSearch.list()),
    "bookmarks.toggleActive": (w) => w.toggleBookmark(),
    "translate.toggle": (w) => ctx.translate.toggle(w),
    "bookmarks.addToBar": (w, url, title, index) => {
      const target = str(url, "url", 8192);
      if (!/^(https?|file):/i.test(target)) return false;
      w.profile.bookmarks.create({
        parentId: BAR_FOLDER_ID,
        kind: "bookmark",
        title: str(title ?? "", "title", 500).trim() || target,
        url: target,
        index: Math.max(0, Math.floor(num(index, "index"))),
      });
      return true;
    },
    "bookmarks.move": (w, id, parentId, index) =>
      w.profile.bookmarks.move(str(id, "id"), str(parentId, "parent"), index === undefined ? undefined : Math.max(0, Math.floor(num(index, "index")))),
    "bookmarks.openFolder": (w, id) => openBookmarkFolder(ctx, w, str(id, "folder")),
    "bookmarks.siteIcons": (w, urls) => siteIcons(w, strArray(urls, "urls")),
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
    "adblock.youtubeBlockAgain": (w) => w.endYouTubeFallback(),
    "adblock.forgetOnClose": (w, forget) => w.forgetSiteOnClose(forget === true),
    "adblock.allowCookieBanner": (w, allowed) => w.allowCookieBanner(allowed === true),
    "adblock.pickElement": (w) => {
      const tab = w.activeTab();
      if (tab) void ctx.adblock.pickElement(w, tab);
    },
    "split.with": (w, tabId) => w.enterSplit(w.activeTab()?.id ?? str(tabId, "tab"), str(tabId, "tab")),
    "split.focus": (w, tabId) => w.focusSplitPane(str(tabId, "tab")),
    "split.exit": (w) => w.exitSplit(),
    "ui.setTabLayout": (_w, layout) => void ctx.settings.update({ appearance: { tabLayout: layout === "vertical" ? "vertical" : "horizontal" } }),
    "ui.setSidebarWidth": (_w, width) => void ctx.settings.update({ appearance: { sidebarWidth: num(width, "width") } }),
    "ui.setSidebarCollapsed": (_w, collapsed) => void ctx.settings.update({ appearance: { sidebarCollapsed: collapsed === true } }),
    "watch.addActive": (w) => ctx.monitor.addActive(w),
    "workspaces.list": (w) => w.workspaceViews(),
    "workspaces.saveCurrent": (w, name) => {
      w.profile.workspaces.save(str(name, "name", 120), w.workspaceTabs(), w.listGroups());
      return w.workspaceViews();
    },
    "workspaces.saveGroup": (w, groupId) => {
      w.saveGroupAsWorkspace(str(groupId, "group"));
      return w.workspaceViews();
    },
    "workspaces.open": (w, id) => void w.openWorkspace(str(id, "id")),
    "workspaces.rename": (w, id, name) => {
      const wsId = str(id, "id");
      w.profile.workspaces.rename(wsId, str(name, "name", 120));
      for (const win of ctx.windows.forProfile(w.profile.profile.id)) win.workspaceChanged(wsId);
      return w.workspaceViews();
    },
    "workspaces.remove": (w, id) => {
      const wsId = str(id, "id");
      w.profile.workspaces.remove(wsId);
      for (const win of ctx.windows.forProfile(w.profile.profile.id)) win.workspaceChanged(wsId);
      return w.workspaceViews();
    },
    "agent.start": (w, task) => ctx.agentRunner.start(w, str(task, "task", 4000)),
    "commands.recent": (w) => (ctx.settings.get().agent.rememberCommands ? w.profile.commands.list().slice(0, SHOWN_COMMAND_RECENTS) : []),
    "commands.remember": (w, kind, text) => {
      if (kind !== "agent" && kind !== "search" && kind !== "url") throw new IpcError("Invalid kind");
      const value = str(text, "text", 4000);
      if (ctx.settings.get().agent.rememberCommands) w.profile.commands.add(kind, value);
    },
    "commands.forget": (w, id) => {
      w.profile.commands.remove(str(id, "id", 64));
      return w.profile.commands.list().slice(0, SHOWN_COMMAND_RECENTS);
    },
    "agent.stop": (w) => ctx.agentRunner.stop(w),
    "agent.pause": (w, paused) => ctx.agentRunner.pause(w, paused === true),
    "agent.approve": (w, decision) => {
      if (decision !== "approve" && decision !== "skip" && decision !== "stop") throw new IpcError("Invalid decision");
      ctx.agentRunner.approve(w, decision);
    },
    "agent.clear": (w) => ctx.agentRunner.clear(w),
    "agent.focus": (w, id) => ctx.agentRunner.focus(w, str(id, "id", 128)),
    "agent.handBack": (w) => ctx.agentRunner.handBack(w),
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
  ...NEWTAB_INTERNAL_PERMISSIONS,
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
  "history.countMatching": ["history"],
  "history.removeMatching": ["history"],
  "settings.get": ["settings", "welcome"],
  "settings.update": ["settings", "welcome"],
  "settings.setSecret": ["settings", "welcome"],
  "settings.testConnection": ["settings", "welcome"],
  "settings.discoverLocal": ["settings", "welcome"],
  "settings.localModels": ["settings", "welcome"],
  "mcp.status": ["settings"],
  "mcp.regenerateToken": ["settings"],
  "mcp.activity": ["settings"],
  "mcp.activityClear": ["settings"],
  "mcp.activityExport": ["settings"],
  "update.status": ["settings"],
  "update.check": ["settings"],
  "update.download": ["settings"],
  "update.install": ["settings"],
  "profiles.list": ["settings"],
  "profiles.create": ["settings"],
  "profiles.rename": ["settings"],
  "profiles.remove": ["settings"],
  "profiles.export": ["settings"],
  "profiles.import": ["settings"],
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
  "sync.pairingCode": ["settings"],
  "sync.checkServer": ["settings", "welcome"],
  "sync.moveChain": ["settings"],
  "sync.networkHelp": ["settings"],
  "sync.openNetworkSettings": ["settings"],
  "sync.wipe": ["settings"],
  "sync.remoteTabs": ["history"],
  "sync.extensionSuggestions": ["settings"],
  "sync.installExtension": ["settings"],
  "sync.dismissExtension": ["settings"],
  "sync.conflicts": ["settings"],
  "commands.clear": ["settings"],
  "userMemory.list": ["settings"],
  "userMemory.add": ["settings"],
  "userMemory.remove": ["settings"],
  "userMemory.clear": ["settings"],
  "sync.resolveConflict": ["settings"],
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
  "adblock.removeForgetSite": ["settings"],
  "adblock.removeConsentAllowed": ["settings"],
  "phone.status": ["settings"],
  "phone.connect": ["settings"],
  "phone.disconnect": ["settings"],
  "connections.get": ["settings"],
  "connections.saveProxy": ["settings"],
  "connections.removeProxy": ["settings"],
  "connections.setProfile": ["settings"],
  "connections.setContainer": ["settings"],
  "connections.setRules": ["settings"],
  "connections.setWebrtc": ["settings"],
  "connections.check": ["settings"],
  "connections.test": ["settings"],
  "containers.list": ["settings"],
  "containers.add": ["settings"],
  "containers.update": ["settings"],
  "containers.remove": ["settings"],
  "adblock.update": ["settings"],
  "adblock.setOptions": ["settings"],
  "adblock.setUserFilters": ["settings"],
  "clipboard.write": ["settings", "passwords"],
  "watch.list": ["watches"],
  "watch.add": ["watches"],
  "watch.remove": ["watches"],
  "watch.pause": ["watches"],
  "watch.setInterval": ["watches"],
  "watch.setCondition": ["watches"],
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
  "agentRuns.shots": ["agent-runs"],
  "crash.reload": ["crash"],
  "certError.proceed": ["cert-error"],
  "certError.back": ["cert-error"],
  "crashReports.openFolder": ["settings"],
  "app.openThirdPartyNotices": ["settings"],
  "crashReports.logPath": ["settings"],
  "onboarding.state": ["settings", "welcome"],
  "onboarding.complete": ["settings", "welcome"],
  "onboarding.importBookmarks": ["welcome"],
  "import.scan": ["settings", "welcome"],
  "import.run": ["settings", "welcome"],
  "import.passwordCsv": ["settings", "welcome"],
  "import.installExtension": ["settings", "welcome"],
  "liveHistory.view": ["settings"],
  "liveHistory.set": ["settings"],
  "liveHistory.forget": ["settings"],
  "siteSearch.list": ["settings"],
  "siteSearch.save": ["settings"],
  "siteSearch.remove": ["settings"],
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
    ...newtabInternalHandlers(ctx),
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
    "history.countMatching": (c, filter) => c.profile.history.countMatching(historyFilter(filter)),
    "history.removeMatching": (c, filter) => c.profile.history.removeMatching(historyFilter(filter)),
    "settings.get": () => ctx.settings.view(),
    "settings.update": (_c, patch) => {
      ctx.settings.update(patch as SettingsPatch);
      return ctx.settings.view();
    },
    "settings.setSecret": (_c, key, value) => {
      if (key !== "anthropicApiKey" && key !== "braveApiKey" && key !== "transcriptionApiKey") throw new IpcError("Unknown secret");
      ctx.settings.setSecret(key as SecretKey, str(value, "value", 4096));
      return ctx.settings.view();
    },
    "settings.testConnection": () => ctx.search.testConnection(),
    "settings.discoverLocal": () => ctx.search.discoverLocal(),
    "settings.localModels": () => ctx.search.localModels(),
    "mcp.status": async () => {
      await ctx.mcp.apply();
      return ctx.mcp.status();
    },
    "mcp.regenerateToken": async () => {
      ctx.mcp.regenerateToken();
      await ctx.mcp.apply();
      return ctx.mcp.status();
    },
    "mcp.activity": (_c, query) => {
      const q = (query ?? {}) as Record<string, unknown>;
      return ctx.mcp.activityView({
        ...(typeof q.limit === "number" ? { limit: q.limit } : {}),
        ...(typeof q.offset === "number" ? { offset: q.offset } : {}),
        ...(typeof q.client === "string" && q.client ? { client: q.client.slice(0, 100) } : {}),
        ...(q.problemsOnly === true ? { problemsOnly: true } : {}),
      });
    },
    "mcp.activityClear": () => ctx.mcp.audit.clear(),
    "mcp.activityExport": async (c) => {
      const options: Electron.SaveDialogOptions = {
        title: "Export AI agent activity",
        defaultPath: `corvus-agent-activity-${new Date().toISOString().slice(0, 10)}.csv`,
        filters: [{ name: "CSV", extensions: ["csv"] }],
      };
      const parent = c.window?.win;
      const { canceled, filePath } = parent ? await dialog.showSaveDialog(parent, options) : await dialog.showSaveDialog(options);
      if (canceled || !filePath) return false;
      await fs.writeFile(filePath, ctx.mcp.audit.csv());
      return true;
    },
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
    "profiles.export": async (c, id, password) => {
      const runtime = ctx.profiles.get(str(id, "id"));
      const secret = str(password, "password", 1024);
      if (secret.length < MIN_BUNDLE_PASSWORD) throw new IpcError(`Use a password of at least ${MIN_BUNDLE_PASSWORD} characters.`);
      const options: Electron.SaveDialogOptions = {
        title: "Export profile",
        defaultPath: `${runtime.profile.name.replace(/[\\/:*?"<>|]+/g, "-") || "profile"}.corvus-profile`,
        filters: [{ name: "Corvus profile", extensions: ["corvus-profile"] }],
      };
      const parent = c.window?.win;
      const { canceled, filePath } = parent ? await dialog.showSaveDialog(parent, options) : await dialog.showSaveDialog(options);
      if (canceled || !filePath) return false;
      exportProfile(ctx, runtime, secret, filePath);
      return true;
    },
    "profiles.import": async (c, password) => {
      const secret = str(password, "password", 1024);
      const options: Electron.OpenDialogOptions = { title: "Import profile", properties: ["openFile"], filters: [{ name: "Corvus profile", extensions: ["corvus-profile"] }] };
      const parent = c.window?.win;
      const { canceled, filePaths } = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options);
      const file = filePaths[0];
      if (canceled || !file) return null;
      try {
        const profile = importProfile(ctx, file, secret);
        ctx.windows.broadcastState();
        return profile;
      } catch (err) {
        throw new IpcError(err instanceof BundleError ? err.message : `Could not import the profile: ${(err as Error).message}`);
      }
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
      const { button } = await ctx.dialogs.ask(
        {
          tone: "danger",
          title: tr("Delete this profile?"),
          message: tr("Delete this profile?"),
          detail: tr("Its bookmarks, history, cookies, saved site data and extensions will be removed from this device."),
          buttons: [tr("Cancel"), tr("Delete")],
          defaultId: 0,
          cancelId: 0,
          dangerId: 1,
        },
        c.window,
      );
      if (button !== 1) return;
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
      const o = (opts ?? {}) as unknown as Record<string, unknown>;
      return ctx.sync.enable(c.profile, {
        ...(o.mode === "local" || o.mode === "custom" ? { mode: o.mode } : {}),
        ...(o.serverUrl === undefined || o.serverUrl === null || o.serverUrl === "" ? {} : { serverUrl: str(o.serverUrl, "server URL", 2048) }),
        phrase: str(o.phrase, "phrase", 1024),
        deviceName: str(o.deviceName ?? "", "device name", 200),
      });
    },
    "sync.checkServer": (_c, url) => ctx.sync.checkServer(str(url, "server URL", 2048)),
    "sync.moveChain": (c, target) => {
      const t = (target ?? {}) as Record<string, unknown>;
      if (t.mode === "local") return ctx.sync.moveChain(c.profile, { mode: "local" });
      if (t.mode === "custom") return ctx.sync.moveChain(c.profile, { mode: "custom", serverUrl: str(t.serverUrl, "server URL", 2048) });
      throw new Error("Unknown sync target");
    },
    "sync.networkHelp": () => networkHelp(),
    "sync.openNetworkSettings": (_c, which) => openNetworkSettings(which === "firewall" ? "firewall" : "network"),
    "sync.disable": (c) => ctx.sync.disable(c.profile),
    "sync.now": (c) => ctx.sync.syncNow(c.profile),
    "sync.setOptions": (c, opts) => {
      const o = (opts ?? {}) as Record<string, unknown>;
      return ctx.sync.setOptions(c.profile, {
        ...(typeof o.intervalMinutes === "number" ? { intervalMinutes: o.intervalMinutes } : {}),
        ...(typeof o.syncServiceUrls === "boolean" ? { syncServiceUrls: o.syncServiceUrls } : {}),
        ...(typeof o.syncWorkflows === "boolean" ? { syncWorkflows: o.syncWorkflows } : {}),
        ...(typeof o.syncCommandHistory === "boolean" ? { syncCommandHistory: o.syncCommandHistory } : {}),
        ...(typeof o.syncAssistHistory === "boolean" ? { syncAssistHistory: o.syncAssistHistory } : {}),
        ...(typeof o.syncSiteMemory === "boolean" ? { syncSiteMemory: o.syncSiteMemory } : {}),
      });
    },
    "sync.devices": (c) => ctx.sync.devices(c.profile),
    "sync.removeDevice": (c, id) => ctx.sync.removeDevice(c.profile, str(id, "device", 64)),
    "sync.renameDevice": (c, name) => ctx.sync.renameDevice(c.profile, str(name, "name", 64)),
    "sync.revealPhrase": (c) => ctx.sync.revealPhrase(c.profile),
    "sync.pairingCode": (c, address) => ctx.sync.pairingCode(c.profile, address === undefined || address === null ? undefined : str(address, "address", 300)),
    "sync.wipe": (c, confirmation) => ctx.sync.wipe(c.profile, str(confirmation, "confirmation", 64)),
    "sync.remoteTabs": (c) => ctx.sync.remoteTabs(c.profile),
    "sync.extensionSuggestions": (c) => ctx.sync.extensionSuggestions(c.profile),
    "sync.installExtension": (c, id) => ctx.sync.installExtension(c.profile, str(id, "extension", 64)),
    "sync.dismissExtension": (c, id) => ctx.sync.dismissExtension(c.profile, str(id, "extension", 64)),
    "sync.conflicts": (c) => ctx.sync.conflicts(c.profile),
    "commands.clear": (c) => c.profile.commands.clear(),
    "userMemory.list": (c) => c.profile.userMemory.list(),
    "userMemory.add": (c, note) => {
      const text = str(note, "note", 200);
      const reason = rejectNote(text.replace(/\s+/g, " ").trim());
      if (reason) return { notes: c.profile.userMemory.list(), error: reason };
      c.profile.userMemory.add(text);
      return { notes: c.profile.userMemory.list(), error: null };
    },
    "userMemory.remove": (c, id) => {
      c.profile.userMemory.remove(str(id, "id", 128));
      return c.profile.userMemory.list();
    },
    "userMemory.clear": (c) => {
      c.profile.userMemory.clear();
      return c.profile.userMemory.list();
    },
    "sync.resolveConflict": (c, id, keep) => {
      if (keep !== "mine" && keep !== "theirs") throw new IpcError("keep must be mine or theirs");
      return ctx.sync.resolveConflict(c.profile, str(id, "id", 64), keep);
    },
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
    "phone.status": () => ctx.telegram.status(),
    "phone.connect": (_c, token) => ctx.telegram.connect(token === undefined || token === null ? undefined : str(token, "token", 200)),
    "phone.disconnect": () => ctx.telegram.disconnect(),
    "connections.get": (c) => connectionsView(c.profile),
    "connections.saveProxy": (c, input, id) => {
      c.profile.connections.saveProxy(proxyInput(input), id === undefined || id === null ? undefined : str(id, "id", 64));
      return connectionsView(c.profile);
    },
    "connections.removeProxy": (c, id) => {
      c.profile.connections.removeProxy(str(id, "id", 64));
      return connectionsView(c.profile);
    },
    "connections.setProfile": (c, choice) => {
      c.profile.connections.setProfileChoice(connectionChoice(choice));
      return connectionsView(c.profile);
    },
    "connections.setContainer": (c, containerId, choice) => {
      const id = str(containerId, "container", 64);
      if (!c.profile.containers.get(id)) throw new IpcError("No such container");
      c.profile.connections.setContainerChoice(id, choice === null || choice === undefined ? null : connectionChoice(choice));
      return connectionsView(c.profile);
    },
    "connections.setRules": (c, rules) => {
      if (!Array.isArray(rules) || rules.length > 200) throw new IpcError("Invalid rules");
      c.profile.connections.setRules(rules.map((r) => ({ pattern: str((r as { pattern?: unknown })?.pattern, "pattern", 255), via: str((r as { via?: unknown })?.via, "via", 64) })));
      return connectionsView(c.profile);
    },
    "connections.setWebrtc": (c, on) => {
      c.profile.connections.setWebrtcProtection(on === true);
      return connectionsView(c.profile);
    },
    "connections.check": async (c, containerId) => {
      const id = containerId === undefined || containerId === null ? null : str(containerId, "container", 64);
      if (id && !c.profile.containers.get(id)) throw new IpcError("No such container");
      const ses = id ? c.profile.containerSession(id) : c.profile.session;
      await c.profile.whenConnected(ses);
      return checkConnection(ses, (host, port) => c.profile.proxyCredentials(host, port));
    },
    "connections.test": (c, proxyId) => {
      const id = str(proxyId, "id", 64);
      const proxy = c.profile.connections.config().proxies.find((p) => p.id === id);
      if (!proxy) throw new IpcError("No such proxy");
      return testProxy(proxy, c.profile.connections.password(id), `corvus-proxy-test-${crypto.randomUUID()}`);
    },
    "containers.list": (c) => c.profile.containers.list(),
    "containers.add": (c, name, color) => {
      c.profile.containers.add(str(name, "name", 200), str(color, "color", 20) as GroupColor);
      return c.profile.containers.list();
    },
    "containers.update": (c, id, patch) => {
      const p = (patch ?? {}) as Record<string, unknown>;
      c.profile.containers.update(str(id, "id", 64), {
        ...(typeof p.name === "string" ? { name: str(p.name, "name", 200) } : {}),
        ...(typeof p.color === "string" ? { color: p.color as GroupColor } : {}),
      });
      return c.profile.containers.list();
    },
    "containers.remove": async (c, id) => {
      const containerId = str(id, "id", 64);
      if (!c.profile.containers.get(containerId)) return c.profile.containers.list();
      for (const win of ctx.windows.forProfile(c.profile.profile.id)) win.closeContainerTabs(containerId);
      c.profile.containers.remove(containerId);
      c.profile.connections.setContainerChoice(containerId, null);
      await c.profile.clearContainer(containerId);
      return c.profile.containers.list();
    },
    "adblock.removeForgetSite": (c, site) => {
      c.profile.adblock.setForgetOnClose(str(site, "site", 256), false);
      return c.profile.adblock.view(ctx.adblock.listsInfo());
    },
    "adblock.removeConsentAllowed": (c, site) => {
      c.profile.adblock.setConsentAllowed(str(site, "site", 256), false);
      return c.profile.adblock.view(ctx.adblock.listsInfo());
    },
    "adblock.update": async (c) => c.profile.adblock.view(await ctx.adblock.updateNow()),
    "adblock.setUserFilters": (c, text) => {
      c.profile.adblock.setUserFilters(str(text ?? "", "filters", 1_000_000));
      return c.profile.adblock.view(ctx.adblock.listsInfo());
    },
    "adblock.setOptions": (c, patch) => {
      const p = (patch ?? {}) as Record<string, unknown>;
      c.profile.adblock.setOptions({
        ...(typeof p.annoyances === "boolean" ? { annoyances: p.annoyances } : {}),
        ...(typeof p.cleanUrls === "boolean" ? { cleanUrls: p.cleanUrls } : {}),
        ...(typeof p.fingerprinting === "boolean" ? { fingerprinting: p.fingerprinting } : {}),
        ...(typeof p.cookieConsent === "boolean" ? { cookieConsent: p.cookieConsent } : {}),
        ...(typeof p.gpc === "boolean" ? { gpc: p.gpc } : {}),
      });
      return c.profile.adblock.view(ctx.adblock.listsInfo());
    },
    "clipboard.write": (_c, text) => clipboard.writeText(str(text, "text", 16384)),
    "watch.list": (c) => ctx.monitor.storeFor(c.profile).views(),
    "watch.add": (c, url, interval, condition) => {
      const u = str(url, "url", 2048);
      if (!isWatchableUrl(u)) throw new IpcError("Only public http(s) pages can be watched");
      const store = ctx.monitor.storeFor(c.profile);
      const minutes = interval === undefined ? ctx.settings.get().monitor.defaultIntervalMinutes : clampInterval(num(interval, "interval"));
      const watch = store.add({ url: u, title: hostOf(u), intervalMinutes: minutes });
      if (!watch) throw new IpcError("The maximum number of watched pages has been reached");
      if (typeof condition === "string" && condition.trim()) store.setCondition(watch.id, str(condition, "condition", 1000));
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
    "watch.setCondition": (c, id, condition) => {
      const watchId = str(id, "id");
      ctx.monitor.storeFor(c.profile).setCondition(watchId, str(condition ?? "", "condition", 1000));
      ctx.monitor.checkNow(c.profile, watchId);
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
    "agentRuns.shots": (c, id) => c.profile.agentRuns.shots.list(str(id, "id")),
    "agentRuns.resume": (c, id) => ctx.agentRunner.resume(c.window, str(id, "id")),
    "crash.reload": (c) => {
      const found = ctx.windows.byTabWebContents(c.sender);
      if (found) found.window.recoverCrashed(found.tab);
    },
    "certError.proceed": (c) => {
      const found = ctx.windows.byTabWebContents(c.sender);
      return found ? found.window.proceedPastCertError(found.tab) : false;
    },
    "certError.back": (c) => {
      const found = ctx.windows.byTabWebContents(c.sender);
      if (found) found.window.leaveCertError(found.tab);
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
    "import.scan": async (c): Promise<ImportScan> => {
      const scan = await ctx.browserImport.scan();
      const installed = new Set(c.profile.extensions.list().map((e) => e.id));
      for (const p of scan.sources.flatMap((s) => s.profiles)) for (const e of p.extensions) if (e.id) e.installed = installed.has(e.id);
      return scan;
    },
    "import.installExtension": (c, id) => {
      const extensionId = str(id, "extension", 32);
      if (!EXTENSION_ID_RE.test(extensionId)) throw new IpcError("Invalid extension id");
      return c.profile.extensions.installFromStore(extensionId, c.window?.win ?? null);
    },
    "liveHistory.view": (c) => ctx.liveHistory.view(c.profile),
    "liveHistory.set": (c, patch) => {
      const p = (typeof patch === "object" && patch !== null ? patch : {}) as Record<string, unknown>;
      return ctx.liveHistory.set(c.profile, {
        ...(typeof p.enabled === "boolean" ? { enabled: p.enabled } : {}),
        ...(p.sources !== undefined ? { sources: strArray(p.sources, "sources").map((s) => str(s, "source", 1100)) } : {}),
      });
    },
    "liveHistory.forget": (c, mark) => ctx.liveHistory.forget(c.profile, str(mark, "browser", 64)),
    "siteSearch.list": (c) => c.profile.siteSearch.list(),
    "siteSearch.save": (c, shortcut) => c.profile.siteSearch.save(shortcut),
    "siteSearch.remove": (c, keyword) => c.profile.siteSearch.remove(str(keyword, "keyword", 64)),
    "import.passwordCsv": async (c): Promise<PasswordImportResult> => {
      const options: Electron.OpenDialogOptions = {
        title: "Import passwords from a CSV file",
        properties: ["openFile"],
        filters: [
          { name: "Password export (CSV)", extensions: ["csv"] },
          { name: "All files", extensions: ["*"] },
        ],
      };
      const parent = c.window?.win;
      const picked = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options);
      const file = picked.filePaths[0];
      if (picked.canceled || !file) return { imported: 0, duplicates: 0, skipped: 0, canceled: true };
      const { logins, skipped } = parsePasswordCsv(await fs.readFile(file, "utf8"));
      let imported = 0;
      let duplicates = 0;
      for (const login of logins) {
        if (c.profile.credentials.findByLogin(login.origin, login.username)) {
          duplicates++;
          continue;
        }
        c.profile.credentials.add({ origin: login.origin, username: login.username, password: login.password });
        imported++;
      }
      if (isBigChange(imported)) c.profile.backup.noteBigChange();
      return { imported, duplicates, skipped, canceled: false };
    },
    "import.run": (c, sourceId, profileDir, kinds) => {
      if (!Array.isArray(kinds) || kinds.some((k) => !IMPORT_KINDS.includes(k as ImportKind))) throw new IpcError("Invalid import kinds");
      return ctx.browserImport.run(c.profile, str(sourceId, "browser", 64), str(profileDir, "profile", 1024), kinds as ImportKind[]);
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
      const counts = c.profile.bookmarks.importTree(OTHER_FOLDER_ID, `Imported from ${base}`, tree);
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

function connectionsView(profile: ProfileRuntime): ConnectionsView {
  return { config: profile.connections.config(), containers: profile.containers.list(), keychain: safeStorage.isEncryptionAvailable() };
}

function connectionChoice(raw: unknown): ConnectionChoice {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  if (o.mode === "system" || o.mode === "direct") return { mode: o.mode };
  if (o.mode === "proxy") return { mode: "proxy", proxyId: str(o.proxyId, "proxy", 64) };
  throw new IpcError("Invalid connection");
}

function proxyInput(raw: unknown): ProxyInput {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const kind = PROXY_KINDS.find((k) => k === o.kind);
  if (!kind) throw new IpcError("Invalid proxy type");
  const port = typeof o.port === "number" ? o.port : Number(o.port);
  return {
    name: typeof o.name === "string" ? str(o.name, "name", 60) : "",
    kind,
    host: typeof o.host === "string" ? str(o.host, "host", 255) : "",
    port: Number.isFinite(port) ? port : 0,
    ...(typeof o.pacUrl === "string" && o.pacUrl ? { pacUrl: str(o.pacUrl, "pacUrl", 2000) } : {}),
    ...(typeof o.username === "string" ? { username: str(o.username, "username", 255) } : {}),
    ...(typeof o.password === "string" ? { password: str(o.password, "password", 1000) } : {}),
  };
}
