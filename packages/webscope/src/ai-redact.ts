/**
 * "Hidden from AI" views of captured traffic. When the browser fills a saved password or 2FA code
 * into a page, the request that submits it is marked `aiHidden`. People still see it in full in the
 * WebScope UI; everything an AI agent or MCP client can read (history rows and search, entry detail,
 * findings, sitemap, HAR export, intercept queue) goes through these functions, which drop the
 * request body and blank the query values in the URL and Referer (GET forms put fields there).
 */
import type { CapturedRequest, HistoryEntry, HttpHeader, InterceptItem } from "./types.js";

export const AI_REDACTED_BODY =
  "[Hidden from AI: the browser filled a saved password or 2FA code into this request. Ask the user to review it in WebScope.]";
export const AI_REDACTED_VALUE = "[hidden]";

/** Keeps query parameter names, replaces every value. Unparseable input is returned unchanged. */
export function redactUrlForAi(url: string): string {
  const at = url.indexOf("?");
  if (at < 0) return url;
  const hash = url.indexOf("#", at);
  const query = url.slice(at + 1, hash < 0 ? undefined : hash);
  const names = query
    .split("&")
    .filter(Boolean)
    .map((pair) => pair.split("=")[0] ?? "");
  const redacted = names.map((name) => `${name}=${AI_REDACTED_VALUE}`).join("&");
  return `${url.slice(0, at)}?${redacted}${hash < 0 ? "" : url.slice(hash)}`;
}

function redactHeaders(headers: HttpHeader[]): HttpHeader[] {
  return headers.map((h) => (h.name.toLowerCase() === "referer" ? { name: h.name, value: redactUrlForAi(h.value) } : h));
}

export function redactRequestForAi(request: CapturedRequest): CapturedRequest {
  const { body, bodyBase64: _binary, ...rest } = request;
  return {
    ...rest,
    url: redactUrlForAi(request.url),
    headers: redactHeaders(request.headers),
    ...(body !== undefined ? { body: AI_REDACTED_BODY } : {}),
  };
}

/** What an AI may see of a history entry: the entry itself, or a redacted copy when it is hidden. */
export function entryForAi(entry: HistoryEntry): HistoryEntry {
  if (!entry.aiHidden) return entry;
  return { ...entry, path: redactUrlForAi(entry.path), request: redactRequestForAi(entry.request) };
}

/** What an AI may see of a held intercept item. */
export function interceptItemForAi(item: InterceptItem): InterceptItem {
  if (!item.aiHidden) return item;
  return { ...item, path: redactUrlForAi(item.path), request: redactRequestForAi(item.request) };
}
