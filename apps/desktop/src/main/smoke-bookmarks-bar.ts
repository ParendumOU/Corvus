import { Menu, type WebContents } from "electron";
import { BAR_FOLDER_ID, OPEN_ALL_ASK_ABOVE, childrenOf } from "../shared/bookmark-tree";
import type { AppContext } from "./context";
import type { BrowserWindowCtl } from "./window";

interface BookmarksBarSmokeHelpers {
  url: string;
  win: BrowserWindowCtl;
  check: (name: string, ok: boolean, detail?: unknown) => void;
  capture: (name: string, wc: WebContents) => Promise<void>;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function waitForJs(wc: WebContents, expr: string, timeoutMs = 6000): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if ((await wc.executeJavaScript(`Boolean(${expr})`).catch(() => false)) === true) return true;
    await sleep(100);
  }
  return false;
}

async function waitFor<T>(fn: () => T | undefined, timeoutMs = 6000): Promise<T | undefined> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const value = fn();
    if (value !== undefined) return value;
    await sleep(100);
  }
  return undefined;
}

/**
 * Drags one bar item over another and drops it, as the chrome UI sees a real drag: `at` is where
 * on the target, from its left edge (0) to its right edge (1). Returns the marker the bar showed.
 */
function dragOnBar(chrome: WebContents, id: string, targetId: string, at: number): Promise<string> {
  return chrome.executeJavaScript(`(async () => {
    const item = (id) => document.querySelector('.bar-item[data-bookmark-id="' + id + '"]');
    const frame = () => new Promise((done) => requestAnimationFrame(() => setTimeout(done, 30)));
    const data = new DataTransfer();
    const source = item(${JSON.stringify(id)});
    source.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: data }));
    await frame();
    const r = item(${JSON.stringify(targetId)}).getBoundingClientRect();
    const opts = { bubbles: true, cancelable: true, dataTransfer: data, clientX: r.left + r.width * ${at}, clientY: r.top + r.height / 2 };
    item(${JSON.stringify(targetId)}).dispatchEvent(new DragEvent('dragover', opts));
    await frame();
    const marked = document.querySelector('.bar-item.drop-before, .bar-item.drop-after, .bar-item.drop-into');
    const marker = marked ? [...marked.classList].find((c) => c.startsWith('drop-')) + ':' + marked.dataset.bookmarkId : '';
    item(${JSON.stringify(targetId)}).dispatchEvent(new DragEvent('drop', opts));
    source.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: data }));
    return marker;
  })()`) as Promise<string>;
}

/**
 * The bookmarks bar: its items drag along it (a line where they land) and into a folder, Edit… in
 * an item's menu edits it in Corvus's dialog (Enter saves, an empty address is refused, Escape
 * cancels), a middle click on a folder opens its bookmarks (asking first when there are many), and
 * the "»" menu shows the icons the bar shows.
 */
