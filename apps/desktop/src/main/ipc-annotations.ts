import fs from "node:fs/promises";
import { dialog, ipcMain, type IpcMainEvent } from "electron";
import {
  type Annotation,
  type AnnotationColor,
  MAX_NOTE_CHARS,
  MAX_QUOTE_CHARS,
  annotationsExportFilename,
  annotationsToMarkdown,
  isAnnotatableUrl,
  isAnnotationColor,
} from "../shared/annotations";
import {
  ANNOTATION_CREATE_CHANNEL,
  ANNOTATION_DELETE_CHANNEL,
  ANNOTATION_UPDATE_CHANNEL,
  type AnnotationCreateRequest,
  type AnnotationDeleteRequest,
  type AnnotationLibraryRpc,
  type AnnotationUpdateRequest,
} from "../shared/annotations-ipc";
import type { InternalPage } from "../shared/internal-urls";
import type { AppContext } from "./context";
import type { ProfileRuntime } from "./profiles";
import type { BrowserWindowCtl } from "./window";

class IpcError extends Error {}

const str = (value: unknown, name: string, max: number): string => {
  if (typeof value !== "string" || value.length > max) throw new IpcError(`Invalid ${name}`);
  return value;
};

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

function parseCreate(raw: unknown): AnnotationCreateRequest | null {
  if (!isObject(raw) || !isObject(raw.anchor)) return null;
  const { quote, prefix, suffix } = raw.anchor;
  if (typeof quote !== "string" || typeof prefix !== "string" || typeof suffix !== "string") return null;
  if (quote.length === 0 || quote.length > MAX_QUOTE_CHARS) return null;
  if (!isAnnotationColor(raw.color)) return null;
  if (typeof raw.note !== "string" || raw.note.length > MAX_NOTE_CHARS) return null;
  return {
    url: typeof raw.url === "string" ? raw.url : "",
    pageTitle: typeof raw.pageTitle === "string" ? raw.pageTitle.slice(0, 500) : "",
    color: raw.color,
    note: raw.note,
    anchor: { quote, prefix: prefix.slice(0, 200), suffix: suffix.slice(0, 200) },
  };
}

function parseUpdate(raw: unknown): AnnotationUpdateRequest | null {
  if (!isObject(raw) || typeof raw.id !== "string") return null;
  const out: AnnotationUpdateRequest = { id: raw.id };
  if (typeof raw.note === "string" && raw.note.length <= MAX_NOTE_CHARS) out.note = raw.note;
  if (isAnnotationColor(raw.color)) out.color = raw.color;
  return out;
}

function parseDelete(raw: unknown): AnnotationDeleteRequest | null {
  if (!isObject(raw) || typeof raw.id !== "string") return null;
  return { id: raw.id };
}

/**
 * Preload (tab isolated world) -> main: create/update/delete a highlight. The sender is re-validated
 * as a real tab main frame and the annotation's page URL is taken from the sender, never the payload,
 * so a page can only touch annotations for the page it is actually showing.
 */
export function registerAnnotationCapture(ctx: AppContext): void {
  const tabFor = (event: IpcMainEvent): { window: BrowserWindowCtl; profile: ProfileRuntime; url: string; title: string } | null => {
    const found = ctx.windows.byTabWebContents(event.sender);
    if (!found || event.senderFrame !== event.sender.mainFrame) return null;
    const url = event.sender.getURL();
    if (!isAnnotatableUrl(url)) return null;
    return { window: found.window, profile: found.window.profile, url, title: found.tab.title || url };
  };

  ipcMain.on(ANNOTATION_CREATE_CHANNEL, (event, raw) => {
    const ctxTab = tabFor(event);
    const req = parseCreate(raw);
    if (!ctxTab || !req) return;
    ctxTab.profile.annotations.add({ url: ctxTab.url, pageTitle: ctxTab.title, color: req.color, note: req.note, anchor: req.anchor });
  });

  ipcMain.on(ANNOTATION_UPDATE_CHANNEL, (event, raw) => {
    const ctxTab = tabFor(event);
    const req = parseUpdate(raw);
    if (!ctxTab || !req) return;
    ctxTab.profile.annotations.update(req.id, { ...(req.note !== undefined ? { note: req.note } : {}), ...(req.color ? { color: req.color } : {}) });
  });

  ipcMain.on(ANNOTATION_DELETE_CHANNEL, (event, raw) => {
    const ctxTab = tabFor(event);
    const req = parseDelete(raw);
    if (!ctxTab || !req) return;
    ctxTab.profile.annotations.remove(req.id);
  });
}

// --------------------------------------------------------------- manager page (corvus://annotations)

interface InternalContext {
  profile: ProfileRuntime;
  window: BrowserWindowCtl | undefined;
}

type InternalHandlers<T> = {
  [K in keyof T]: T[K] extends (...args: infer A) => infer R ? (c: InternalContext, ...args: A) => R | Promise<Awaited<R>> : never;
};

export const ANNOTATIONS_INTERNAL_PERMISSIONS: Record<keyof AnnotationLibraryRpc, readonly InternalPage[]> = {
  "annotations.list": ["annotations"],
  "annotations.updateNote": ["annotations"],
  "annotations.setColor": ["annotations"],
  "annotations.remove": ["annotations"],
  "annotations.clear": ["annotations"],
  "annotations.open": ["annotations"],
  "annotations.export": ["annotations"],
};

export function annotationsInternalHandlers(ctx: AppContext): InternalHandlers<AnnotationLibraryRpc> {
  return {
    "annotations.list": (c, query) => c.profile.annotations.list(str(query ?? "", "query", 512)),
    "annotations.updateNote": (c, id, note) => void c.profile.annotations.update(str(id, "id", 128), { note: str(note ?? "", "note", MAX_NOTE_CHARS) }),
    "annotations.setColor": (c, id, color) => {
      if (!isAnnotationColor(color)) throw new IpcError("Invalid color");
      c.profile.annotations.update(str(id, "id", 128), { color: color as AnnotationColor });
    },
    "annotations.remove": (c, id) => void c.profile.annotations.remove(str(id, "id", 128)),
    "annotations.clear": (c) => c.profile.annotations.clear(),
    "annotations.open": (c, id) => {
      if (c.window) ctx.annotations.openAnnotation(c.window, str(id, "id", 128));
    },
    "annotations.export": async (c) => {
      const items: Annotation[] = c.profile.annotations.list();
      if (items.length === 0) return false;
      const parent = c.window?.win;
      const options: Electron.SaveDialogOptions = {
        title: "Export annotations as Markdown",
        defaultPath: annotationsExportFilename(),
        filters: [{ name: "Markdown", extensions: ["md"] }],
      };
      const result = parent ? await dialog.showSaveDialog(parent, options) : await dialog.showSaveDialog(options);
      if (result.canceled || !result.filePath) return false;
      await fs.writeFile(result.filePath, annotationsToMarkdown(items), "utf8");
      return true;
    },
  };
}
