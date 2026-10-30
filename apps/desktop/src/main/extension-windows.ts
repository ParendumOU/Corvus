import fs from "node:fs";
import { Menu, View, WebContentsView, app, nativeTheme, shell, webContents as allWebContents, type BaseWindow, type MenuItemConstructorOptions, type WebContents } from "electron";
import { NEW_TAB_URL } from "../shared/internal-urls";
import { parseRemoteSessionId, type ChromeSessionTab, type ClosedTabEntry } from "../shared/chrome-sessions";
import type { GroupPlacement } from "../shared/chrome-tab-groups";
import type { AppContext } from "./context";
import type { DownloadsAccess, SessionsAccess, SidePanelAccess, TabGroupAccess } from "./extension-apis";
import type { TabCreateDetails, TabPlacement } from "./extensions";
import type { ProfileDelegate } from "./profiles";
import { pageOf } from "./tab-page";
import type { BrowserWindowCtl, TabRuntime } from "./window";
import { tr } from "./menu-i18n";

/** Numeric chrome.tabGroups IDs for Corvus group IDs (unique across windows). */
export class GroupIdMap {
  private readonly toNumber = new Map<string, number>();
  private readonly toGroup = new Map<number, string>();

  idFor(group: string): number {
    let id = this.toNumber.get(group);
    if (id === undefined) {
      id = this.toNumber.size + 1;
      this.toNumber.set(group, id);
      this.toGroup.set(id, group);
    }
    return id;
  }

  groupFor(id: number): string | undefined {
    return this.toGroup.get(id);
  }
}

export const extensionGroupIds = new GroupIdMap();

/** Height of the bar above an extension side panel (its name and a close button). */
const PANEL_HEADER_HEIGHT = 32;

const escapeHtml = (text: string): string => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** The bar above a side panel, as a self-contained page: its ✕ sets the title to "close". */
function panelHeader(name: string, closeLabel: string, dark: boolean): string {
  const c = dark ? { bg: "#202124", fg: "#e8eaed", line: "#3c4043", hover: "#3c4043" } : { bg: "#ffffff", fg: "#202124", line: "#dadce0", hover: "#f1f3f4" };
  const label = escapeHtml(closeLabel);
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;height:100%;background:${c.bg};color:${c.fg};font:12.5px system-ui,sans-serif;-webkit-user-select:none;overflow:hidden}
.bar{display:flex;align-items:center;gap:8px;height:100%;box-sizing:border-box;padding:0 6px 0 12px;border-bottom:1px solid ${c.line}}
.name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600}
a{display:flex;align-items:center;justify-content:center;width:24px;height:24px;border-radius:6px;color:${c.fg};text-decoration:none;font-size:17px}
a:hover{background:${c.hover}}
</style></head><body><div class="bar"><span class="name">${escapeHtml(name)}</span><a href="#" onclick="document.title='close';return false" title="${label}" aria-label="${label}">&times;</a></div></body></html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

/**
 * Maps chrome.tabs / chrome.windows requests from extensions onto Corvus windows and tabs,
 * so extension tab IDs are webContents IDs of real Corvus tabs (including agent tabs).
 */
export class ExtensionWindowBridge implements ProfileDelegate {
  constructor(private readonly ctx: AppContext) {}

  private targetWindow(profileId: string, windowId: number | undefined): BrowserWindowCtl | undefined {
    const windows = this.ctx.windows.forProfile(profileId);
    if (windowId !== undefined && windowId >= 0) {
      const byId = windows.find((w) => w.win.id === windowId);
      if (byId) return byId;
    }
    const focused = this.ctx.windows.focused();
    return focused && focused.profile.profile.id === profileId ? focused : windows[0];
  }

  async createTab(profileId: string, details: TabCreateDetails): Promise<[WebContents, BaseWindow]> {
    const url = details.url ?? NEW_TAB_URL;
    const win = this.targetWindow(profileId, details.windowId);
    if (!win) {
      const opened = this.ctx.windows.open(profileId, [url]);
      const tab = opened.activeTab();
      if (!tab) throw new Error("Could not open a window");
      return [tab.view.webContents, opened.win];
    }
    const opener = details.openerTabId !== undefined ? allWebContents.fromId(details.openerTabId) : undefined;
    const openerTab = opener ? win.tabByWebContents(opener) : undefined;
    const tab = win.createTab(url, {
      activate: details.active !== false,
      ...(typeof details.index === "number" && details.index >= 0 ? { index: details.index } : {}),
      ...(details.pinned === true ? { pinned: true } : {}),
      ...(openerTab ? { openerId: openerTab.id } : {}),
    });
    return [tab.view.webContents, win.win];
  }

