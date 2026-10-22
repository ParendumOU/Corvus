import { parseTarget } from "./scope.js";
import type { CapturedResponse, HistoryEntry, HttpHeader } from "./types.js";

interface HarHeader {
  name: string;
  value: string;
}
interface HarEntry {
  startedDateTime: string;
  time: number;
  request: { method: string; url: string; httpVersion: string; headers: HarHeader[]; queryString: HarHeader[]; cookies: []; headersSize: number; bodySize: number; postData?: { mimeType: string; text: string } };
  response: { status: number; statusText: string; httpVersion: string; headers: HarHeader[]; cookies: []; content: { size: number; mimeType: string; text?: string; encoding?: string }; redirectURL: string; headersSize: number; bodySize: number };
  cache: Record<string, never>;
  timings: { send: number; wait: number; receive: number };
}
interface Har {
  log: { version: string; creator: { name: string; version: string }; entries: HarEntry[] };
}

function headerFor(name: string, headers: HttpHeader[]): string {
  const lower = name.toLowerCase();
  return headers.find((h) => h.name.toLowerCase() === lower)?.value ?? "";
}

function exportEntry(entry: HistoryEntry): HarEntry {
  const res = entry.response;
  const contentType = res ? headerFor("content-type", res.headers) : "";
  const content: HarEntry["response"]["content"] = {
    size: res?.size ?? 0,
    mimeType: res?.mimeType ?? contentType,
    ...(res?.body !== undefined ? { text: res.body } : {}),
    ...(res?.bodyBase64 ? { encoding: "base64" } : {}),
  };
  return {
    startedDateTime: new Date(entry.startedAt).toISOString(),
    time: entry.durationMs ?? 0,
    request: {
      method: entry.request.method,
      url: entry.request.url,
      httpVersion: "HTTP/1.1",
      headers: entry.request.headers.map((h) => ({ name: h.name, value: h.value })),
      queryString: [...new URL(entry.request.url).searchParams.entries()].map(([name, value]) => ({ name, value })),
      cookies: [],
      headersSize: -1,
      bodySize: entry.request.body ? entry.request.body.length : 0,
      ...(entry.request.body !== undefined
        ? { postData: { mimeType: headerFor("content-type", entry.request.headers) || "application/octet-stream", text: entry.request.body } }
        : {}),
    },
    response: {
      status: res?.status ?? 0,
      statusText: res?.statusText ?? "",
      httpVersion: "HTTP/1.1",
      headers: res?.headers.map((h) => ({ name: h.name, value: h.value })) ?? [],
      cookies: [],
      content,
      redirectURL: res ? headerFor("location", res.headers) : "",
      headersSize: -1,
      bodySize: res?.size ?? 0,
    },
    cache: {},
    timings: { send: 0, wait: entry.durationMs ?? 0, receive: 0 },
  };
}

export function exportHar(entries: HistoryEntry[], creator = { name: "Corvus WebScope", version: "0.1.0" }): Har {
  return { log: { version: "1.2", creator, entries: entries.map(exportEntry) } };
}

function importResponse(har: HarEntry): CapturedResponse | undefined {
  if (!har.response || har.response.status === 0) return undefined;
  const content = har.response.content ?? { size: 0, mimeType: "" };
  const base64 = content.encoding === "base64";
  return {
    status: har.response.status,
    ...(har.response.statusText ? { statusText: har.response.statusText } : {}),
    headers: (har.response.headers ?? []).map((h) => ({ name: h.name, value: h.value })),
    ...(content.text !== undefined ? { body: content.text } : {}),
    ...(base64 ? { bodyBase64: true } : {}),
    ...(content.mimeType ? { mimeType: content.mimeType } : {}),
    size: content.size ?? 0,
  };
}

export interface ImportOptions {
  profileId?: string;
  inScope?: (url: string) => boolean;
  nextId?: () => string;
}

/** Parse a HAR log into history entries. Throws when the document is not a HAR 1.x log. */
export function importHar(json: unknown, opts: ImportOptions = {}): HistoryEntry[] {
  const har = json as Har | undefined;
  if (!har?.log || !Array.isArray(har.log.entries)) throw new Error("Not a HAR document: missing log.entries");
  const out: HistoryEntry[] = [];
  let counter = 0;
  for (const har1 of har.log.entries) {
    const url = har1.request?.url;
    const target = url ? parseTarget(url) : null;
    if (!target) continue;
    const response = importResponse(har1);
    out.push({
      id: opts.nextId ? opts.nextId() : `har-${(counter++).toString(36)}`,
      profileId: opts.profileId ?? "import",
      startedAt: har1.startedDateTime ? Date.parse(har1.startedDateTime) || Date.now() : Date.now(),
      durationMs: typeof har1.time === "number" ? har1.time : 0,
      host: target.host,
      path: target.path,
      type: "other",
      inScope: opts.inScope ? opts.inScope(url as string) : false,
      source: "capture",
      request: {
        method: har1.request.method || "GET",
        url: url as string,
        headers: (har1.request.headers ?? []).map((h) => ({ name: h.name, value: h.value })),
        ...(har1.request.postData?.text !== undefined ? { body: har1.request.postData.text } : {}),
      },
      ...(response ? { response } : {}),
    });
  }
  return out;
}
