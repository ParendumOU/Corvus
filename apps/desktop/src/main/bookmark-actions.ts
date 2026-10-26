/**
 * What the bookmarks bar does with a bookmark beyond opening it: Edit… in Corvus's dialog, opening
 * a whole folder (a middle click, or "Open all"), and the site icons its "»" menu shows.
 */
import { OPEN_ALL_ASK_ABOVE, ROOT_IDS, bookmarkUrlFromInput, folderUrls } from "../shared/bookmark-tree";
import type { AppContext } from "./context";
import { tr } from "./menu-i18n";
import type { BrowserWindowCtl } from "./window";

/** How long the "»" menu waits for a site icon Corvus does not have yet (the bar asked for it already). */
const ICON_WAIT_MS = 400;

/**
 * Edit… on a bookmark (or folder) of the bar: its name and address in Corvus's dialog, saved with
 * bookmarks.update as the bookmarks page saves them (an address is completed the same way; an empty
 * name keeps the old one). Resolves true when it was saved.
 */
export async function editBookmark(ctx: AppContext, win: BrowserWindowCtl, id: string): Promise<boolean> {
  const node = win.profile.bookmarks.get(id);
  if (!node || ROOT_IDS.has(id)) return false;
  const folder = node.kind === "folder";
  const answer = await ctx.dialogs.ask(
    {
      tone: "question",
      title: folder ? tr("Edit folder") : tr("Edit bookmark"),
      message: "",
      fields: [
        { label: tr("Name"), value: node.title },
        ...(folder ? [] : [{ label: tr("URL"), value: node.url ?? "", placeholder: "https://", required: tr("Enter a URL") }]),
      ],
      buttons: [tr("Cancel"), tr("Save")],
      defaultId: 1,
      cancelId: 0,
    },
    win,
  );
  // Gone meanwhile (deleted on another device and synced): nothing to save.
  if (answer.button !== 1 || !win.profile.bookmarks.get(id)) return false;
  const [title = node.title, typed = ""] = answer.values ?? [];
  const url = folder ? null : bookmarkUrlFromInput(typed);
  win.profile.bookmarks.update(id, { title, ...(url ? { url } : {}) });
  return true;
}

/**
 * A folder's own bookmarks in background tabs (what "Open all" opens), after asking when there are
 * more than OPEN_ALL_ASK_ABOVE. Returns how many were opened.
 */
export async function openBookmarkFolder(ctx: AppContext, win: BrowserWindowCtl, folderId: string): Promise<number> {
  const folder = win.profile.bookmarks.get(folderId);
  if (folder?.kind !== "folder") return 0;
  const urls = folderUrls(win.profile.bookmarks.list(), folderId);
  if (urls.length > OPEN_ALL_ASK_ABOVE) {
    const { button } = await ctx.dialogs.ask(
      {
        tone: "question",
        title: tr("Open {count} tabs?", { count: urls.length }),
        message: tr("Open {count} tabs?", { count: urls.length }),
        detail: tr("Every bookmark in “{folder}” opens in a new tab.", { folder: folder.title }),
        buttons: [tr("Cancel"), tr("Open all")],
        defaultId: 1,
        cancelId: 0,
      },
      win,
    );
    if (button !== 1 || win.win.isDestroyed()) return 0;
  }
  for (const url of urls) win.openUrl(url, "background-tab");
  return urls.length;
}

/**
 * The cached icons of these pages' sites (the store corvus://favicon/ serves the bar from), as data:
 * URLs for the chrome UI to draw into the "»" menu. One the cache does not have in time is null.
 */
export async function siteIcons(win: BrowserWindowCtl, urls: string[]): Promise<Array<string | null>> {
  const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), ICON_WAIT_MS));
  return Promise.all(
    urls.map(async (url) => {
      if (!/^https?:/i.test(url)) return null;
      const icon = await Promise.race([win.profile.favicons.icon(url).catch(() => null), timeout]);
      return icon ? `data:${icon.type};base64,${icon.body.toString("base64")}` : null;
    }),
  );
}
