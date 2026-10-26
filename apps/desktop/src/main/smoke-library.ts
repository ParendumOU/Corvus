import path from "node:path";
import type { WebContents } from "electron";
import { BAR_FOLDER_ID, childrenOf } from "../shared/bookmark-tree";
import type { AppContext } from "./context";
import type { BrowserWindowCtl } from "./window";

interface LibrarySmokeHelpers {
  win: BrowserWindowCtl;
  check: (name: string, ok: boolean, detail?: unknown) => void;
  capture: (name: string, wc: WebContents) => Promise<void>;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function poll(wc: WebContents, expr: string, timeoutMs = 6000): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if ((await wc.executeJavaScript(`Boolean(${expr})`).catch(() => false)) === true) return true;
    await sleep(100);
  }
  return false;
}

/** Drags one element onto another (top or bottom part, or its middle) with the page's own DnD handlers. */
function dragScript(from: string, to: string, at: number): string {
  return `(() => {
    const src = document.querySelector(${JSON.stringify(from)});
    const dst = document.querySelector(${JSON.stringify(to)});
    if (!src || !dst) return false;
    const dt = new DataTransfer();
    const r = dst.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height * ${at};
    src.dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer: dt }));
    dst.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: dt, clientX: x, clientY: y }));
    dst.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt, clientX: x, clientY: y }));
    src.dispatchEvent(new DragEvent("dragend", { bubbles: true, dataTransfer: dt }));
    return true;
  })()`;
}

/** Library pages: bookmarks in a table or a grid, a clickable path, drag to reorder and into folders. */
export async function runLibrarySmoke(ctx: AppContext, h: LibrarySmokeHelpers): Promise<void> {
  const { win, check, capture } = h;
  const store = win.profile.bookmarks;
  const folder = store.create({ parentId: BAR_FOLDER_ID, kind: "folder", title: "Smoke library" });
  const inner = store.create({ parentId: folder.id, kind: "folder", title: "Inner" });
  const first = store.create({ parentId: folder.id, kind: "bookmark", title: "Alpha", url: "https://alpha.example/" });
  const second = store.create({ parentId: folder.id, kind: "bookmark", title: "Beta", url: "https://beta.example/" });
  const tab = win.createTab("corvus://bookmarks/", { activate: true });
  const wc = tab.view.webContents;
  try {
    // The tree fills in once the bookmarks have loaded.
    await poll(wc, "[...document.querySelectorAll('.tree button')].some((b) => b.innerText.includes('Smoke library'))");
    // Open the folder from the sidebar tree.
    await wc.executeJavaScript(`[...document.querySelectorAll('.tree button')].find((b) => b.innerText.includes('Smoke library'))?.click()`);
    const table = await poll(wc, `document.querySelectorAll('.bm-table .bm-row[data-bookmark-id]').length === 3 && document.querySelector('.bm-crumb.current')?.innerText.includes('Smoke library')`);
    check("bookmarks page: a folder shows as a table with its path", table, await wc.executeJavaScript("document.querySelector('.bm-crumbs')?.innerText ?? ''"));
    await capture("bookmarks-table", wc);

    // Drag Beta above Alpha: it moves first.
    await wc.executeJavaScript(dragScript(`[data-bookmark-id="${second.id}"]`, `[data-bookmark-id="${first.id}"]`, 0.1));
    let order = "";
    for (let i = 0; i < 30 && order !== "Inner,Beta,Alpha"; i++) {
      await sleep(100);
      order = childrenOf(store.list(), folder.id).map((b) => b.title).join(",");
    }
    // The folder stays first; Beta now comes before Alpha.
    check("bookmarks page: dragging an item above another reorders them", order === "Inner,Beta,Alpha", order);

    // Drop Alpha on the middle of Inner: it moves inside.
    await wc.executeJavaScript(dragScript(`[data-bookmark-id="${first.id}"]`, `[data-bookmark-id="${inner.id}"]`, 0.5));
    let moved = false;
    for (let i = 0; i < 30 && !moved; i++) {
      await sleep(100);
      moved = childrenOf(store.list(), inner.id).some((b) => b.id === first.id);
    }
    check("bookmarks page: dropping on the middle of a folder moves the item inside", moved);

    // Grid view, then the path back to the parent.
    await wc.executeJavaScript(`[...document.querySelectorAll('.bm-view button')].find((b) => b.getAttribute('aria-checked') === 'false')?.click()`);
    const grid = await poll(wc, "document.querySelectorAll('.bm-grid .bm-tile').length >= 2");
    await capture("bookmarks-grid", wc);
    await wc.executeJavaScript(`[...document.querySelectorAll('.bm-crumb')].find((b) => !b.classList.contains('current'))?.click()`);
    const up = await poll(wc, `document.querySelector('.bm-crumb.current') && !document.querySelector('.bm-crumb.current').innerText.includes('Smoke library')`);
    check("bookmarks page: grid view, and a step of the path opens that folder", grid && up, { grid, up });
    await wc.executeJavaScript(`[...document.querySelectorAll('.bm-view button')].find((b) => b.getAttribute('aria-checked') === 'false')?.click()`);
  } finally {
    win.closeTab(tab.id);
    store.remove(folder.id);
  }

  // Downloads: pasted links with a name make one package of that name; renaming it in the queue
  // renames its folder.
  const runtime = win.profile;
  const added = ctx.grabber.addText(runtime, "https://files.invalid/a.bin\nhttps://files.invalid/b.bin", "pasted", "Smoke set");
  const named = ctx.grabber.list(runtime).find((p) => p.name === "Smoke set");
  check("downloads: pasted links with a name become one package of that name", added === 2 && named?.links.length === 2, { added, named: named?.links.length });
  if (named) {
    try {
      ctx.queue.addGrabbed(runtime, [named]);
      ctx.queue.act(runtime, named.id, "pause");
      ctx.queue.rename(runtime, named.id, "Smoke renamed");
      const pkg = ctx.queue.list(runtime).packages.find((p) => p.id === named.id);
      check("downloads: renaming a queued package renames its folder", pkg?.name === "Smoke renamed" && path.basename(pkg.dir) === "Smoke renamed", { name: pkg?.name, dir: pkg?.dir });
    } catch (err) {
      check("downloads: renaming a queued package renames its folder", false, String(err));
    } finally {
      ctx.queue.act(runtime, named.id, "remove");
      ctx.grabber.remove(runtime, [named.id]);
    }
  }
}
