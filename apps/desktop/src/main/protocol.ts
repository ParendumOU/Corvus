import fs from "node:fs/promises";
import path from "node:path";
import { net, protocol, type Session } from "electron";
import { INTERNAL_PAGES, INTERNAL_SCHEME } from "../shared/internal-urls";
import { paths, rendererDevUrl } from "./paths";

/** Must run before app "ready". */
export function registerInternalScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: INTERNAL_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: false, stream: true, codeCache: true },
    },
    // Extension action icons in the toolbar. electron-chrome-extensions registers this on import,
    // but only one registerSchemesAsPrivileged call takes effect, so it has to be listed here too.
    { scheme: "crx", privileges: { standard: true, secure: true, bypassCSP: true } },
  ]);
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".map": "application/json",
};

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https: http: crx:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "object-src 'none'",
  "base-uri 'none'",
].join("; ");

async function handle(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const page = url.hostname;
  if (!(INTERNAL_PAGES as readonly string[]).includes(page)) {
    return new Response("Not found", { status: 404 });
  }
  let pathname = decodeURIComponent(url.pathname);
  const isDocument = pathname === "/" || pathname === "";
  if (isDocument) pathname = `/${page}.html`;

  if (rendererDevUrl) {
    const upstream = await net.fetch(`${rendererDevUrl.replace(/\/$/, "")}${pathname}${isDocument ? "" : url.search}`);
    const headers = new Headers(upstream.headers);
    headers.set("X-Frame-Options", "DENY");
    return new Response(upstream.body, { status: upstream.status, headers });
  }

  const root = paths.rendererDir;
  const filePath = path.normalize(path.join(root, pathname));
  if (!filePath.startsWith(root + path.sep)) return new Response("Forbidden", { status: 403 });
  try {
    const body = await fs.readFile(filePath);
    const headers: Record<string, string> = {
      "Content-Type": MIME[path.extname(filePath)] ?? "application/octet-stream",
      "X-Content-Type-Options": "nosniff",
    };
    if (isDocument) {
      headers["Content-Security-Policy"] = CSP;
      headers["X-Frame-Options"] = "DENY";
      headers["Cache-Control"] = "no-store";
    }
    return new Response(body, { status: 200, headers });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}

export function handleInternalProtocol(session: Session): void {
  if (session.protocol.isProtocolHandled(INTERNAL_SCHEME)) return;
  session.protocol.handle(INTERNAL_SCHEME, handle);
}
