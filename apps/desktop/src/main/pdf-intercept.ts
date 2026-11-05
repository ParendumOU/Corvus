import type { DownloadItem } from "electron";
import { hasOwnPage } from "../shared/download-trust";
import { isInternalUrl } from "../shared/internal-urls";
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

/** How long after the person's click or key press in a tab a PDF it leads to may open a tab of its own. */
export const PDF_BESIDE_INPUT_MS = 10_000;

/** Whether the tab shows a page of its own, which a PDF should not replace: not a tab opened for the PDF, not a Corvus page. */
export function pdfKeepsPage(tab: Pick<TabRuntime, "committedUrl">): boolean {
  return hasOwnPage(tab.committedUrl) && !isInternalUrl(tab.committedUrl ?? "");
}

/**
 * Whether a PDF a page leads to opens its viewer in a new tab next to it (as a link with
 * target=_blank would), so the page stays where it was. Only right after the person's own click or
 * key press in the tab, and once per input: the page's own scripts (location.href in a loop, a.click())
 * would otherwise open tab after tab, and the popup blocker never sees these. Without one the tab
 * shows the viewer itself, as before.
 */
export function pdfOpensBesidePage(tab: Pick<TabRuntime, "committedUrl" | "personInputAt" | "pdfBesideInputAt">, now = Date.now()): boolean {
  const input = tab.personInputAt;
  return pdfKeepsPage(tab) && input !== undefined && now - input <= PDF_BESIDE_INPUT_MS && input !== tab.pdfBesideInputAt;
}

/** pdfOpensBesidePage, using up the input that allows it, so one click opens at most one tab. */
export function claimPdfBeside(tab: TabRuntime, now = Date.now()): boolean {
  if (!pdfOpensBesidePage(tab, now)) return false;
  tab.pdfBesideInputAt = tab.personInputAt;
  return true;
}

/**
 * PDFs that arrive as a download (Content-Disposition, a .aspx link, a form post): the download
 * finishes into a capture (PdfCaptures) and the viewer opens on those very bytes (next to the page
 * after the person's click, see pdfOpensBesidePage), so a one-time link or a session cookie is never
 * needed twice. An attachment from a tab that keeps its page (a webmail's Download button, unless
 * pdf.openAttachments is on and the person clicked for it), Save-As, "download without the viewer",
 * agent downloads and PDFs over the size cap stay downloads. Returns true when the PDF went to the viewer
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
  if (item.getTotalBytes() > PDF_MAX_BYTES) return false;
  const { window, tab } = located;
  // A page that stays (a webmail's Download button) asked for the file to be saved: save it, as
  // every browser does, unless the person chose to see such PDFs first and clicked for this one. A
  // tab opened only for the PDF (a bank's one-time link) shows it instead.
  const preview = ctx.settings.get().pdf.openAttachments && pdfOpensBesidePage(tab);
  if (isAttachmentDisposition(item.getContentDisposition()) && pdfKeepsPage(tab) && !preview) return false;
  // Another PDF the page sends opens next to it after the person's click, else in the tab, as before.
  const beside = claimPdfBeside(tab);
  const capture = ctx.pdfCaptures.capture(item, window.profile.profile.id, url);
  const viewer = pdfViewerUrl(url, capture);
  // Defer: the navigation that turned into this download is still being torn down on this webContents.
  setImmediate(() => {
    if (window.isDisposed()) return;
    // The viewer reads the captured bytes, so it needs none of the tab's cookies or container.
    if (beside && window.hasTab(tab.id)) window.createTab(viewer, { activate: true, openerId: tab.id });
    else window.loadUrl(tab.id, viewer);
  });
  return true;
}
