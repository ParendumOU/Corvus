import { Menu, app, clipboard, type MenuItemConstructorOptions } from "electron";
import type { Bookmark, GroupId, TabId } from "@corvus/shared";
import { childrenOf } from "../shared/bookmark-tree";
import { NEW_TAB_URL } from "../shared/internal-urls";
import { searchUrl } from "../shared/omnibox";
import type { AppContext } from "./context";
import type { BrowserWindowCtl, TabRuntime } from "./window";

function popup(win: BrowserWindowCtl, template: MenuItemConstructorOptions[], x?: number, y?: number): void {
  Menu.buildFromTemplate(template).popup({
    window: win.win,
    ...(x !== undefined ? { x: Math.round(x) } : {}),
    ...(y !== undefined ? { y: Math.round(y) } : {}),
  });
}

const mod = process.platform === "darwin" ? "Cmd" : "Ctrl";

export function showAppMenu(ctx: AppContext, win: BrowserWindowCtl, x: number, y: number): void {
  const active = win.activeTab();
  const recordingFlow = ctx.flows.isRecording(win);
  const hasWebTab = win.listTabs().some((t) => /^https?:/i.test(t.url));
  const startFlow = (): void => {
    try {
      ctx.flows.startRecording(win);
    } catch {
      // No web tab to record; the item is disabled in that case.
    }
  };
  const zoom = (delta: 1 | -1 | 0): void => win.runCommand({ type: "zoom", delta });
  popup(
    win,
    [
      { label: "New tab", accelerator: `${mod}+T`, click: () => win.runCommand({ type: "new-tab" }) },
      { label: "New window", accelerator: `${mod}+N`, click: () => win.runCommand({ type: "new-window" }) },
      { type: "separator" },
      { label: "History", accelerator: `${mod}+H`, click: () => win.openSingleton("corvus://history/") },
      { label: "Bookmarks manager", click: () => win.openSingleton("corvus://bookmarks/") },
      {
        label: "Show bookmarks bar",
        type: "checkbox",
        accelerator: `${mod}+Shift+B`,
        checked: ctx.settings.get().appearance.showBookmarksBar,
        click: () => win.runCommand({ type: "toggle-bookmarks-bar" }),
      },
      { label: "Downloads", accelerator: process.platform === "darwin" ? "Cmd+Shift+J" : "Ctrl+J", click: () => win.openSingleton("corvus://downloads/") },
      { label: "Extensions", click: () => win.openSingleton("corvus://extensions/") },
      { type: "separator" },
      { label: "Reader mode", accelerator: `${mod}+Shift+R`, enabled: /^https?:/.test(active?.view.webContents.getURL() ?? ""), click: () => ctx.reader.toggle(win) },
      { label: "Reading list", click: () => win.openSingleton("corvus://reading/") },
      { label: "Passwords", click: () => win.openSingleton("corvus://passwords/") },
      { label: "Corvus Assist", accelerator: `${mod}+Shift+A`, click: () => win.runCommand({ type: "toggle-assist" }) },
      { label: "Organize tabs", accelerator: `${mod}+Shift+O`, click: () => win.runCommand({ type: "organize-tabs" }) },
      { label: "Workspaces…", click: () => win.sendCommand({ type: "open-workspaces" }) },
      { label: "Watched pages", click: () => win.openSingleton("corvus://watches/") },
      { label: "Scheduled agents", click: () => win.openSingleton("corvus://schedules/") },
      {
        label: recordingFlow ? "Stop recording & review…" : "Record a new flow",
        enabled: recordingFlow || hasWebTab,
        click: () => {
          if (recordingFlow) {
            ctx.flows.stopRecording(win);
            win.openSingleton("corvus://flows/");
          } else {
            startFlow();
          }
        },
      },
      { label: "Workflows", click: () => win.openSingleton("corvus://flows/") },
      { label: "Agent activity", click: () => ctx.assist.open(win, "agents") },
      { label: "WebScope (security workbench)", click: () => win.openSingleton("corvus://webscope/") },
      { type: "separator" },
      { label: "Find…", accelerator: `${mod}+F`, enabled: Boolean(active), click: () => win.runCommand({ type: "find" }) },
      {
        label: `Zoom (${active ? Math.round(active.view.webContents.getZoomFactor() * 100) : 100}%)`,
        submenu: [
          { label: "Zoom in", accelerator: `${mod}+Plus`, click: () => zoom(1) },
          { label: "Zoom out", accelerator: `${mod}+-`, click: () => zoom(-1) },
          { label: "Reset", accelerator: `${mod}+0`, click: () => zoom(0) },
        ],
      },
      { label: "Print…", enabled: Boolean(active), click: () => active?.view.webContents.print() },
      { label: "Developer tools", accelerator: "F12", enabled: Boolean(active), click: () => win.runCommand({ type: "devtools" }) },
      { type: "separator" },
      { label: "Settings", click: () => win.openSingleton("corvus://settings/") },
      { label: "AI agents (MCP)", click: () => win.openSingleton("corvus://settings/#agents") },
      {
        label: "Check for updates…",
        click: () => {
          win.openSingleton("corvus://settings/#updates");
          void ctx.updater.check();
        },
      },
      { type: "separator" },
      { label: "Exit", click: () => app.quit() },
    ],
    x,
    y,
  );
}

