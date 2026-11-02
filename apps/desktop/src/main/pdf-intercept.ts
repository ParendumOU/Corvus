import type { DownloadItem } from "electron";
import { hasOwnPage } from "../shared/download-trust";
import { PDF_MAX_BYTES, isAttachmentDisposition, isPdfUrl, isSupportedPdfSource, pdfViewerUrl } from "../shared/pdf-ipc";
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
 * PDFs that arrive as a download (Content-Disposition, a .aspx link, a form post): the download
 * finishes into a capture (PdfCaptures) and the originating tab opens the viewer on those very
 * bytes, so a one-time link or a session cookie is never needed twice. An attachment from a tab that
 * keeps its page (a webmail's Download button), Save-As, "download without the viewer", agent
 * downloads and PDFs over the size cap stay downloads. Returns true when the PDF went to the viewer
 * (the caller then leaves the item alone: it is not listed as a download).
 */
export function maybeInterceptPdf(
  ctx: AppContext,
  item: DownloadItem,
  located: { window: BrowserWindowCtl; tab: TabRuntime } | undefined,
  keepAsDownload: boolean,
): boolean {
  if (!located || located.tab.agentControlled || keepAsDownload) return false;
  if (!ctx.settings.get().pdf.openInViewer) return false;
  const url = item.getURL();
  // A file a page made itself (blob:, data:: a web app's export, the viewer's own Download) is meant to be saved.
  if (!isSupportedPdfSource(url)) return false;
  if (item.getMimeType() !== "application/pdf" && !isPdfUrl(url)) return false;
  const { window, tab } = located;
  // A page that stays (a webmail's Download button) asked for the file to be saved: save it, as
  // every browser does. A tab opened only for the PDF (a bank's one-time link) shows it instead.
  if (isAttachmentDisposition(item.getContentDisposition()) && hasOwnPage(tab.committedUrl)) return false;
  if (item.getTotalBytes() > PDF_MAX_BYTES) return false;
  const capture = ctx.pdfCaptures.capture(item, window.profile.profile.id, url);
  // Defer: the navigation that turned into this download is still being torn down on this webContents.
  setImmediate(() => {
    if (!window.isDisposed()) window.loadUrl(tab.id, pdfViewerUrl(url, capture));
  });
  return true;
}
