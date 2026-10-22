import { Menu, dialog, webContents as allWebContents, type BaseWindow, type MenuItemConstructorOptions, type WebContents } from "electron";
import { NEW_TAB_URL } from "../shared/internal-urls";
import type { AppContext } from "./context";
import type { TabCreateDetails, TabPlacement } from "./extensions";
import type { ProfileDelegate } from "./profiles";
import type { BrowserWindowCtl } from "./window";

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
    found?.window.activate(found.tab.id);
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
    p.catch((err: unknown) => void dialog.showMessageBox(win.win, { type: "error", message: (err as Error).message }));
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
          dialog
            .showMessageBox(win.win, {
              type: "warning",
              buttons: ["Remove", "Cancel"],
              defaultId: 1,
              cancelId: 1,
              message: `Remove “${info.name}”?`,
              detail: "The extension and its data are removed from this profile.",
            })
            .then(({ response }) => (response === 0 ? host.remove(id) : undefined)),
        ),
    },
    { type: "separator" },
    { label: "Manage extension", click: () => win.openSingleton("corvus://extensions/") },
  ];
  Menu.buildFromTemplate(template).popup({ window: win.win, x: Math.round(x), y: Math.round(y) });
}