export function showProfileMenu(ctx: AppContext, win: BrowserWindowCtl, x: number, y: number): void {
  const current = win.profile.profile.id;
  const profiles: MenuItemConstructorOptions[] = ctx.profiles.list().map((p) => ({
    label: p.name,
    type: "radio",
    checked: p.id === current,
    click: () => {
      if (p.id === current) return;
      const existing = ctx.windows.forProfile(p.id)[0];
      if (existing) existing.win.focus();
      else ctx.windows.open(p.id);
    },
  }));
  popup(
    win,
    [
      { label: `Signed in as ${win.profile.profile.name}`, enabled: false },
      { type: "separator" },
      ...profiles,
      { type: "separator" },
      { label: "New window for this profile", click: () => ctx.windows.open(current) },
      { label: "Add or manage profiles…", click: () => win.openSingleton("corvus://settings/#profiles") },
    ],
    x,
    y,
  );
}

export function showTabMenu(ctx: AppContext, win: BrowserWindowCtl, tabId: TabId, x: number, y: number): void {
  const tab = win.getTab(tabId);
  if (!tab) return;
  const ids = win.tabIds();
  const index = ids.indexOf(tabId);
  const groupId = win.groupOf(tabId);
  const pinned = win.isPinned(tabId);
  const groups = win.listGroups().filter((g) => g.id !== groupId);
  const splitTargets = win.listTabs().filter((t) => t.id !== tabId);
  popup(
    win,
    [
      { label: "New tab to the right", click: () => win.createTab(NEW_TAB_URL, { index: index + 1, ...(groupId ? { groupId } : {}) }) },
      { type: "separator" },
      { label: "Add tab to new group", enabled: !pinned, click: () => {
          const group = win.createGroup([tabId]);
          if (group) win.sendCommand({ type: "edit-group", groupId: group.id });
        } },
      ...(groups.length > 0 && !pinned
        ? [
            {
              label: "Add tab to group",
              submenu: groups.map((g) => ({ label: g.title || `Unnamed ${g.color} group`, click: () => win.addToGroup([tabId], g.id) })),
            } as MenuItemConstructorOptions,
          ]
        : []),
      ...(groupId ? [{ label: "Remove from group", click: () => win.ungroupTabs([tabId]) }] : []),
      { type: "separator" },
      {
        label: "Split with",
        enabled: splitTargets.length > 0,
        submenu: splitTargets.map((t) => ({
          label: (t.title || t.url || "Untitled tab").slice(0, 60),
          click: () => win.enterSplit(tabId, t.id),
        })),
      },
      ...(win.isSplit() ? [{ label: "Exit split", click: () => win.exitSplit() }] : []),
      { type: "separator" },
      { label: "Reload", click: () => win.reload(tabId) },
      { label: "Duplicate", click: () => win.duplicate(tabId) },
      { label: pinned ? "Unpin" : "Pin", click: () => win.pin(tabId, !pinned) },
      {
        label: tab.view.webContents.isAudioMuted() ? "Unmute site" : "Mute site",
        click: () => tab.view.webContents.setAudioMuted(!tab.view.webContents.isAudioMuted()),
      },
      {
        label: "Watch this page for changes",
        enabled: isWebUrl(tab.url),
        click: () => ctx.monitor.watchTab(win, { url: tab.url, title: tab.title, ...(tab.faviconUrl ? { faviconUrl: tab.faviconUrl } : {}) }),
      },
      { type: "separator" },
      { label: "Close", accelerator: `${mod}+W`, click: () => win.closeTab(tabId) },
      { label: "Close other tabs", enabled: ids.length > 1, click: () => win.closeTabs(ids.filter((id) => id !== tabId)) },
      { label: "Close tabs to the right", enabled: index < ids.length - 1, click: () => win.closeTabs(ids.slice(index + 1)) },
      { type: "separator" },
      { label: "Reopen closed tab", accelerator: `${mod}+Shift+T`, click: () => win.reopenClosed() },
    ],
    x,
    y,
  );
}