  selectTab(webContents: WebContents): void {
    const found = this.ctx.windows.byTabWebContents(webContents);
    if (found && !found.window.isQuietExtensionTab(webContents)) found.window.activate(found.tab.id);
  }

  removeTab(webContents: WebContents): void {
    const found = this.ctx.windows.byTabWebContents(webContents);
    found?.window.closeTab(found.tab.id);
  }

  async createWindow(profileId: string, urls: string[]): Promise<BaseWindow> {
    return this.ctx.windows.open(profileId, urls.length > 0 ? urls : undefined).win;
  }

  removeWindow(window: BaseWindow): void {
    this.ctx.windows.all().find((w) => w.win === window)?.close();
  }

  describeTab(webContents: WebContents): TabPlacement | null {
    const found = this.ctx.windows.byTabWebContents(webContents);
    if (!found) return null;
    const { window, tab } = found;
    const group = window.groupOf(tab.id);
    const groupId = group ? extensionGroupIds.idFor(group) : -1;
    return { index: window.tabIds().indexOf(tab.id), pinned: window.isPinned(tab.id), groupId };
  }

  /** chrome.tabGroups over this profile's windows (numeric ids from extensionGroupIds). */
  tabGroups(profileId: string): TabGroupAccess {
    const windows = (): BrowserWindowCtl[] => this.ctx.windows.forProfile(profileId);
    const placements = (): GroupPlacement[] =>
      windows().flatMap((w) => {
        const ids = w.tabIds();
        return w.listGroups().map((group) => ({
          id: extensionGroupIds.idFor(group.id),
          windowId: w.win.id,
          index: ids.findIndex((t) => w.groupOf(t) === group.id),
          windowTabs: ids.length,
          group,
        }));
      });
    const locate = (id: number): { gid: string; win: BrowserWindowCtl } => {
      const gid = extensionGroupIds.groupFor(id);
      const win = gid ? windows().find((w) => w.hasGroup(gid)) : undefined;
      if (!gid || !win) throw new Error(`No group with id: ${id}.`);
      return { gid, win };
    };
    const tabsOf = (tabIds: number[]) =>
      tabIds.map((id) => {
        const wc = allWebContents.fromId(id);
        const found = wc ? this.ctx.windows.byTabWebContents(wc) : undefined;
        if (!found || found.window.profile.profile.id !== profileId) throw new Error(`No tab with id: ${id}.`);
        return found;
      });
    return {
      groups: placements,
      currentWindowId: () => {
        const focused = this.ctx.windows.focused();
        return focused && focused.profile.profile.id === profileId ? focused.win.id : windows()[0]?.win.id;
      },
      update: (id, patch) => {
        const { gid, win } = locate(id);
        win.updateGroup(gid, patch);
      },
      move: (id, index, windowId) => {
        const { gid, win } = locate(id);
        if (windowId !== undefined && windowId !== -2 && windowId !== win.win.id) throw new Error("Moving a group to another window is not supported.");
        win.moveGroup(gid, index);
      },
      group: (tabIds, groupId) => {
        const found = tabsOf(tabIds);
        const target = groupId !== undefined ? locate(groupId) : null;
        const win = target ? target.win : found[0]!.window;
        if (found.some((f) => f.window !== win)) throw new Error("The tabs must be in the group's window.");
        const ids = found.map((f) => f.tab.id);
        if (target && groupId !== undefined) {
          win.addToGroup(ids, target.gid);
          return groupId;
        }
        const created = win.createGroup(ids);
        if (!created) throw new Error("Could not group the tabs.");
        return extensionGroupIds.idFor(created.id);
      },
      ungroup: (tabIds) => {
        for (const f of tabsOf(tabIds)) f.window.ungroupTabs([f.tab.id]);
      },
    };
  }

