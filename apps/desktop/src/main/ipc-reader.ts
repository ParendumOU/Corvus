import fs from "node:fs/promises";
import { dialog, ipcMain, type IpcMainInvokeEvent } from "electron";
import { READER_RPC, type ReaderChromeRpc, type ReaderRpc, type ReaderSettings, type ReaderToolKind, type ReadingLibraryRpc } from "../shared/reader-ipc";
import { readingExportFilename, readingItemToMarkdown } from "../shared/reading";
import type { InternalPage } from "../shared/internal-urls";
import type { AppContext } from "./context";
import type { ProfileRuntime } from "./profiles";
import type { BrowserWindowCtl } from "./window";

class IpcError extends Error {}

type ChromeHandlers<T> = {
  [K in keyof T]: T[K] extends (...args: infer A) => infer R ? (w: BrowserWindowCtl, ...args: A) => R | Promise<Awaited<R>> : never;
};

const TOOL_KINDS = new Set<ReaderToolKind>(["key-points", "tldr", "simplify", "eli5", "translate", "define", "explain"]);

const str = (value: unknown, name: string, max: number): string => {
  if (typeof value !== "string" || value.length > max) throw new IpcError(`Invalid ${name}`);
  return value;
};

function settingsPatch(value: unknown): Partial<ReaderSettings> {
  if (typeof value !== "object" || value === null) throw new IpcError("Invalid reader settings");
  const v = value as Record<string, unknown>;
  const patch: Partial<ReaderSettings> = {};
  if (typeof v.fontSize === "number" && Number.isFinite(v.fontSize)) patch.fontSize = v.fontSize;
  if (typeof v.lineWidth === "number" && Number.isFinite(v.lineWidth)) patch.lineWidth = v.lineWidth;
  if (v.theme === "light" || v.theme === "sepia" || v.theme === "dark") patch.theme = v.theme;
  if (v.font === "serif" || v.font === "sans") patch.font = v.font;
  return patch;
}

/** Chrome UI method for the reader toggle (spread into ChromeRpc handlers). */
export function readerChromeHandlers(ctx: AppContext): ChromeHandlers<ReaderChromeRpc> {
  return {
    "reader.toggle": (w) => ctx.reader.toggle(w),
  };
}

function readerHandlers(ctx: AppContext): ChromeHandlers<ReaderRpc> {
  return {
    "state.get": (w) => ctx.reader.state(w),
    "reader.close": (w) => ctx.reader.close(w),
    "reader.setSettings": (w, patch) => ctx.reader.setSettings(w, settingsPatch(patch)),
    "reader.tool": (w, kind, input) => {
      if (typeof kind !== "string" || !TOOL_KINDS.has(kind as ReaderToolKind)) throw new IpcError("Invalid tool");
      ctx.reader.tool(w, kind as ReaderToolKind, input === undefined ? "" : str(input, "input", 4000));
    },
    "reader.cancel": (w) => ctx.reader.cancel(w),
    "reader.clear": (w) => ctx.reader.clear(w),
    "reader.save": (w) => ctx.reader.save(w),
    "reader.openReadingList": (w) => ctx.reader.openReadingList(w),
    "reader.openLink": (w, url) => ctx.reader.openLink(w, str(url, "url", 4096)),
  };
}

/** The reader channel only answers the reader view of a window. */
export function registerReaderIpc(ctx: AppContext): void {
  const handlers = readerHandlers(ctx);
  ipcMain.handle(READER_RPC, (event: IpcMainInvokeEvent, method: unknown, args: unknown) => {
    const window = ctx.reader.windowForView(event.sender);
    if (!window || event.senderFrame !== event.sender.mainFrame) throw new IpcError("Unauthorized sender");
    if (typeof method !== "string" || !Object.hasOwn(handlers, method)) throw new IpcError(`Unknown method ${String(method)}`);
    const handler = handlers[method as keyof ReaderRpc] as (w: BrowserWindowCtl, ...a: unknown[]) => unknown;
    return handler(window, ...(Array.isArray(args) ? args : []));
  });
}

// --------------------------------------------------------------- reading library (corvus://reading)

interface InternalContext {
  profile: ProfileRuntime;
  window: BrowserWindowCtl | undefined;
}

type InternalHandlers<T> = {
  [K in keyof T]: T[K] extends (...args: infer A) => infer R ? (c: InternalContext, ...args: A) => R | Promise<Awaited<R>> : never;
};

export const READING_INTERNAL_PERMISSIONS: Record<keyof ReadingLibraryRpc, readonly InternalPage[]> = {
  "reading.list": ["reading"],
  "reading.remove": ["reading"],
  "reading.export": ["reading"],
  "reading.open": ["reading"],
};

export function readingInternalHandlers(): InternalHandlers<ReadingLibraryRpc> {
  return {
    "reading.list": (c, query) => c.profile.reading.list(str(query ?? "", "query", 512)),
    "reading.remove": (c, id) => c.profile.reading.remove(str(id, "id", 128)),
    "reading.open": (c, id) => {
      const item = c.profile.reading.get(str(id, "id", 128));
      if (item && c.window) c.window.openUrl(item.url, "new-tab");
    },
    "reading.export": async (c, id) => {
      const item = c.profile.reading.get(str(id, "id", 128));
      if (!item) return false;
      const parent = c.window?.win;
      const options: Electron.SaveDialogOptions = {
        title: "Export article as Markdown",
        defaultPath: readingExportFilename(item),
        filters: [{ name: "Markdown", extensions: ["md"] }],
      };
      const result = parent ? await dialog.showSaveDialog(parent, options) : await dialog.showSaveDialog(options);
      if (result.canceled || !result.filePath) return false;
      await fs.writeFile(result.filePath, readingItemToMarkdown(item), "utf8");
      return true;
    },
  };
}
