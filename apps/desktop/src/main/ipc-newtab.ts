import { WALLPAPER_SOURCES, type WallpaperSource } from "../shared/newtab";
import type { NewTabRpc } from "../shared/newtab-ipc";
import type { InternalPage } from "../shared/internal-urls";
import type { AppContext } from "./context";
import type { ProfileRuntime } from "./profiles";
import type { BrowserWindowCtl } from "./window";

class IpcError extends Error {}

const str = (value: unknown, name: string, max: number): string => {
  if (typeof value !== "string" || value.length > max) throw new IpcError(`Invalid ${name}`);
  return value;
};

interface InternalContext {
  profile: ProfileRuntime;
  window: BrowserWindowCtl | undefined;
}

type InternalHandlers<T> = {
  [K in keyof T]: T[K] extends (...args: infer A) => infer R ? (c: InternalContext, ...args: A) => R | Promise<Awaited<R>> : never;
};

export const NEWTAB_INTERNAL_PERMISSIONS: Record<keyof NewTabRpc, readonly InternalPage[]> = {
  "newtab.view": ["newtab"],
  "newtab.save": ["newtab"],
  "newtab.undo": ["newtab"],
  "newtab.reset": ["newtab"],
  "newtab.pickImage": ["newtab"],
  "newtab.wallpaper": ["newtab"],
  "newtab.customData": ["newtab"],
  "newtab.consent": ["newtab"],
  "newtab.openFromWidget": ["newtab"],
};

export function newtabInternalHandlers(ctx: AppContext): InternalHandlers<NewTabRpc> {
  return {
    "newtab.view": (c) => ctx.newtab.view(c.profile),
    "newtab.save": (c, layout) => ctx.newtab.save(c.profile, layout),
    "newtab.undo": (c) => ctx.newtab.undo(c.profile),
    "newtab.reset": (c) => ctx.newtab.reset(c.profile),
    "newtab.pickImage": (c) => ctx.newtab.pickImage(c.profile, c.window),
    "newtab.wallpaper": (_c, source) => {
      if (!(WALLPAPER_SOURCES as readonly unknown[]).includes(source)) throw new IpcError("Unknown wallpaper source");
      return ctx.newtab.wallpaper(source as WallpaperSource);
    },
    "newtab.customData": (c, id) => ctx.newtab.customData(c.profile, str(id, "widget", 40)),
    "newtab.consent": (c, id, hosts) => {
      if (!Array.isArray(hosts) || hosts.length > 8) throw new IpcError("Invalid hosts");
      return ctx.newtab.consent(c.profile, str(id, "widget", 40), hosts.map((h) => str(h, "host", 253)));
    },
    "newtab.openFromWidget": (c, id, url) => ctx.newtab.openFromWidget(c.profile, c.window, str(id, "widget", 40), str(url, "url", 4096)),
  };
}
