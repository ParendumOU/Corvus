import { dialog, type WebContents } from "electron";
import type { BrowserChromeRpc, BrowserInternalRpc, PermissionResponse } from "../shared/browser-ipc";
import { isDownloadAction } from "../shared/downloads";
import type { InternalPage } from "../shared/internal-urls";
import { isPermissionKind, originOf, type PermissionDecision, type PermissionKind } from "../shared/permissions";
import type { AppContext } from "./context";
import type { ProfileRuntime } from "./profiles";
import type { BrowserWindowCtl } from "./window";

class IpcError extends Error {}

type Handlers<T, C> = {
  [K in keyof T]: T[K] extends (...args: infer A) => infer R ? (context: C, ...args: A) => R | Promise<Awaited<R>> : never;
};

/** Same shape as the internal-page call context built in ipc.ts. */
interface InternalCallContext {
  sender: WebContents;
  page: InternalPage;
  profile: ProfileRuntime;
  window: BrowserWindowCtl | undefined;
}

const str = (value: unknown, name: string, max = 2048): string => {
  if (typeof value !== "string" || value.length > max) throw new IpcError(`Invalid ${name}`);
  return value;
};
const kind = (value: unknown): PermissionKind => {
  if (!isPermissionKind(value)) throw new IpcError("Invalid permission");
  return value;
};
const decision = (value: unknown): PermissionDecision | null => {
  if (value === null || value === "allow" || value === "block") return value;
  throw new IpcError("Invalid decision");
};
const origin = (value: unknown): string => {
  const raw = str(value, "origin");
  if (!raw || originOf(raw) !== raw) throw new IpcError("Invalid origin");
  return raw;
};
const action = (value: unknown) => {
  if (!isDownloadAction(value)) throw new IpcError("Invalid download action");
  return value;
};

export function browserChromeHandlers(ctx: AppContext): Handlers<BrowserChromeRpc, BrowserWindowCtl> {
  return {
    "permissions.respond": (w, id, response, remember, sourceId) => {
      if (response !== "allow" && response !== "block" && response !== "dismiss") throw new IpcError("Invalid response");
      w.respondPermission(str(id, "prompt"), response as PermissionResponse, remember === true, sourceId === undefined ? undefined : str(sourceId, "source"));
    },
    "site.info": (w) => w.siteInfo(),
    "site.setPermission": (w, k, d) => w.setSitePermission(kind(k), decision(d)),
    "site.resetPermissions": (w) => w.resetSitePermissions(),
    "find.query": (w, text) => w.findQuery(str(text, "text", 1000)),
    "find.step": (w, forward) => w.findStep(forward !== false),
    "find.close": (w) => w.closeFind(),
    "zoom.step": (w, delta) => {
      if (delta !== 1 && delta !== -1 && delta !== 0) throw new IpcError("Invalid zoom step");
      const tab = w.activeTab();
      if (tab) w.zoomTab(tab, delta);
    },
    "downloads.action": (w, id, a) => ctx.downloads.act(w.profile, str(id, "download"), action(a)),
    "downloads.openPage": (w) => w.openSingleton("corvus://downloads/"),
  };
}

export const BROWSER_INTERNAL_PERMISSIONS: Record<keyof BrowserInternalRpc, readonly InternalPage[]> = {
  "downloads.list": ["downloads"],
  "downloads.act": ["downloads"],
  "downloads.clear": ["downloads"],
  "downloads.chooseDirectory": ["settings"],
  "sitePermissions.list": ["settings"],
  "sitePermissions.set": ["settings"],
  "sitePermissions.reset": ["settings"],
};

export function browserInternalHandlers(ctx: AppContext): Handlers<BrowserInternalRpc, InternalCallContext> {
  return {
    "downloads.list": (c) => ctx.downloads.list(c.profile),
    "downloads.act": (c, id, a) => ctx.downloads.act(c.profile, str(id, "download"), action(a)),
    "downloads.clear": (c) => ctx.downloads.clear(c.profile),
    "downloads.chooseDirectory": async (c) => {
      const options: Electron.OpenDialogOptions = {
        title: "Choose a download folder",
        defaultPath: ctx.downloads.directory(),
        properties: ["openDirectory", "createDirectory"],
      };
      const parent = c.window?.win;
      const result = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options);
      const dir = result.filePaths[0];
      if (result.canceled || !dir) return null;
      ctx.settings.update({ downloads: { directory: dir } });
      return ctx.settings.view();
    },
    "sitePermissions.list": (c) => c.profile.siteSettings.listPermissions(),
    "sitePermissions.set": (c, o, k, d) => {
      c.profile.siteSettings.setPermission(origin(o), kind(k), decision(d));
      return c.profile.siteSettings.listPermissions();
    },
    "sitePermissions.reset": (c, o) => {
      c.profile.siteSettings.resetPermissions(origin(o));
      return c.profile.siteSettings.listPermissions();
    },
  };
}
