import { Menu, app, clipboard, type MenuItemConstructorOptions } from "electron";
import type { Bookmark, GroupId, Tab, TabId } from "@corvus/shared";
import { childrenOf } from "../shared/bookmark-tree";
import type { CredentialMatch } from "../shared/credentials";
import { WRITE_ACTIONS, type WriteAction } from "../shared/inline-write";
import { MAX_PANES } from "../shared/split";
import { NEW_TAB_URL } from "../shared/internal-urls";
import { searchUrl } from "../shared/omnibox";
import type { AppContext } from "./context";
import type { BrowserWindowCtl, TabRuntime } from "./window";
import { tr } from "./menu-i18n";

/** One item per container of the profile (with "No container" first when `none` is given). */
function containerItems(win: BrowserWindowCtl, open: (containerId: string | null) => void, opts: { none?: boolean; except?: string | null } = {}): MenuItemConstructorOptions[] {
  const items: MenuItemConstructorOptions[] = win.profile.containers
    .list()
    .filter((c) => c.id !== opts.except)
    .map((c) => ({ label: c.name, click: () => open(c.id) }));
  if (opts.none && opts.except !== null) items.unshift({ label: tr("No container"), click: () => open(null) }, { type: "separator" });
  items.push({ type: "separator" }, { label: tr("Manage containers…"), click: () => win.openSingleton("corvus://settings/#containers") });
  return items;
}

/**
 * Split items of a tab's menu: "Split with" another tab, or for a split of up to four panes "Add
 * to split" / "Remove from split", and "Exit split".
 */