export function showGroupMenu(win: BrowserWindowCtl, groupId: GroupId, x: number, y: number): void {
  const group = win.listGroups().find((g) => g.id === groupId);
  if (!group) return;
  const workspace = group.workspaceId ? win.profile.workspaces.get(group.workspaceId) : undefined;
  popup(
    win,
    [
      { label: "Edit group…", click: () => win.sendCommand({ type: "edit-group", groupId }) },
      { label: group.collapsed ? "Expand group" : "Collapse group", click: () => win.updateGroup(groupId, { collapsed: !group.collapsed }) },
      { label: "New tab in group", click: () => win.newTabInGroup(groupId) },
      { type: "separator" },
      {
        label: workspace ? `Update workspace “${workspace.name}”` : "Save group as workspace",
        click: () => void win.saveGroupAsWorkspace(groupId),
      },
      { type: "separator" },
      { label: "Ungroup", click: () => win.ungroup(groupId) },
      { label: "Close group", click: () => win.closeGroup(groupId) },
    ],
    x,
    y,
  );
}

function bookmarkItems(win: BrowserWindowCtl, list: Bookmark[], folderId: string, depth: number): MenuItemConstructorOptions[] {
  const children = childrenOf(list, folderId);
  if (children.length === 0) return [{ label: "(empty)", enabled: false }];
  const items: MenuItemConstructorOptions[] = children.map((b) =>
    b.kind === "folder"
      ? { label: b.title, submenu: depth < 8 ? bookmarkItems(win, list, b.id, depth + 1) : [] }
      : { label: b.title || b.url || "Untitled", click: () => b.url && win.openUrl(b.url, "current") },
  );
  const urls = children.filter((b) => b.kind === "bookmark" && b.url).map((b) => b.url as string);
  if (urls.length > 1) {
    items.push({ type: "separator" }, { label: `Open all (${urls.length})`, click: () => urls.forEach((u) => win.openUrl(u, "background-tab")) });
  }
  return items;
}

export function showBookmarkFolderMenu(win: BrowserWindowCtl, folderId: string, x: number, y: number): void {
  popup(win, bookmarkItems(win, win.profile.bookmarks.list(), folderId, 0), x, y);
}

export function showBookmarkMenu(win: BrowserWindowCtl, bookmarkId: string, x: number, y: number): void {
  const bookmark = win.profile.bookmarks.get(bookmarkId);
  if (!bookmark) return;
  const url = bookmark.url;
  popup(
    win,
    [
      ...(url
        ? ([
            { label: "Open", click: () => win.openUrl(url, "current") },
            { label: "Open in new tab", click: () => win.openUrl(url, "new-tab") },
            { label: "Copy link", click: () => clipboard.writeText(url) },
            { type: "separator" },
          ] as MenuItemConstructorOptions[])
        : bookmark.kind === "folder"
          ? ([{ label: "Open folder", submenu: bookmarkItems(win, win.profile.bookmarks.list(), bookmark.id, 0) }, { type: "separator" }] as MenuItemConstructorOptions[])
          : []),
      { label: "Edit in bookmarks manager", click: () => win.openSingleton("corvus://bookmarks/") },
      { label: "Delete", click: () => win.profile.bookmarks.remove(bookmarkId) },
    ],
    x,
    y,
  );
}

const isWebUrl = (url: string): boolean => /^https?:/i.test(url);