  /** chrome.sessions over this profile's recently closed tabs and its other devices' tabs (sync). */
  sessions(profileId: string): SessionsAccess {
    const windows = (): BrowserWindowCtl[] => this.ctx.windows.forProfile(profileId);
    const devices = async () => this.ctx.sync.remoteTabs(this.ctx.profiles.get(profileId));
    const asTab = (win: BrowserWindowCtl, tab: TabRuntime | undefined): ChromeSessionTab | null => {
      if (!tab) return null;
      const group = win.groupOf(tab.id);
      return {
        id: tab.view.webContents.id,
        index: win.tabIds().indexOf(tab.id),
        windowId: win.win.id,
        url: tab.url,
        title: tab.title,
        pinned: win.isPinned(tab.id),
        active: win.activeTab()?.id === tab.id,
        highlighted: false,
        incognito: false,
        groupId: group ? extensionGroupIds.idFor(group) : -1,
      };
    };
    const closed = (): ClosedTabEntry[] =>
      windows().flatMap((w) =>
        w.recentlyClosed().flatMap((c) =>
          c.id ? [{ sessionId: c.id, windowId: w.win.id, closedAt: c.closedAt ?? 0, url: c.url, title: c.title, index: c.index, pinned: c.pinned }] : [],
        ),
      );
    return {
      closed,
      devices,
      restore: async (sessionId) => {
        const remote = sessionId ? parseRemoteSessionId(sessionId) : null;
        if (remote) {
          const url = (await devices()).find((d) => d.deviceId === remote.deviceId)?.tabs[remote.index]?.url;
          const win = this.targetWindow(profileId, undefined);
          return url && win ? asTab(win, win.createTab(url, { activate: true })) : null;
        }
        const id = sessionId ?? closed().sort((a, b) => b.closedAt - a.closedAt)[0]?.sessionId;
        if (!id) return null;
        for (const w of windows()) {
          const tab = w.restoreClosedById(id);
          if (tab) return asTab(w, tab);
        }
        return null;
      },
    };
  }

  /** chrome.downloads over this profile's download list (runtime looked up per call: it is still being built here). */
  downloads(profileId: string): DownloadsAccess {
    const runtime = () => this.ctx.profiles.get(profileId);
    return {
      list: () => this.ctx.downloads.list(runtime()),
      download: (extensionId, url, opts) => this.ctx.downloads.downloadForExtension(runtime(), extensionId, url, opts),
      act: (id, action) => this.ctx.downloads.act(runtime(), id, action),
      showDefaultFolder: () => {
        const dir = this.ctx.downloads.directory();
        fs.mkdirSync(dir, { recursive: true });
        void shell.openPath(dir);
      },
      fileIcon: async (file, size) => (await app.getFileIcon(file, { size })).toDataURL(),
      onChange: (listener) =>
        void this.ctx.downloads.onChange((id, before, after) => {
          if (id === profileId) listener(before, after);
        }),
    };
  }

