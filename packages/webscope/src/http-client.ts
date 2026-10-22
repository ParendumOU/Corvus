import http from "node:http";
import https from "node:https";
import { parseTarget } from "./scope.js";
import type { CapturedResponse, HostOverride, HttpHeader, OutboundRequest } from "./types.js";

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_BODY_BYTES = 5 * 1024 * 1024;
const MAX_REDIRECTS = 5;

export interface SendOptions {
  override?: HostOverride | undefined;
  /** Cookie header value to attach (the engine supplies this only for in-scope hosts). */
  cookieHeader?: string | undefined;
  timeoutMs?: number;
  maxBodyBytes?: number;
}

export interface SendResult {
  response: CapturedResponse;
  durationMs: number;
}

function headerList(raw: http.IncomingHttpHeaders): HttpHeader[] {
  const out: HttpHeader[] = [];
  for (const [name, value] of Object.entries(raw)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) for (const v of value) out.push({ name, value: v });
    else out.push({ name, value: String(value) });
  }
  return out;
}

function hasHeader(headers: HttpHeader[], name: string): boolean {
  const lower = name.toLowerCase();
  return headers.some((h) => h.name.toLowerCase() === lower);
}

function requestBody(req: OutboundRequest): Buffer | undefined {
  if (req.body === undefined) return undefined;
  return req.bodyBase64 ? Buffer.from(req.body, "base64") : Buffer.from(req.body, "utf8");
}

/**
 * Issue a single HTTP request from Node. Honors a DNS-style host override (connects to the override
 * address while keeping the original Host and SNI) and an injected Cookie header. Does not follow
 * redirects unless asked, so security testers see the raw response.
 */
export function sendRequest(req: OutboundRequest, opts: SendOptions = {}, redirectsLeft = MAX_REDIRECTS): Promise<SendResult> {
  const target = parseTarget(req.url);
  if (!target) return Promise.reject(new Error("Not a valid http(s) URL"));
  const parsed = new URL(req.url);
  const secure = parsed.protocol === "https:";
  const transport = secure ? https : http;
  const port = parsed.port ? Number(parsed.port) : secure ? 443 : 80;
  const connectHost = opts.override?.address || parsed.hostname;
  const maxBodyBytes = opts.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;

  const headers: Record<string, string> = {};
  for (const h of req.headers) headers[h.name] = h.value;
  if (!hasHeader(req.headers, "host")) headers["Host"] = parsed.host;
  if (opts.cookieHeader && !hasHeader(req.headers, "cookie")) headers["Cookie"] = opts.cookieHeader;

  const payload = requestBody(req);
  if (payload && !hasHeader(req.headers, "content-length")) headers["Content-Length"] = String(payload.length);

  const options: https.RequestOptions = {
    host: connectHost,
    port,
    method: req.method || "GET",
    path: parsed.pathname + parsed.search,
    headers,
    ...(secure ? { servername: parsed.hostname, rejectUnauthorized: false } : {}),
  };

  const start = Date.now();
  return new Promise<SendResult>((resolve, reject) => {
    const request = transport.request(options, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      let truncated = false;
      res.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (!truncated) {
          if (size > maxBodyBytes) {
            truncated = true;
            const room = maxBodyBytes - (size - chunk.length);
            if (room > 0) chunks.push(chunk.subarray(0, room));
          } else {
            chunks.push(chunk);
          }
        }
      });
      res.on("end", () => {
        const status = res.statusCode ?? 0;
        const location = res.headers.location;
        if (req.followRedirects && status >= 300 && status < 400 && location && redirectsLeft > 0) {
          res.resume();
          const nextUrl = new URL(location, req.url).href;
          void sendRequest({ ...req, url: nextUrl, method: status === 303 ? "GET" : req.method }, opts, redirectsLeft - 1).then(resolve, reject);
          return;
        }
        const buffer = Buffer.concat(chunks);
        const textual = isTextual(res.headers["content-type"]);
        const response: CapturedResponse = {
          status,
          ...(res.statusMessage ? { statusText: res.statusMessage } : {}),
          headers: headerList(res.headers),
          size,
          body: textual ? buffer.toString("utf8") : buffer.toString("base64"),
          ...(textual ? {} : { bodyBase64: true }),
          ...(typeof res.headers["content-type"] === "string" ? { mimeType: res.headers["content-type"].split(";")[0] } : {}),
        };
        resolve({ response, durationMs: Date.now() - start });
      });
    });
    request.setTimeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, () => request.destroy(new Error("Request timed out")));
    request.on("error", reject);
    if (payload) request.write(payload);
    request.end();
  });
}

function isTextual(contentType: string | undefined): boolean {
  if (!contentType) return true;
  const ct = contentType.toLowerCase();
  return /^text\/|application\/(json|javascript|xml|xhtml|x-www-form-urlencoded)|\+json|\+xml|utf-8/.test(ct);
}
