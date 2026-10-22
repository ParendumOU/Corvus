import type { DownloadItem } from "electron";
import { isPdfUrl, pdfViewerUrl } from "../shared/pdf-ipc";
import type { AppContext } from "./context";
import type { BrowserWindowCtl, TabRuntime } from "./window";

/**
 * The viewer URL to redirect a navigation to, or null to leave it alone. A PDF URL opened in a
 * normal (non-agent) tab, with the in-app viewer enabled, opens in corvus://pdf instead of
 * Chromium's built-in viewer or a download. Agent tabs keep the raw file (download/inspect tools).
 */
export function pdfViewerRedirect(ctx: AppContext, agentControlled: boolean, url: string): string | null {
  if (agentControlled) return null;
  if (!ctx.settings.get().pdf.openInViewer) return null;
  if (!isPdfUrl(url)) return null;
  return pdfViewerUrl(url);
}

/**
 * Fallback for PDFs served as an attachment (Content-Disposition), which download instead of
 * navigating. Redirect the originating tab to the viewer. Save-As and agent downloads are left
 * alone. Returns true when the caller should preventDefault() the download.
 */
export function maybeInterceptPdf(
  ctx: AppContext,
  item: DownloadItem,
  located: { window: BrowserWindowCtl; tab: TabRuntime } | undefined,
  saveAsUrls: ReadonlySet<string>,
): boolean {
  if (!located || located.tab.agentControlled) return false;
  if (!ctx.settings.get().pdf.openInViewer) return false;
  const url = item.getURL();
  if (saveAsUrls.has(url)) return false;
  if (item.getMimeType() !== "application/pdf" && !isPdfUrl(url)) return false;
  const { window, tab } = located;
  // Defer: the download that triggered this is still being torn down on this webContents.
  setImmediate(() => {
    if (!window.isDisposed()) window.loadUrl(tab.id, pdfViewerUrl(url));
  });
  return true;
}
