import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { net } from "electron";
import { type AssistPage, type AssistTask, parseSummary, readingMinutes, runAssist } from "@corvus/ai-engine";
import type { InternalPage } from "../shared/internal-urls";
import {
  buildPdfMarkdown,
  capPagesForAi,
  isSupportedPdfSource,
  PDF_MAX_BYTES,
  pdfExcerpt,
  pdfTitleFromSource,
  type PdfAiRequest,
  type PdfAiResult,
  type PdfAiUsage,
  type PdfDocMeta,
  type PdfFetchResult,
  type PdfPageText,
  type PdfRpc,
  type PdfSaveRequest,
} from "../shared/pdf-ipc";
import type { ReadingItem } from "../shared/reading";
import type { AppContext } from "./context";
import type { ProfileRuntime } from "./profiles";
import type { BrowserWindowCtl } from "./window";

class IpcError extends Error {}

interface InternalContext {
  profile: ProfileRuntime;
  window: BrowserWindowCtl | undefined;
}

type InternalHandlers<T> = {
  [K in keyof T]: T[K] extends (...args: infer A) => infer R ? (c: InternalContext, ...args: A) => R | Promise<Awaited<R>> : never;
};

export const PDF_INTERNAL_PERMISSIONS: Record<keyof PdfRpc, readonly InternalPage[]> = {
  "pdf.fetch": ["pdf"],
  "pdf.ai": ["pdf"],
  "pdf.save": ["pdf"],
  "pdf.isSaved": ["pdf"],
};

const str = (value: unknown, name: string, max: number): string => {
  if (typeof value !== "string" || value.length > max) throw new IpcError(`Invalid ${name}`);
  return value;
};

function parseDoc(value: unknown): PdfDocMeta {
  if (typeof value !== "object" || value === null) throw new IpcError("Invalid doc");
  const v = value as Record<string, unknown>;
  const src = str(v.src, "src", 4096);
  if (!isSupportedPdfSource(src)) throw new IpcError("Unsupported PDF source");
  return {
    src,
    title: typeof v.title === "string" ? v.title.slice(0, 500) : pdfTitleFromSource(src),
    pageCount: typeof v.pageCount === "number" && Number.isFinite(v.pageCount) ? Math.max(0, Math.round(v.pageCount)) : 0,
  };
}

function parsePages(value: unknown): PdfPageText[] {
  if (!Array.isArray(value) || value.length > 10000) throw new IpcError("Invalid pages");
  const out: PdfPageText[] = [];
  for (const raw of value) {
    if (typeof raw !== "object" || raw === null) continue;
    const r = raw as Record<string, unknown>;
    const page = typeof r.page === "number" && Number.isFinite(r.page) ? Math.round(r.page) : 0;
    const text = typeof r.text === "string" ? r.text.slice(0, 200_000) : "";
    if (page >= 1) out.push({ page, text });
  }
  return out;
}

function parseAiRequest(value: unknown): PdfAiRequest {
  if (typeof value !== "object" || value === null) throw new IpcError("Invalid request");
  const v = value as Record<string, unknown>;
  const kinds = ["key-points", "tldr", "simplify", "eli5", "translate", "ask", "explain"];
  const kind = typeof v.kind === "string" && kinds.includes(v.kind) ? (v.kind as PdfAiRequest["kind"]) : null;
  if (!kind) throw new IpcError("Invalid AI tool");
  return {
    kind,
    doc: parseDoc(v.doc),
    pages: parsePages(v.pages),
    ...(typeof v.input === "string" ? { input: v.input.slice(0, 4000) } : {}),
  };
}

function parseSaveRequest(value: unknown): PdfSaveRequest {
  if (typeof value !== "object" || value === null) throw new IpcError("Invalid request");
  const v = value as Record<string, unknown>;
  const keyPoints = Array.isArray(v.keyPoints)
    ? v.keyPoints.filter((k): k is string => typeof k === "string").slice(0, 12).map((k) => k.slice(0, 500))
    : [];
  return { doc: parseDoc(v.doc), pages: parsePages(v.pages), keyPoints };
}

