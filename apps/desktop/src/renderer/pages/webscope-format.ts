/**
 * Pure, DOM-free helpers for the WebScope workbench: formatting, body pretty-printing, hex dumps
 * and fuzzer planning previews. Kept JSX-free so they are unit-tested in Node (test/webscope-format.test.ts).
 */
import type { HttpHeader, OutboundRequest } from "@corvus/webscope";

// ------------------------------------------------------------------ format helpers

export function methodClass(method: string): string {
  return `badge m-${method.toLowerCase()}`;
}

export function statusClass(status: number | null): string {
  if (status === null) return "st-5";
  return `st-${Math.floor(status / 100)}`;
}

export function fmtBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} kB`;
  return `${n} B`;
}

export function fmtMs(ms: number | null): string {
  return ms === null ? "-" : `${ms} ms`;
}

export function fmtClock(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, { hour12: false });
}

export function headersToText(headers: HttpHeader[]): string {
  return headers.map((h) => `${h.name}: ${h.value}`).join("\n");
}

export function textToHeaders(text: string): HttpHeader[] {
  const out: HttpHeader[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const idx = trimmed.indexOf(":");
    if (idx <= 0) continue;
    out.push({ name: trimmed.slice(0, idx).trim(), value: trimmed.slice(idx + 1).trim() });
  }
  return out;
}

export function newId(): string {
  return crypto.randomUUID();
}

export interface RequestDraft {
  method: string;
  url: string;
  headersText: string;
  body: string;
  useProfileCookies: boolean;
  followRedirects: boolean;
}

export function emptyDraft(): RequestDraft {
  return { method: "GET", url: "", headersText: "", body: "", useProfileCookies: false, followRedirects: false };
}

export function draftToRequest(d: RequestDraft): OutboundRequest {
  return {
    method: d.method,
    url: d.url.trim(),
    headers: textToHeaders(d.headersText),
    ...(d.body ? { body: d.body } : {}),
    ...(d.useProfileCookies ? { useProfileCookies: true } : {}),
    ...(d.followRedirects ? { followRedirects: true } : {}),
  };
}

// ------------------------------------------------------------------ body formatting

const PRETTY_LIMIT = 512 * 1024; // skip pretty-printing very large bodies

/** Decode a captured body to bytes for a hex view; base64 for binary, UTF-8 otherwise. */
export function bodyBytes(body: string | undefined, base64: boolean | undefined): Uint8Array {
  if (!body) return new Uint8Array();
  try {
    if (base64) {
      const bin = atob(body);
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    }
    return new TextEncoder().encode(body);
  } catch {
    return new Uint8Array();
  }
}

/** Classic offset | hex | ascii dump, capped so huge bodies never lock the UI. */
export function hexDump(bytes: Uint8Array, maxBytes = 8192): string {
  const n = Math.min(bytes.length, maxBytes);
  const lines: string[] = [];
  for (let off = 0; off < n; off += 16) {
    const slice = bytes.subarray(off, Math.min(off + 16, n));
    const hex: string[] = [];
    let ascii = "";
    for (let i = 0; i < 16; i++) {
      if (i < slice.length) {
        const b = slice[i] ?? 0;
        hex.push(b.toString(16).padStart(2, "0"));
        ascii += b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : ".";
      } else {
        hex.push("  ");
        ascii += " ";
      }
      if (i === 7) hex.push("");
    }
    lines.push(`${off.toString(16).padStart(8, "0")}  ${hex.join(" ")}  ${ascii}`);
  }
  if (bytes.length > maxBytes) lines.push(`… ${bytes.length - maxBytes} more bytes`);
  return lines.join("\n");
}

function looksJson(mime: string | undefined, body: string): boolean {
  if (mime && /json/i.test(mime)) return true;
  const t = body.trimStart();
  return t.startsWith("{") || t.startsWith("[");
}

function looksHtml(mime: string | undefined, body: string): boolean {
  if (mime && /html|xml/i.test(mime)) return true;
  return /^\s*<(!doctype|html|\?xml)/i.test(body);
}

const VOID_TAGS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);

/** Light, dependency-free HTML/XML indenter. Heuristic, good enough to read structure. */
function prettyHtml(src: string): string {
  const parts = src.replace(/>\s*</g, ">\n<").split("\n");
  let depth = 0;
  const out: string[] = [];
  for (const raw of parts) {
    const line = raw.trim();
    if (!line) continue;
    const closing = /^<\//.test(line);
    const tagName = (line.match(/^<\/?([a-zA-Z0-9-]+)/)?.[1] ?? "").toLowerCase();
    const selfClose = /\/>\s*$/.test(line) || VOID_TAGS.has(tagName);
    const opensAndCloses = /^<[^/!?][^>]*>.*<\/[a-zA-Z0-9-]+>\s*$/.test(line);
    const opening = /^<[^/!?]/.test(line) && !selfClose && !opensAndCloses;
    if (closing) depth = Math.max(0, depth - 1);
    out.push("  ".repeat(depth) + line);
    if (opening) depth++;
  }
  return out.join("\n");
}

/** Pretty-print a body for the Pretty tab; falls back to the raw text when it cannot. */
export function prettyBody(body: string | undefined, mime: string | undefined, base64: boolean | undefined): { text: string; note?: string } {
  if (base64) return { text: "", note: "Binary body - use the Hex tab." };
  if (!body) return { text: "" };
  if (body.length > PRETTY_LIMIT) return { text: body, note: "Body too large to reformat; showing raw." };
  if (looksJson(mime, body)) {
    try {
      return { text: JSON.stringify(JSON.parse(body), null, 2) };
    } catch {
      /* fall through to raw */
    }
  }
  if (looksHtml(mime, body)) {
    try {
      return { text: prettyHtml(body) };
    } catch {
      /* fall through */
    }
  }
  return { text: body };
}


// ------------------------------------------------------------------ fuzzer planning preview

export type AttackKind = "sniper" | "cluster-bomb" | "pitchfork";

export interface PayloadSetDraft {
  kind: "wordlist" | "numbers" | "charset";
  text: string;
  from: string;
  to: string;
  step: string;
}

/** Number of `§...§` payload positions across the given template fields. */
export function countPositions(...fields: string[]): number {
  return fields.reduce((n, f) => n + (f.match(/§[^§]*§/g) ?? []).length, 0);
}

/** How many payloads a set expands to; mirrors expandPayloadSet in @corvus/webscope. */
export function payloadSetSize(d: PayloadSetDraft): number {
  if (d.kind === "wordlist") return d.text.split("\n").map((s) => s.trim()).filter(Boolean).length;
  if (d.kind === "charset") return [...d.text.replace(/\n/g, "")].length;
  const from = Number(d.from) || 0;
  const to = Number(d.to) || 0;
  const step = Math.abs(Number(d.step)) || 1;
  return Math.floor(Math.abs(to - from) / step) + 1;
}

/** Requests an attack will issue; mirrors planRequests in @corvus/webscope. */
export function plannedRequests(attack: AttackKind, positions: number, setSizes: number[]): number {
  if (positions === 0) return 1; // the template is sent once, unchanged
  if (attack === "sniper") return positions * (setSizes[0] ?? 0);
  if (attack === "pitchfork") return Math.min(...Array.from({ length: positions }, (_, i) => setSizes[i] ?? 0));
  const per = Array.from({ length: positions }, (_, i) => setSizes[i] ?? setSizes[setSizes.length - 1] ?? 0);
  return per.reduce((a, b) => a * b, 1);
}
