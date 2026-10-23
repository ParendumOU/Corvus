import fs from "node:fs/promises";
import path from "node:path";
import { net, protocol, type Session } from "electron";
import { ADBLOCK_RESOURCE_SCHEME } from "../shared/adblock";
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
    // The ad blocker's stand-ins for blocked scripts (see AdblockService): a page loads them in place
    // of the original, under that page's CSP, so they bypass it like the original was allowed.
    { scheme: ADBLOCK_RESOURCE_SCHEME, privileges: { standard: true, secure: true, bypassCSP: true, supportFetchAPI: true, corsEnabled: true } },
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

let pageLanguage = (): string => "en";

/** Where internal pages get their language from; it is written into each page's <html lang>. */
export function setInternalPageLanguage(language: () => string): void {
  pageLanguage = language;
}

/** Pages read their language synchronously from <html lang>, so they render translated at once. */
function withLanguage(html: string): string {
  return html.replace(/<html lang="[^"]*">/, `<html lang="${pageLanguage()}">`);
}

interface NewTabRoutes {
  /** A custom widget's document and its CSP, for corvus://newtab/widget/<id>. */
  widget(session: Session, id: string, tone: "light" | "dark" | null): { html: string; csp: string } | null;
  /** An uploaded background picture, for corvus://newtab/media/<file>. */
  media(session: Session, file: string): { body: Buffer; type: string } | null;
}

let newTabRoutes: NewTabRoutes | null = null;

export function setNewTabRoutes(routes: NewTabRoutes): void {
  newTabRoutes = routes;
}

/** Widget documents and pictures of the New Tab page, which come from the profile, not the app files. */
function newTabRoute(session: Session, pathname: string, search: URLSearchParams): Response | null {
  const widget = /^\/widget\/([A-Za-z0-9_-]{1,40})$/.exec(pathname);
  if (widget) {
    const tone = search.get("tone");
    const doc = newTabRoutes?.widget(session, widget[1]!, tone === "dark" || tone === "light" ? tone : null);
    if (!doc) return new Response("Not found", { status: 404 });
    return new Response(doc.html, {
      status: 200,
      headers: { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": doc.csp, "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store" },
    });
  }
  const media = /^\/media\/([A-Za-z0-9.-]{1,80})$/.exec(pathname);
  if (media) {
    const file = newTabRoutes?.media(session, media[1]!);
    if (!file) return new Response("Not found", { status: 404 });
    return new Response(new Uint8Array(file.body), { status: 200, headers: { "Content-Type": file.type, "X-Content-Type-Options": "nosniff" } });
  }
  return null;
}

async function handle(request: Request, session: Session): Promise<Response> {
  const url = new URL(request.url);
  const page = url.hostname;
  if (!(INTERNAL_PAGES as readonly string[]).includes(page)) {
    return new Response("Not found", { status: 404 });
  }
  let pathname = decodeURIComponent(url.pathname);
  if (page === "newtab") {
    const routed = newTabRoute(session, pathname, url.searchParams);
    if (routed) return routed;
  }
  const isDocument = pathname === "/" || pathname === "";
  if (isDocument) pathname = `/${page}.html`;

  if (rendererDevUrl) {
    const upstream = await net.fetch(`${rendererDevUrl.replace(/\/$/, "")}${pathname}${isDocument ? "" : url.search}`);
    const headers = new Headers(upstream.headers);
    headers.set("X-Frame-Options", "DENY");
    if (isDocument) {
      headers.delete("content-length");
      return new Response(withLanguage(await upstream.text()), { status: upstream.status, headers });
    }
    return new Response(upstream.body, { status: upstream.status, headers });
  }

  const root = paths.rendererDir;
  const filePath = path.normalize(path.join(root, pathname));
  if (!filePath.startsWith(root + path.sep)) return new Response("Forbidden", { status: 403 });
  try {
    const raw = await fs.readFile(filePath);
    const body = isDocument ? withLanguage(raw.toString("utf8")) : raw;
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
  session.protocol.handle(INTERNAL_SCHEME, (request) => handle(request, session));
}