  /** chrome.sidePanel's views: one panel per window, under a bar with the extension's name and ✕. */
  sidePanels(profileId: string): SidePanelAccess {
    const open = new Map<number, { extensionId: string; header: WebContentsView; page: WebContentsView }>();
    const closedListeners: Array<(windowId: number, extensionId: string) => void> = [];
    const hooked = new Set<number>();
    const windowById = (id: number): BrowserWindowCtl | undefined => this.ctx.windows.forProfile(profileId).find((w) => w.win.id === id);
    const close = (windowId: number): void => {
      const entry = open.get(windowId);
      if (!entry) return;
      open.delete(windowId);
      windowById(windowId)?.setSidePanel(null);
      for (const view of [entry.header, entry.page]) pageOf(view)?.close();
      for (const l of closedListeners) l(windowId, entry.extensionId);
    };
    return {
      windowFor: ({ tabId, windowId }) => {
        if (tabId !== undefined) {
          const wc = allWebContents.fromId(tabId);
          const found = wc ? this.ctx.windows.byTabWebContents(wc) : undefined;
          return found && found.window.profile.profile.id === profileId ? found.window.win.id : undefined;
        }
        if (windowId !== undefined && windowId >= 0) return windowById(windowId)?.win.id;
        return this.targetWindow(profileId, undefined)?.win.id;
      },
      activeTabId: (windowId) => windowById(windowId)?.activeTab()?.view.webContents.id,
      manifestPath: (extensionId) => {
        const manifest = this.ctx.profiles.get(profileId).session.extensions.getExtension(extensionId)?.manifest as { side_panel?: { default_path?: unknown } } | undefined;
        return typeof manifest?.side_panel?.default_path === "string" ? manifest.side_panel.default_path : undefined;
      },
      openIn: (windowId) => open.get(windowId)?.extensionId ?? null,
      onClosed: (listener) => void closedListeners.push(listener),
      open: (windowId, extensionId, url) => {
        const win = windowById(windowId);
        if (!win) throw new Error(`No window with id: ${windowId}.`);
        close(windowId);
        const session = win.profile.session;
        const name = session.extensions.getExtension(extensionId)?.name ?? extensionId;
        const container = new View();
        const header = new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true } });
        const page = new WebContentsView({ webPreferences: { session, sandbox: true, contextIsolation: true } });
        container.addChildView(header);
        container.addChildView(page);
        void header.webContents.loadURL(panelHeader(name, tr("Close side panel"), nativeTheme.shouldUseDarkColors));
        header.webContents.on("page-title-updated", (_event, title) => {
          if (title === "close") close(windowId);
        });
        // Links the panel opens go to a tab of the window (web pages) and nowhere else.
        page.webContents.setWindowOpenHandler(({ url: target }) => {
          if (/^https?:/i.test(target)) win.createTab(target);
          return { action: "deny" };
        });
        void page.webContents.loadURL(url);
        // A panel page that closes itself (window.close()) closes the panel, as in Chrome.
        page.webContents.once("destroyed", () => {
          if (open.get(windowId)?.page === page) close(windowId);
        });
        open.set(windowId, { extensionId, header, page });
        if (!hooked.has(windowId)) {
          hooked.add(windowId);
          win.win.once("closed", () => {
            hooked.delete(windowId);
            close(windowId);
          });
        }
        win.setSidePanel({
          view: container,
          layout: ({ width, height }) => {
            header.setBounds({ x: 0, y: 0, width, height: PANEL_HEADER_HEIGHT });
            page.setBounds({ x: 0, y: PANEL_HEADER_HEIGHT, width, height: Math.max(0, height - PANEL_HEADER_HEIGHT) });
          },
        });
      },
      close,
    };
  }

  windowOf(webContents: WebContents): BaseWindow | null {
    return this.ctx.windows.byTabWebContents(webContents)?.window.win ?? null;
  }

  // PermissionHost: forwarded to the window layer.
  tabFor(wc: WebContents): { agent: boolean } | undefined {
    return this.ctx.windows.tabFor(wc);
  }

  promptsChanged(wc: WebContents): void {
    this.ctx.windows.promptsChanged(wc);
  }

  openExternal(wc: WebContents, url: string, requestingUrl: string): void {
    this.ctx.windows.openExternal(wc, url, requestingUrl);
  }

  extensionsChanged(profileId: string): void {
    for (const win of this.ctx.windows.forProfile(profileId)) {
      win.sendCommand({ type: "extensions-changed" });
      win.notifyInternalPages({ type: "extensions-changed" }, ["extensions"]);
    }
  }
}

/** Context menu of an extension in the toolbar or the extensions menu (like Chrome's "⋮"). */
export function showExtensionMenu(win: BrowserWindowCtl, id: string, x: number, y: number): void {
  const host = win.profile.extensions;
  const info = host.info(id);
  if (!info) return;
  const homepage = info.storeUrl ?? info.homepageUrl;
  const report = (p: Promise<unknown>): void => {
    p.catch((err: unknown) => void win.messageBox({ type: "error", title: info.name, message: (err as Error).message }));
  };
  const template: MenuItemConstructorOptions[] = [
    { label: info.name, enabled: homepage !== null, click: () => homepage && win.createTab(homepage) },
    { type: "separator" },
    { label: info.pinned ? "Unpin from toolbar" : "Pin to toolbar", click: () => host.setPinned(id, !info.pinned) },
    { label: "Options", enabled: info.optionsUrl !== null && info.enabled, click: () => report(host.openOptions(id)) },
    {
      label: "Remove from Corvus…",
      click: () =>
        report(
          win
            .messageBox({
              type: "warning",
              buttons: [tr("Cancel"), tr("Remove")],
              defaultId: 0,
              cancelId: 0,
              title: tr("Remove “{name}”?", { name: info.name }),
              message: tr("Remove “{name}”?", { name: info.name }),
              detail: tr("The extension and its data are removed from this profile."),
            })
            .then(({ response }) => (response === 1 ? host.remove(id) : undefined)),
        ),
    },
    { type: "separator" },
    { label: "Manage extension", click: () => win.openSingleton("corvus://extensions/") },
  ];
  Menu.buildFromTemplate(template).popup({ window: win.win, x: Math.round(x), y: Math.round(y) });
}
