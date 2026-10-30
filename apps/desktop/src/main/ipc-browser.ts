import { clipboard, dialog, type WebContents, shell } from "electron";
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
const ids = (value: unknown): string[] => {
  if (!Array.isArray(value) || value.length > 5000) throw new IpcError("Invalid ids");
  return value.map((v) => str(v, "id", 64));
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
    "site.restoreCertWarnings": (w) => w.restoreCertWarnings(),
    "find.query": (w, text) => w.findQuery(str(text, "text", 1000)),
    "find.step": (w, forward) => w.findStep(forward !== false),
    "find.close": (w) => w.closeFind(),
    "zoom.step": (w, delta) => {
      if (delta !== 1 && delta !== -1 && delta !== 0) throw new IpcError("Invalid zoom step");
      const tab = w.activeTab();
      if (tab) w.zoomTab(tab, delta);
    },
    "downloads.action": (w, id, a) => ctx.downloads.act(w.profile, str(id, "download"), action(a)),
    "downloads.openPage": (w) => {
      ctx.downloads.markSeen(w.profile);
      w.openSingleton("corvus://downloads/");
    },
    "downloads.markSeen": (w) => ctx.downloads.markSeen(w.profile),
    "grabber.grabCopied": (w) => ctx.grabber.grabCopied(w),
    "grabber.queueCopied": (w) => ctx.grabber.queueCopied(w),
    "grabber.dismissCopied": () => ctx.grabber.dismissCopied(),
    "defaultBrowser.answer": (w, choice) => {
      if (choice !== "make" && choice !== "later" && choice !== "never") throw new IpcError("Invalid answer");
      return ctx.defaultBrowser.answer(w, choice);
    },
    "grabber.downloadCopiedWithAi": (w) => ctx.grabber.downloadCopiedWithAi(w),
    "share.telegram": (_w, url, title) => {
      const u = str(url, "url", 8192);
      if (!/^https?:\/\//i.test(u)) throw new IpcError("Only web pages can be sent");
      return ctx.telegram.send(u, str(title ?? "", "title", 500));
    },
    "share.device": (w, deviceId, url, title) => {
      const u = str(url, "url", 8192);
      if (!/^https?:\/\//i.test(u)) throw new IpcError("Only web pages can be sent");
      const to = str(deviceId, "device", 64);
      if (!ctx.sync.phones(w.profile).some((p) => p.id === to)) throw new IpcError("That phone is not paired with this profile");
      return ctx.sync.sendTab(w.profile, to, u, str(title ?? "", "title", 500));
    },
    "share.copy": (_w, url) => clipboard.writeText(str(url, "url", 8192)),
  };
}

export const BROWSER_INTERNAL_PERMISSIONS: Record<keyof BrowserInternalRpc, readonly InternalPage[]> = {
  "downloads.list": ["downloads"],
  "downloads.act": ["downloads"],
  "downloads.clear": ["downloads"],
  "downloads.chooseDirectory": ["settings"],
  "grabber.list": ["downloads"],
  "grabber.addText": ["downloads"],
  "grabber.rename": ["downloads"],
  "queue.rename": ["downloads"],
  "queue.openFolder": ["downloads"],
  "grabber.remove": ["downloads"],
  "grabber.clear": ["downloads"],
  "grabber.watchClipboard": ["downloads"],
  "grabber.download": ["downloads"],
  "grabber.downloadWithAi": ["downloads"],
  "defaultBrowser.status": ["settings"],
  "defaultBrowser.make": ["settings"],
  "defaultBrowser.unregister": ["settings"],
  "queue.list": ["downloads"],
  "queue.act": ["downloads"],
  "queue.move": ["downloads"],
  "queue.clearDone": ["downloads"],
  "queue.extract": ["downloads"],
  "queue.openPage": ["downloads"],
  "sitePermissions.list": ["settings"],
  "sitePermissions.set": ["settings"],
  "sitePermissions.reset": ["settings"],
  "sitePermissions.forgetExternalApp": ["settings"],
};

export function browserInternalHandlers(ctx: AppContext): Handlers<BrowserInternalRpc, InternalCallContext> {
  return {
    "downloads.list": (c) => ctx.downloads.list(c.profile),
    "downloads.act": (c, id, a) => ctx.downloads.act(c.profile, str(id, "download"), action(a)),
    "downloads.clear": (c) => ctx.downloads.clear(c.profile),
    "grabber.list": (c) => ctx.grabber.list(c.profile),
    "grabber.addText": (c, text, name) => ctx.grabber.addText(c.profile, str(text, "text", 200_000), "pasted", typeof name === "string" ? name.slice(0, 200) : ""),
    "grabber.rename": (c, id, name) => ctx.grabber.rename(c.profile, str(id, "id", 64), str(name, "name", 200)),
    "grabber.remove": (c, list) => ctx.grabber.remove(c.profile, ids(list)),
    "grabber.clear": (c) => ctx.grabber.clear(c.profile),
    "grabber.watchClipboard": (_c, on) => {
      if (typeof on === "boolean") ctx.settings.update({ downloads: { watchClipboard: on } });
      return ctx.settings.get().downloads.watchClipboard;
    },
    "grabber.download": (c, list) => {
      if (!c.window) throw new IpcError("No browser window");
      return ctx.grabber.download(c.window, ids(list));
    },
    "grabber.downloadWithAi": (c, list) => {
      if (!c.window) throw new IpcError("No browser window");
      return ctx.grabber.downloadWithAi(c.window, ids(list));
    },
    "defaultBrowser.status": () => ctx.defaultBrowser.status(),
    "defaultBrowser.make": async () => {
      const result = await ctx.defaultBrowser.makeDefault();
      return { result, status: await ctx.defaultBrowser.status() };
    },
    "defaultBrowser.unregister": async () => {
      await ctx.defaultBrowser.unregister();
      return ctx.defaultBrowser.status();
    },
    "queue.list": (c) => ctx.queue.list(c.profile),
    "queue.act": (c, id, a) => {
      if (a !== "pause" && a !== "resume" && a !== "retry" && a !== "remove") throw new IpcError("Invalid queue action");
      ctx.queue.act(c.profile, str(id, "id", 64), a);
    },
    "queue.move": (c, id, delta) => ctx.queue.move(c.profile, str(id, "id", 64), delta === -1 ? -1 : 1),
    "queue.rename": (c, id, name) => ctx.queue.rename(c.profile, str(id, "id", 64), str(name, "name", 200)),
    "queue.openFolder": (c, id) => void shell.openPath(ctx.queue.folderOf(c.profile, str(id, "id", 64))),
    "queue.clearDone": (c) => ctx.queue.clearDone(c.profile),
    "queue.openPage": (c, id) => {
      if (!c.window) throw new IpcError("No browser window");
      ctx.queue.openPage(c.window, str(id, "id", 64));
    },
    "queue.extract": (c, id, password) => ctx.queue.extract(c.profile, str(id, "id", 64), password === undefined || password === null ? undefined : str(password, "password", 200)),
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
    "sitePermissions.forgetExternalApp": (c, o, s) => {
      c.profile.siteSettings.setExternalAppAllowed(origin(o), str(s, "scheme", 64), false);
      return c.profile.siteSettings.listPermissions();
    },
  };
}
