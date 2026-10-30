import type { WebContents } from "electron";

/** What holds a page: a WebContentsView (a tab's, a side panel's). */
interface PageHolder {
  readonly webContents: WebContents;
}

/**
 * A view's page, or null once it is closed. Electron drops a closed page from its view
 * (`webContents` turns undefined, not just destroyed), so code that may run after its tab closed
 * (after an await, in a timer or an event, from a menu that stayed open) asks here and bails on null.
 */
export function pageOf(view: PageHolder | null | undefined): WebContents | null {
  const wc = view?.webContents as WebContents | undefined;
  return wc && !wc.isDestroyed() ? wc : null;
}

/** The address a tab's page is on, else the one the tab keeps (its page closed, asleep or not loaded yet). */
export function pageUrl(tab: { readonly view: PageHolder; readonly url: string }): string {
  return pageOf(tab.view)?.getURL() || tab.url;
}