export function showPageContextMenu(ctx: AppContext, win: BrowserWindowCtl, tab: TabRuntime, params: Electron.ContextMenuParams, offsetY: number): void {
  const wc = tab.view.webContents;
  const items: MenuItemConstructorOptions[] = [];
  const sep = (): void => {
    if (items.length > 0 && items[items.length - 1]?.type !== "separator") items.push({ type: "separator" });
  };
  // Tabs opened from an agent-driven tab stay agent-driven.
  const openInTab = (url: string): void => {
    win.createTab(url, { activate: false, openerId: tab.id, ...(tab.agentControlled ? { agent: true } : {}) });
  };

  if (params.misspelledWord && params.isEditable) {
    for (const suggestion of params.dictionarySuggestions.slice(0, 5)) {
      items.push({ label: suggestion, click: () => wc.replaceMisspelling(suggestion) });
    }
    if (params.dictionarySuggestions.length === 0) items.push({ label: "No spelling suggestions", enabled: false });
    items.push({ label: "Add to dictionary", click: () => wc.session.addWordToSpellCheckerDictionary(params.misspelledWord) });
    sep();
  }
  if (params.linkURL) {
    const link = params.linkURL;
    items.push(
      { label: "Open link in new tab", click: () => openInTab(link) },
      { label: "Open link in new window", enabled: !tab.agentControlled, click: () => win.openInNewWindow(link) },
      { type: "separator" },
      { label: "Save link as…", enabled: isWebUrl(link), click: () => ctx.downloads.saveAs(wc, link) },
      { label: "Copy link address", click: () => clipboard.writeText(link) },
      ...(params.linkText.trim() ? [{ label: "Copy link text", click: () => clipboard.writeText(params.linkText.trim()) }] : []),
    );
    sep();
  }
  if (params.mediaType === "image" && params.srcURL) {
    const src = params.srcURL;
    items.push(
      { label: "Open image in new tab", click: () => openInTab(src) },
      { label: "Save image as…", enabled: /^(https?|data|blob):/i.test(src), click: () => ctx.downloads.saveAs(wc, src) },
      { label: "Copy image", click: () => wc.copyImageAt(params.x, params.y) },
      { label: "Copy image address", click: () => clipboard.writeText(src) },
    );
    sep();
  }
  if ((params.mediaType === "video" || params.mediaType === "audio") && params.srcURL) {
    const src = params.srcURL;
    const noun = params.mediaType === "video" ? "video" : "audio";
    items.push(
      { label: `Open ${noun} in new tab`, enabled: isWebUrl(src), click: () => openInTab(src) },
      { label: `Save ${noun} as…`, enabled: isWebUrl(src), click: () => ctx.downloads.saveAs(wc, src) },
      { label: `Copy ${noun} address`, click: () => clipboard.writeText(src) },
    );
    sep();
  }
  if (params.isEditable) {
    items.push(
      { role: "undo", enabled: params.editFlags.canUndo },
      { role: "redo", enabled: params.editFlags.canRedo },
      { type: "separator" },
      { role: "cut", enabled: params.editFlags.canCut },
      { role: "copy", enabled: params.editFlags.canCopy },
      { role: "paste", enabled: params.editFlags.canPaste },
      { role: "selectAll" },
    );
    sep();
  }
  const selection = params.selectionText.trim();
  if (selection) {
    const short = selection.length > 32 ? `${selection.slice(0, 32)}…` : selection;
    if (!params.isEditable) items.push({ role: "copy" });
    items.push({ label: `Search Corvus for “${short}”`, click: () => win.createTab(searchUrl(selection.slice(0, 2000)), { openerId: tab.id }) });
    items.push(
      { label: "Explain with Corvus Assist", click: () => ctx.assist.runSelection(win, tab, "explain", selection) },
      { label: "Translate with Corvus Assist", click: () => ctx.assist.runSelection(win, tab, "translate-selection", selection) },
    );
    sep();
  }
  if (!params.linkURL && !params.isEditable && !selection && params.mediaType === "none") {
    const history = wc.navigationHistory;
    items.push(
      { label: "Back", enabled: history.canGoBack(), click: () => history.goBack() },
      { label: "Forward", enabled: history.canGoForward(), click: () => history.goForward() },
      { label: "Reload", click: () => wc.reload() },
      { type: "separator" },
      { label: "Find…", accelerator: `${mod}+F`, click: () => win.runCommand({ type: "find" }) },
      { label: "Print…", click: () => wc.print() },
      { type: "separator" },
      { label: "Reader mode", accelerator: `${mod}+Shift+R`, enabled: /^https?:/.test(wc.getURL()), click: () => ctx.reader.toggle(win) },
      { label: "Summarize this page", enabled: /^https?:/.test(wc.getURL()), click: () => ctx.assist.runPage(win, tab, "summarize") },
      { label: "Translate this page", enabled: /^https?:/.test(wc.getURL()), click: () => ctx.assist.runPage(win, tab, "translate-page") },
      { label: "Watch this page for changes", enabled: /^https?:/.test(wc.getURL()), click: () => ctx.monitor.watchTab(win, { url: wc.getURL(), title: tab.title, ...(tab.faviconUrl ? { faviconUrl: tab.faviconUrl } : {}) }) },
    );
    sep();
  }
  const inspect: MenuItemConstructorOptions = { label: "Inspect", click: () => wc.inspectElement(params.x, params.y) };
  const extensionItems = win.profile.extensions.getContextMenuItems(wc, params);
  if (extensionItems.length > 0) {
    const menu = Menu.buildFromTemplate(items);
    for (const item of extensionItems) menu.append(item);
    for (const item of Menu.buildFromTemplate([{ type: "separator" }, inspect]).items) menu.append(item);
    menu.popup({ window: win.win, x: params.x, y: params.y + offsetY });
    return;
  }
  items.push(inspect);
  popup(win, items, params.x, params.y + offsetY);
}