function splitItems(win: BrowserWindowCtl, tabId: TabId, others: Tab[]): MenuItemConstructorOptions[] {
  const panes = win.splitPanes();
  const inSplit = panes.includes(tabId);
  const label = (t: Tab): string => (t.title || t.url || tr("Untitled tab")).slice(0, 60);
  const items: MenuItemConstructorOptions[] = [];
  if (inSplit) {
    const outside = others.filter((t) => !panes.includes(t.id));
    items.push(
      {
        label: tr("Add to split"),
        enabled: outside.length > 0 && panes.length < MAX_PANES,
        submenu: outside.map((t) => ({ label: label(t), click: () => win.addToSplit(t.id) })),
      },
      { label: tr("Remove from split"), click: () => win.removeFromSplit(tabId) },
    );
  } else {
    items.push({
      label: tr("Split with"),
      enabled: others.length > 0,
      submenu: others.map((t) => ({ label: label(t), click: () => win.enterSplit(tabId, t.id) })),
    });
    if (panes.length > 0 && panes.length < MAX_PANES) items.push({ label: tr("Add to split"), click: () => win.addToSplit(tabId) });
  }
  if (panes.length > 0) items.push({ label: tr("Exit split"), click: () => win.exitSplit() });
  return items;
}

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
      { label: tr("New tab"), accelerator: `${mod}+T`, click: () => win.runCommand({ type: "new-tab" }) },
      { label: tr("New window"), accelerator: `${mod}+N`, click: () => win.runCommand({ type: "new-window" }) },
      { label: tr("New container tab"), submenu: containerItems(win, (id) => void win.openInContainer(NEW_TAB_URL, id)) },
      { type: "separator" },
      { label: tr("History"), accelerator: `${mod}+H`, click: () => win.openSingleton("corvus://history/") },
      { label: tr("Bookmarks manager"), click: () => win.openSingleton("corvus://bookmarks/") },
      {
        label: tr("Show bookmarks bar"),
        type: "checkbox",
        accelerator: `${mod}+Shift+B`,
        checked: ctx.settings.get().appearance.showBookmarksBar,
        click: () => win.runCommand({ type: "toggle-bookmarks-bar" }),
      },
      { label: tr("Downloads"), accelerator: process.platform === "darwin" ? "Cmd+Shift+J" : "Ctrl+J", click: () => win.openSingleton("corvus://downloads/") },
      { label: tr("Extensions"), click: () => win.openSingleton("corvus://extensions/") },
      { type: "separator" },
      { label: tr("Reader mode"), accelerator: `${mod}+Shift+R`, enabled: /^https?:/.test(active?.view.webContents.getURL() ?? ""), click: () => ctx.reader.toggle(win) },
      { label: tr("Reading list"), click: () => win.openSingleton("corvus://reading/") },
      { label: tr("Passwords"), click: () => win.openSingleton("corvus://passwords/") },
      { label: tr("Corvus Assist"), accelerator: `${mod}+Shift+A`, click: () => win.runCommand({ type: "toggle-assist" }) },
      { label: tr("Organize tabs"), accelerator: `${mod}+Shift+O`, click: () => win.runCommand({ type: "organize-tabs" }) },
      { label: tr("Workspaces…"), click: () => win.sendCommand({ type: "open-workspaces" }) },
      { label: tr("Watched pages"), click: () => win.openSingleton("corvus://watches/") },
      { label: tr("Scheduled agents"), click: () => win.openSingleton("corvus://schedules/") },
      {
        label: recordingFlow ? tr("Stop recording & review…") : tr("Record a new flow"),
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
      { label: tr("Workflows"), click: () => win.openSingleton("corvus://flows/") },
      { label: tr("Agent activity"), click: () => ctx.assist.open(win, "agents") },
      { label: tr("WebScope (security workbench)"), click: () => win.openSingleton("corvus://webscope/") },
      { type: "separator" },
      { label: tr("Find…"), accelerator: `${mod}+F`, enabled: Boolean(active), click: () => win.runCommand({ type: "find" }) },
      {
        label: tr("Zoom ({percent}%)", { percent: active ? Math.round(active.view.webContents.getZoomFactor() * 100) : 100 }),
        submenu: [
          { label: tr("Zoom in"), accelerator: `${mod}+Plus`, click: () => zoom(1) },
          { label: tr("Zoom out"), accelerator: `${mod}+-`, click: () => zoom(-1) },
          { label: tr("Reset"), accelerator: `${mod}+0`, click: () => zoom(0) },
        ],
      },
      { label: tr("Print…"), enabled: Boolean(active), click: () => active?.view.webContents.print() },
      { label: tr("Developer tools"), accelerator: "F12", enabled: Boolean(active), click: () => win.runCommand({ type: "devtools" }) },
      { type: "separator" },
      { label: tr("Settings"), click: () => win.openSingleton("corvus://settings/") },
      { label: tr("AI agents (MCP)"), click: () => win.openSingleton("corvus://settings/#agents") },
      {
        label: tr("Check for updates…"),
        click: () => {
          win.openSingleton("corvus://settings/#updates");
          void ctx.updater.check();
        },
      },
      { type: "separator" },
      { label: tr("Exit"), click: () => app.quit() },
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
      { label: tr("Signed in as {name}", { name: win.profile.profile.name }), enabled: false },
      { type: "separator" },
      ...profiles,
      { type: "separator" },
      { label: tr("New window for this profile"), click: () => ctx.windows.open(current) },
      { label: tr("Add or manage profiles…"), click: () => win.openSingleton("corvus://settings/#profiles") },
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
      { label: tr("New tab to the right"), click: () => win.createTab(NEW_TAB_URL, { index: index + 1, ...(groupId ? { groupId } : {}) }) },
      { type: "separator" },
      { label: tr("Add tab to new group"), enabled: !pinned, click: () => {
          const group = win.createGroup([tabId]);
          if (group) win.editGroup(group.id);
        } },
      ...(groups.length > 0 && !pinned
        ? [
            {
              label: tr("Add tab to group"),
              submenu: groups.map((g) => ({ label: g.title || tr("Unnamed {color} group", { color: g.color }), click: () => win.addToGroup([tabId], g.id) })),
            } as MenuItemConstructorOptions,
          ]
        : []),
      ...(groupId ? [{ label: tr("Remove from group"), click: () => win.ungroupTabs([tabId]) }] : []),
      { type: "separator" },
      ...splitItems(win, tabId, splitTargets),
      {
        label: tr("Compare tabs with Corvus AI…"),
        enabled: win.listTabs().filter((t) => /^https?:/.test(t.url)).length >= 2,
        click: () => ctx.assist.openCompare(win, tabId),
      },
      { type: "separator" },
      { label: tr("Reload"), click: () => win.reload(tabId) },
      { label: tr("Sleep to save memory"), enabled: tabId !== win.activeTab()?.id && /^https?:/.test(tab.url), click: () => win.sleepTab(tabId) },
      { label: tr("Duplicate"), click: () => win.duplicate(tabId) },
      { label: tr("Send to your phone…"), enabled: /^https?:/.test(tab.url), click: () => void win.shareToPhone(tab.url, tab.title) },
      {
        label: tr("Grab download links"),
        enabled: /^https?:/.test(tab.url),
        click: () => void ctx.grabber.grabTab(win, tabId).then(() => win.openSingleton("corvus://downloads/#grabber")),
      },
      { label: tr("Download with AI"), enabled: /^https?:/.test(tab.url), click: () => ctx.grabber.downloadPageWithAi(win, tabId) },
      {
        label: tr("Reopen in container"),
        enabled: /^https?:/.test(tab.pendingUrl ?? tab.url),
        submenu: containerItems(win, (id) => void win.reopenInContainer(tabId, id), { none: true, except: tab.containerId ?? null }),
      },
      { label: pinned ? tr("Unpin") : tr("Pin"), click: () => win.pin(tabId, !pinned) },
      {
        label: tab.view.webContents.isAudioMuted() ? tr("Unmute site") : tr("Mute site"),
        click: () => tab.view.webContents.setAudioMuted(!tab.view.webContents.isAudioMuted()),
      },
      {
        label: tr("Watch this page for changes"),
        enabled: isWebUrl(tab.url),
        click: () => ctx.monitor.watchTab(win, { url: tab.url, title: tab.title, ...(tab.faviconUrl ? { faviconUrl: tab.faviconUrl } : {}) }),
      },
      { type: "separator" },
      { label: tr("Close"), accelerator: `${mod}+W`, click: () => win.closeTab(tabId) },
      { label: tr("Close other tabs"), enabled: ids.length > 1, click: () => win.closeTabs(ids.filter((id) => id !== tabId)) },
      { label: tr("Close tabs to the right"), enabled: index < ids.length - 1, click: () => win.closeTabs(ids.slice(index + 1)) },
      { type: "separator" },
      { label: tr("Reopen closed tab"), accelerator: `${mod}+Shift+T`, click: () => win.reopenClosed() },
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
      { label: tr("Edit group…"), click: () => win.editGroup(groupId) },
      { label: group.collapsed ? tr("Expand group") : tr("Collapse group"), click: () => win.updateGroup(groupId, { collapsed: !group.collapsed }) },
      { label: tr("New tab in group"), click: () => win.newTabInGroup(groupId) },
      { type: "separator" },
      {
        label: workspace ? tr("Update workspace “{name}”", { name: workspace.name }) : tr("Save group as workspace"),
        click: () => void win.saveGroupAsWorkspace(groupId),
      },
      { type: "separator" },
      { label: tr("Ungroup"), click: () => win.ungroup(groupId) },
      { label: tr("Close group"), click: () => win.closeGroup(groupId) },
    ],
    x,
    y,
  );
}