async function fetchPdf(src: string): Promise<PdfFetchResult> {
  if (!isSupportedPdfSource(src)) throw new IpcError("Unsupported PDF source");
  if (new URL(src).protocol === "file:") {
    const filePath = fileURLToPath(src);
    const stat = await fs.stat(filePath);
    if (stat.size > PDF_MAX_BYTES) throw new IpcError("This PDF is too large to open.");
    const buf = await fs.readFile(filePath);
    return { data: new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength), contentType: "application/pdf", filename: path.basename(filePath) };
  }
  const res = await net.fetch(src, { redirect: "follow" });
  if (!res.ok) throw new IpcError(`Could not load the PDF (HTTP ${res.status}).`);
  const declared = Number(res.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > PDF_MAX_BYTES) throw new IpcError("This PDF is too large to open.");
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.byteLength > PDF_MAX_BYTES) throw new IpcError("This PDF is too large to open.");
  return { data: buf, contentType: res.headers.get("content-type") ?? "application/pdf", filename: pdfTitleFromSource(src) };
}

async function runPdfAi(ctx: AppContext, req: PdfAiRequest): Promise<PdfAiResult> {
  const info = ctx.assist.readerProviderInfo();
  const provider = info.provider;
  if (!provider) throw new IpcError(info.setupReason ?? "The reading tools need an AI provider. Open Settings to add one.");
  const pages = capPagesForAi(req.pages);
  if (pages.every((p) => !p.text.trim())) throw new IpcError("This PDF has no extractable text (it may be a scan).");
  const sections = pages.map((p) => ({ heading: `Page ${p.page}`, text: p.text }));
  const page: AssistPage = { url: req.doc.src, title: req.doc.title, sections };
  const lang = info.lang;

  let task: AssistTask;
  if (req.kind === "translate") {
    task = { kind: "translate-article", page, lang: ctx.settings.get().reader.translateLanguage || lang };
  } else if (req.kind === "ask") {
    const question = (req.input ?? "").trim();
    if (!question) throw new IpcError("Type a question about the PDF.");
    task = { kind: "ask", page, lang, question, history: [] };
  } else if (req.kind === "explain") {
    const selection = (req.input ?? "").trim();
    if (!selection) throw new IpcError("Select some text to explain.");
    task = { kind: "explain", selection, lang, page: { title: req.doc.title, url: req.doc.src } };
  } else {
    task = { kind: req.kind, page, lang };
  }

  const started = Date.now();
  let text = "";
  let usage: PdfAiUsage | undefined;
  for await (const ev of runAssist(provider, task)) {
    if (ev.type === "delta") text += ev.text;
    else usage = { inputTokens: ev.inputTokens, outputTokens: ev.outputTokens, model: ev.model, ms: Date.now() - started };
  }
  const final = text.trim();
  const result: PdfAiResult = { text: final, ...(usage ? { usage } : {}) };
  if (req.kind === "key-points") {
    result.points = parseSummary(final, sections.length).points.map((pt) => ({
      text: pt.text,
      pages: pt.sections.map((i) => pages[i]?.page).filter((n): n is number => typeof n === "number"),
    }));
  }
  return result;
}

function wordCount(text: string): number {
  const t = text.trim();
  return t ? t.split(/\s+/).length : 0;
}

function savePdf(c: InternalContext, req: PdfSaveRequest): boolean {
  const text = req.pages.map((p) => p.text).join(" ");
  const item: ReadingItem = {
    id: crypto.randomUUID(),
    url: req.doc.src,
    title: req.doc.title || pdfTitleFromSource(req.doc.src),
    siteName: "PDF",
    byline: "",
    excerpt: pdfExcerpt(req.pages),
    markdown: buildPdfMarkdown(req.doc, req.pages),
    keyPoints: req.keyPoints,
    wordCount: wordCount(text),
    readingMinutes: readingMinutes(text),
    savedAt: Date.now(),
  };
  c.profile.reading.save(item);
  return true;
}

export function pdfInternalHandlers(ctx: AppContext): InternalHandlers<PdfRpc> {
  return {
    "pdf.fetch": (_c, src) => fetchPdf(str(src, "src", 4096)),
    "pdf.ai": (_c, req) => runPdfAi(ctx, parseAiRequest(req)),
    "pdf.save": (c, req) => savePdf(c, parseSaveRequest(req)),
    "pdf.isSaved": (c, src) => c.profile.reading.hasUrl(str(src, "src", 4096)),
  };
}