export async function runBookmarksBarSmoke(ctx: AppContext, h: BookmarksBarSmokeHelpers): Promise<void> {
  const { url, win, check, capture } = h;
  const chrome = win.chrome.webContents;
  const bookmarks = win.profile.bookmarks;
  const barShown = ctx.settings.get().appearance.showBookmarksBar;
  ctx.settings.update({ appearance: { showBookmarksBar: true } });
  // The bar's menus are native: keep the ones it asks for instead of showing them.
  const menus: Menu[] = [];
  const popup = Menu.prototype.popup;
  Menu.prototype.popup = function (this: Menu) {
    menus.push(this);
  };
  const nextMenu = async (open: () => Promise<unknown>): Promise<Menu | undefined> => {
    const before = menus.length;
    await open();
    return waitFor(() => (menus.length > before ? menus[menus.length - 1] : undefined));
  };
  const created: string[] = [];
  const add = (node: Parameters<typeof bookmarks.create>[0]): string => {
    const id = bookmarks.create(node).id;
    created.push(id);
    return id;
  };
  const barIds = (): string[] => childrenOf(bookmarks.list(), BAR_FOLDER_ID).map((b) => b.id);
  const opened: string[] = [];
  try {
    const a = add({ parentId: BAR_FOLDER_ID, kind: "bookmark", title: "Bar A", url: `${url}ux-plain?bar=a`, index: 0 });
    const b = add({ parentId: BAR_FOLDER_ID, kind: "bookmark", title: "Bar B", url: `${url}ux-plain?bar=b`, index: 1 });
    const c = add({ parentId: BAR_FOLDER_ID, kind: "bookmark", title: "Bar C", url: `${url}ux-plain?bar=c`, index: 2 });
    const folder = add({ parentId: BAR_FOLDER_ID, kind: "folder", title: "Bar folder", index: 3 });
    for (const n of [1, 2, 3]) add({ parentId: folder, kind: "bookmark", title: `In folder ${n}`, url: `${url}ux-plain?folder=${n}` });
    await waitForJs(chrome, `document.querySelector('.bar-item[data-bookmark-id="${folder}"]')`);

    // 1. A dragged past C lands after it (a line marks the spot); dropped on the folder's middle, B goes in.
    const after = await dragOnBar(chrome, a, c, 0.85);
    const moved = await waitFor(() => (barIds().slice(0, 4).join() === [b, c, a, folder].join() ? true : undefined));
    check("bookmarks bar: dragging an item along the bar shows where it lands and moves it there", Boolean(moved) && after.startsWith("drop-"), {
      after,
      bar: barIds().slice(0, 4),
    });
    const into = await dragOnBar(chrome, b, folder, 0.5);
    const inFolder = await waitFor(() => (bookmarks.get(b)?.parentId === folder ? true : undefined));
    check("bookmarks bar: dropping an item on the middle of a folder moves it into the folder", Boolean(inFolder) && into === `drop-into:${folder}`, { into });
    await waitForJs(chrome, `!document.querySelector('.bar-item[data-bookmark-id="${b}"]')`);
    await capture("bookmarks-bar-moved", chrome);

    // 2. Edit… in an item's menu: Corvus's dialog with its name and address.
    const menuOf = (id: string): Promise<Menu | undefined> =>
      nextMenu(() =>
        chrome.executeJavaScript(`(() => {
          const el = document.querySelector('.bar-item[data-bookmark-id="${id}"]');
          const r = el.getBoundingClientRect();
          el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 5, clientY: r.top + 5 }));
        })()`),
      );
    const setField = (i: number, value: string): Promise<unknown> =>
      chrome.executeJavaScript(`(() => {
        const el = document.querySelector('.dialog-card [data-dialog-field="${i}"]');
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(value)});
        el.dispatchEvent(new Event('input', { bubbles: true }));
      })()`);
    const key = (name: string): Promise<unknown> =>
      chrome.executeJavaScript(`document.querySelector('.dialog-card [data-dialog-field="0"]').dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(name)}, bubbles: true }))`);
    const menu = await menuOf(a);
    const edit = menu?.getMenuItemById("bookmark-edit");
    edit?.click();
    const shown = await waitForJs(chrome, "document.querySelectorAll('.dialog-card [data-dialog-field]').length === 2");
    const fields = (await chrome.executeJavaScript("[...document.querySelectorAll('.dialog-card [data-dialog-field]')].map((f) => f.value)").catch(() => [])) as string[];
    check("bookmarks bar: Edit… in an item's menu opens Corvus's dialog with its name and address", shown && fields[0] === "Bar A" && fields[1] === `${url}ux-plain?bar=a`, {
      menu: menu?.items.map((i) => i.label),
      fields,
    });
    await capture("bookmark-edit-dialog", chrome);
    await setField(1, "  ");
    await key("Enter");
    const refused = await waitForJs(chrome, "document.querySelector('.dialog-card .dialog-field-error')");
    await setField(0, "Bar A edited");
    await setField(1, "example.com/edited");
    await key("Enter");
    const saved = await waitFor(() => (bookmarks.get(a)?.title === "Bar A edited" ? bookmarks.get(a) : undefined));
    check(
      "bookmarks bar: the edit dialog refuses an empty address, and Enter saves the name and the completed address",
      refused && saved?.url === "https://example.com/edited" && win.state().dialog === null,
      { refused, saved, dialog: win.state().dialog?.title ?? null },
    );
    (await menuOf(folder))?.getMenuItemById("bookmark-edit")?.click();
    const folderFields = await waitForJs(chrome, "document.querySelectorAll('.dialog-card [data-dialog-field]').length === 1");
    await setField(0, "Renamed folder");
    await key("Escape");
    const cancelled = await waitFor(() => (win.state().dialog === null ? true : undefined));
    check("bookmarks bar: a folder's edit dialog has only its name, and Escape leaves it as it was", folderFields && Boolean(cancelled) && bookmarks.get(folder)?.title === "Bar folder", {
      folderFields,
      title: bookmarks.get(folder)?.title,
    });

    // 3. A middle click on a folder opens its bookmarks in background tabs; with many, it asks first.
    const tabUrls = (): string[] => win.state().tabs.map((t) => t.url);
    const middleClick = (id: string): Promise<unknown> =>
      chrome.executeJavaScript(`document.querySelector('.bar-item[data-bookmark-id="${id}"]').dispatchEvent(new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 }))`);
    const before = new Set(win.state().tabs.map((t) => t.id));
    const active = win.state().activeTabId;
    await middleClick(folder);
    const inFolderUrls = childrenOf(bookmarks.list(), folder).flatMap((x) => (x.url ? [x.url] : []));
    const all = await waitFor(() => (inFolderUrls.every((u) => tabUrls().includes(u)) ? true : undefined));
    opened.push(...win.state().tabs.filter((t) => !before.has(t.id)).map((t) => t.id));
    check("bookmarks bar: a middle click on a folder opens its bookmarks in background tabs", Boolean(all) && opened.length === inFolderUrls.length && win.state().activeTabId === active, {
      opened: opened.length,
      expected: inFolderUrls,
    });
    const many = add({ parentId: BAR_FOLDER_ID, kind: "folder", title: "Bar many", index: 4 });
    for (let n = 0; n <= OPEN_ALL_ASK_ABOVE; n++) add({ parentId: many, kind: "bookmark", title: `Many ${n}`, url: `${url}ux-plain?many=${n}` });
    await waitForJs(chrome, `document.querySelector('.bar-item[data-bookmark-id="${many}"]')`);
    const count = win.state().tabs.length;
    await middleClick(many);
    const asked = await waitFor(() => win.state().dialog ?? undefined);
    // Escape goes to the dialog once the chrome UI shows it.
    const showing = await waitForJs(chrome, "document.querySelector('.dialog-card')");
    await chrome.executeJavaScript("document.querySelector('.dialog-card')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
    const declined = await waitFor(() => (win.state().dialog === null ? true : undefined));
    await sleep(300);
    check(
      `bookmarks bar: a middle click on a folder of more than ${OPEN_ALL_ASK_ABOVE} bookmarks asks first, and Cancel opens none`,
      Boolean(asked?.title.includes(String(OPEN_ALL_ASK_ABOVE + 1))) && showing && Boolean(declined) && win.state().tabs.length === count,
      { asked: asked?.title ?? null, showing, declined: Boolean(declined), tabs: win.state().tabs.length - count },
    );

    // 4. The "»" menu: what does not fit, each with the icon the bar shows (the site's from Corvus's
    // cache, a letter tile for a site without one, the folder).
    for (let n = 0; n < 30; n++) add({ parentId: BAR_FOLDER_ID, kind: "bookmark", title: `Overflowing bookmark number ${n}`, url: `${url}favicon-page?bar=${n}` });
    const letter = add({ parentId: BAR_FOLDER_ID, kind: "bookmark", title: "No icon here", url: "http://bar-overflow.invalid/" });
    const lastFolder = add({ parentId: BAR_FOLDER_ID, kind: "folder", title: "Folder at the end" });
    add({ parentId: lastFolder, kind: "bookmark", title: "Inside", url: `${url}ux-plain?end` });
    const overflowing = await waitForJs(chrome, "document.querySelector('.bookmarks-bar .bar-more')", 8000);
    const overflow = overflowing ? await nextMenu(() => chrome.executeJavaScript("document.querySelector('.bookmarks-bar .bar-more').click()")) : undefined;
    const iconOf = (label: string): Electron.NativeImage | null => {
      const icon = overflow?.items.find((i) => i.label === label)?.icon;
      return icon && typeof icon !== "string" && !icon.isEmpty() ? icon : null;
    };
    const entries = overflow?.items ?? [];
    const withIcons = entries.filter((i) => i.icon && typeof i.icon !== "string" && !i.icon.isEmpty() && i.icon.getSize().width === 16);
    check(
      "bookmarks bar: every entry of the \"»\" menu shows its icon (the site's, a letter tile, the folder)",
      entries.length > 0 && withIcons.length === entries.length && Boolean(iconOf("Overflowing bookmark number 29") && iconOf(bookmarks.get(letter)?.title ?? "") && iconOf("Folder at the end")),
      { entries: entries.length, withIcons: withIcons.length, missing: entries.filter((i) => !withIcons.includes(i)).map((i) => i.label) },
    );
  } catch (err) {
    check("bookmarks bar smoke", false, err instanceof Error ? err.message : String(err));
  } finally {
    Menu.prototype.popup = popup;
    // A question left open by a failed step would hold back the next smoke's dialogs.
    const left = win.state().dialog;
    if (left) ctx.dialogs.answer(win, left.id, { button: left.cancelId });
    for (const id of opened) win.closeTab(id);
    for (const id of created.reverse()) if (bookmarks.get(id)) bookmarks.remove(id);
    ctx.settings.update({ appearance: { showBookmarksBar: barShown } });
    await sleep(200);
  }
}