function bookmarkItems(win: BrowserWindowCtl, list: Bookmark[], folderId: string, depth: number): MenuItemConstructorOptions[] {
  const children = childrenOf(list, folderId);
  if (children.length === 0) return [{ label: tr("(empty)"), enabled: false }];
  const items: MenuItemConstructorOptions[] = children.map((b) =>
    b.kind === "folder"
      ? { label: b.title, submenu: depth < 8 ? bookmarkItems(win, list, b.id, depth + 1) : [] }
      : { label: b.title || b.url || tr("Untitled"), click: () => b.url && win.openUrl(b.url, "current") },
  );
  const urls = children.filter((b) => b.kind === "bookmark" && b.url).map((b) => b.url as string);
  if (urls.length > 1) {
    items.push({ type: "separator" }, { label: tr("Open all ({count})", { count: urls.length }), click: () => urls.forEach((u) => win.openUrl(u, "background-tab")) });
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
            { label: tr("Open"), click: () => win.openUrl(url, "current") },
            { label: tr("Open in new tab"), click: () => win.openUrl(url, "new-tab") },
            { label: tr("Copy link"), click: () => clipboard.writeText(url) },
            { type: "separator" },
          ] as MenuItemConstructorOptions[])
        : bookmark.kind === "folder"
          ? ([{ label: tr("Open folder"), submenu: bookmarkItems(win, win.profile.bookmarks.list(), bookmark.id, 0) }, { type: "separator" }] as MenuItemConstructorOptions[])
          : []),
      { label: tr("Edit in bookmarks manager"), click: () => win.openSingleton("corvus://bookmarks/") },
      { label: tr("Delete"), click: () => win.profile.bookmarks.remove(bookmarkId) },
    ],
    x,
    y,
  );
}

