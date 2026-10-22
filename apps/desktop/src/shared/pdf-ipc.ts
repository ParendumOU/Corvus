/**
 * Contract + pure helpers for the in-app PDF viewer (corvus://pdf). The viewer is a normal internal
 * page (a tab); the main process fetches the PDF bytes (internal-page CSP forbids cross-origin
 * fetch) and runs the EXISTING AI reading tools over the PDF, treating each page as one cited
 * section. PDF text is untrusted and is fenced by runAssist like any other page content.
 */

/** Hard cap on fetched PDF size (bytes). */
export const PDF_MAX_BYTES = 75 * 1024 * 1024;
export const PDF_ZOOM_MIN = 0.25;
export const PDF_ZOOM_MAX = 4;
/** Max total page text the viewer ships to the main process for one AI call. */
export const PDF_AI_MAX_CHARS = 180_000;

/** Reader AI tools reused for PDFs. "key-points" cites pages like the reader cites sections. */
export type PdfAiKind = "key-points" | "tldr" | "simplify" | "eli5" | "translate" | "ask" | "explain";

export const PDF_AI_TOOLS: ReadonlyArray<{ kind: PdfAiKind; label: string }> = [
  { kind: "key-points", label: "Key points" },
  { kind: "tldr", label: "TL;DR" },
  { kind: "simplify", label: "Simplify" },
  { kind: "eli5", label: "Explain like I'm 5" },
  { kind: "translate", label: "Translate" },
];

export interface PdfPageText {
  /** 1-based page number. */
  page: number;
  text: string;
}

export interface PdfDocMeta {
  src: string;
  title: string;
  pageCount: number;
}

export interface PdfFetchResult {
  data: Uint8Array;
  contentType: string;
  filename: string;
}

export interface PdfAiRequest {
  kind: PdfAiKind;
  doc: PdfDocMeta;
  /** Contiguous page text starting at page 1, so a `[n]` citation maps to page `n`. */
  pages: PdfPageText[];
  /** For ask/explain: the user's question or the selected text. */
  input?: string;
}

export interface PdfAiPoint {
  text: string;
  /** 1-based page numbers the point is drawn from. */
  pages: number[];
}

export interface PdfAiUsage {
  inputTokens: number;
  outputTokens: number;
  model: string;
  ms: number;
}

export interface PdfAiResult {
  text: string;
  /** Present for key-points: bullet points with their page citations. */
  points?: PdfAiPoint[];
  usage?: PdfAiUsage;
}

export interface PdfSaveRequest {
  doc: PdfDocMeta;
  pages: PdfPageText[];
  /** AI key points captured at save time (same as the reader library). */
  keyPoints: string[];
}

export interface PdfRpc {
  "pdf.fetch"(src: string): PdfFetchResult;
  "pdf.ai"(req: PdfAiRequest): PdfAiResult;
  "pdf.save"(req: PdfSaveRequest): boolean;
  "pdf.isSaved"(src: string): boolean;
}

const PDF_SCHEMES = ["http:", "https:", "file:"];

/** A source URL the viewer can load (and the main process will fetch). */
export function isSupportedPdfSource(src: string): boolean {
  try {
    return PDF_SCHEMES.includes(new URL(src).protocol);
  } catch {
    return false;
  }
}

/** URL whose path ends in `.pdf` on a supported scheme. */
export function isPdfUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (!PDF_SCHEMES.includes(u.protocol)) return false;
    return /\.pdf$/i.test(decodeURIComponent(u.pathname));
  } catch {
    return false;
  }
}

export function pdfViewerUrl(src: string): string {
  return `corvus://pdf/?src=${encodeURIComponent(src)}`;
}

/** Extracts and validates the source URL from a corvus://pdf viewer URL; null if not one. */
export function pdfSrcFromViewer(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== "corvus:" || u.hostname !== "pdf") return null;
    const src = u.searchParams.get("src");
    return src && isSupportedPdfSource(src) ? src : null;
  } catch {
    return null;
  }
}

/** A human title from the source filename, falling back to the host. */
export function pdfTitleFromSource(src: string): string {
  try {
    const u = new URL(src);
    const name = decodeURIComponent(u.pathname.split("/").filter(Boolean).pop() ?? "");
    return name || u.hostname || "PDF";
  } catch {
    return "PDF";
  }
}

/** Keeps contiguous leading pages within the character budget so citations stay page-aligned. */
export function capPagesForAi(pages: PdfPageText[], maxChars = PDF_AI_MAX_CHARS): PdfPageText[] {
  const out: PdfPageText[] = [];
  let used = 0;
  for (const p of pages) {
    const text = p.text ?? "";
    if (used + text.length > maxChars && out.length > 0) break;
    out.push({ page: p.page, text });
    used += text.length;
  }
  return out;
}

/** Export/save Markdown: reader-compatible header (with the `<src>` marker) + one `## Page N` block each. */
export function buildPdfMarkdown(doc: PdfDocMeta, pages: PdfPageText[]): string {
  const header = `# ${doc.title || pdfTitleFromSource(doc.src)}\n\n<${doc.src}>`;
  const body = pages
    .filter((p) => p.text.trim())
    .map((p) => `## Page ${p.page}\n\n${p.text.trim()}`)
    .join("\n\n");
  return body ? `${header}\n\n${body}\n` : `${header}\n`;
}

/** First non-empty page text, trimmed to a short excerpt for the reading library card. */
export function pdfExcerpt(pages: PdfPageText[], max = 280): string {
  const first = pages.find((p) => p.text.trim())?.text.trim() ?? "";
  const collapsed = first.replace(/\s+/g, " ");
  return collapsed.length > max ? `${collapsed.slice(0, max - 1)}…` : collapsed;
}