/** The saved logins of a page, under the login field the person clicked; picking one fills it. */
export function showLoginFieldMenu(ctx: AppContext, win: BrowserWindowCtl, matches: CredentialMatch[], x: number, y: number): void {
  popup(
    win,
    [
      ...matches.map(
        (m): MenuItemConstructorOptions => ({
          label: m.username || tr("(no username)"),
          ...(m.source === "keepass" ? { sublabel: m.sourceName || "KeePass" } : {}),
          click: () => void ctx.autofill.fill(win, m.id),
        }),
      ),
      { type: "separator" },
      { label: tr("Manage passwords…"), click: () => win.openSingleton("corvus://passwords/") },
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
  // Tabs opened from an agent-driven tab stay agent-driven, and from a container tab in its container.
  const openInTab = (url: string): void => {
    win.createTab(url, {
      activate: false,
      openerId: tab.id,
      ...(tab.agentControlled ? { agent: true } : {}),
      ...(tab.containerId ? { containerId: tab.containerId } : {}),
    });
  };

  if (params.misspelledWord && params.isEditable) {
    for (const suggestion of params.dictionarySuggestions.slice(0, 5)) {
      items.push({ label: suggestion, click: () => wc.replaceMisspelling(suggestion) });
    }
    if (params.dictionarySuggestions.length === 0) items.push({ label: tr("No spelling suggestions"), enabled: false });
    items.push({ label: tr("Add to dictionary"), click: () => wc.session.addWordToSpellCheckerDictionary(params.misspelledWord) });
    sep();
  }
  if (params.linkURL) {
    const link = params.linkURL;
    items.push(
      { label: tr("Open link in new tab"), click: () => openInTab(link) },
      { label: tr("Open link in new window"), enabled: !tab.agentControlled, click: () => win.openInNewWindow(link) },
      {
        label: tr("Open link in container tab"),
        enabled: !tab.agentControlled && /^https?:/i.test(link),
        submenu: containerItems(win, (id) => void win.openInContainer(link, id, tab.id), { none: true, except: tab.containerId ?? null }),
      },
      { type: "separator" },
      { label: tr("Save link as…"), enabled: isWebUrl(link), click: () => ctx.downloads.saveAs(wc, link) },
      { label: tr("Copy link address"), click: () => clipboard.writeText(link) },
      { label: tr("Send link to your phone…"), enabled: /^https?:/i.test(link), click: () => void win.shareToPhone(link, params.linkText.trim() || link) },
      ...(params.linkText.trim() ? [{ label: tr("Copy link text"), click: () => clipboard.writeText(params.linkText.trim()) }] : []),
    );
    sep();
  }
  if (params.mediaType === "image" && params.srcURL) {
    const src = params.srcURL;
    items.push(
      { label: tr("Open image in new tab"), click: () => openInTab(src) },
      { label: tr("Save image as…"), enabled: /^(https?|data|blob):/i.test(src), click: () => ctx.downloads.saveAs(wc, src) },
      { label: tr("Copy image"), click: () => wc.copyImageAt(params.x, params.y) },
      { label: tr("Copy image address"), click: () => clipboard.writeText(src) },
    );
    sep();
  }
  if ((params.mediaType === "video" || params.mediaType === "audio") && params.srcURL) {
    const src = params.srcURL;
    const video = params.mediaType === "video";
    items.push(
      { label: video ? tr("Open video in new tab") : tr("Open audio in new tab"), enabled: isWebUrl(src), click: () => openInTab(src) },
      { label: video ? tr("Save video as…") : tr("Save audio as…"), enabled: isWebUrl(src), click: () => ctx.downloads.saveAs(wc, src) },
      { label: video ? tr("Copy video address") : tr("Copy audio address"), click: () => clipboard.writeText(src) },
    );
    sep();
  }
  // Writing help in a page's text fields (never password fields: their text never leaves the page).
  if (params.isEditable && params.formControlType !== "input-password" && /^https?:/i.test(wc.getURL()) && !tab.agentControlled) {
    const write = (action: WriteAction): void => void ctx.assist.writeInField(win, tab, action);
    items.push({
      label: tr("Write with Corvus AI"),
      submenu: [
        ...WRITE_ACTIONS.map(({ action, label }) => ({
          label: action === "translate" ? tr("Translate into {language}", { language: ctx.assist.languageName() }) : tr(label),
          click: () => write(action),
        })),
        { type: "separator" },
        { label: tr("Write…"), click: () => write("custom") },
      ],
    });
    sep();
  }
  if (params.isEditable) {
    items.push(
      { role: "undo", label: tr("Undo"), enabled: params.editFlags.canUndo },
      { role: "redo", label: tr("Redo"), enabled: params.editFlags.canRedo },
      { type: "separator" },
      { role: "cut", label: tr("Cut"), enabled: params.editFlags.canCut },
      { role: "copy", label: tr("Copy"), enabled: params.editFlags.canCopy },
      { role: "paste", label: tr("Paste"), enabled: params.editFlags.canPaste },
      { role: "selectAll", label: tr("Select all") },
    );
    sep();
  }
  const selection = params.selectionText.trim();
  if (selection) {
    const short = selection.length > 32 ? `${selection.slice(0, 32)}…` : selection;
    if (!params.isEditable) items.push({ role: "copy", label: tr("Copy") });
    items.push({ label: tr("Search Corvus for “{text}”", { text: short }), click: () => win.createTab(searchUrl(selection.slice(0, 2000)), { openerId: tab.id }) });
    items.push(
      { label: tr("Explain with Corvus Assist"), click: () => ctx.assist.runSelection(win, tab, "explain", selection) },
      { label: tr("Translate with Corvus Assist"), click: () => ctx.assist.runSelection(win, tab, "translate-selection", selection) },
    );
    sep();
  }
  if (!params.linkURL && !params.isEditable && !selection && params.mediaType === "none") {
    const history = wc.navigationHistory;
    items.push(
      { label: tr("Back"), enabled: history.canGoBack(), click: () => history.goBack() },
      { label: tr("Forward"), enabled: history.canGoForward(), click: () => history.goForward() },
      { label: tr("Reload"), click: () => wc.reload() },
      { type: "separator" },
      { label: tr("Find…"), accelerator: `${mod}+F`, click: () => win.runCommand({ type: "find" }) },
      { label: tr("Print…"), click: () => wc.print() },
      { type: "separator" },
      { label: tr("Reader mode"), accelerator: `${mod}+Shift+R`, enabled: /^https?:/.test(wc.getURL()), click: () => ctx.reader.toggle(win) },
      { label: tr("Summarize this page"), enabled: /^https?:/.test(wc.getURL()), click: () => ctx.assist.runPage(win, tab, "summarize") },
      { label: tr("Translate this page"), enabled: /^https?:/.test(wc.getURL()), click: () => void ctx.translate.translate(win, tab) },
      { label: tr("Watch this page for changes"), enabled: /^https?:/.test(wc.getURL()), click: () => ctx.monitor.watchTab(win, { url: wc.getURL(), title: tab.title, ...(tab.faviconUrl ? { faviconUrl: tab.faviconUrl } : {}) }) },
    );
    sep();
  }
  if (/^https?:/.test(wc.getURL()) && !params.isEditable) {
    // params are in window pixels; the picker works in the page's CSS pixels.
    const zoom = wc.getZoomFactor() || 1;
    items.push({ label: tr("Hide this element…"), click: () => void ctx.adblock.pickElement(win, tab, { x: params.x / zoom, y: params.y / zoom }) });
    sep();
  }
  const inspect: MenuItemConstructorOptions = { label: tr("Inspect"), click: () => wc.inspectElement(params.x, params.y) };
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
