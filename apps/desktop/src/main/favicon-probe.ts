import { net, type Session } from "electron";
import type { ProbedPage } from "./favicon-cache";

/** Redirects followed before giving up (Chromium's own limit is 20). */
const MAX_REDIRECTS = 10;
/** The start of the page kept: its <head>, where it names its icon. */
const MAX_HTML_BYTES = 256 * 1024;
const TIMEOUT_MS = 8000;

/**
 * Fetches a bookmark's page to see where it leads and which icon it names: one redirect at a time,
 * so the final address is known, through `session` (the profile's proxy and user agent) and without
 * cookies, a referrer or a login prompt. Only the start of an HTML page is read. Null when it cannot
 * be reached or sends the tab somewhere other than a web page.
 */
export function probePage(session: Session, url: string): Promise<ProbedPage | null> {
  return new Promise((resolve) => {
    let current = url;
    let redirects = 0;
    let settled = false;
    const request = net.request({ url, session, method: "GET", redirect: "manual", credentials: "omit", referrerPolicy: "no-referrer" });
    const finish = (page: ProbedPage | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(page);
      request.abort();
    };
    const timer = setTimeout(() => finish(null), TIMEOUT_MS);
    request.setHeader("Accept", "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5");
    request.on("redirect", (_status, _method, redirectUrl) => {
      if (settled) return;
      if (++redirects > MAX_REDIRECTS || !/^https?:\/\//i.test(redirectUrl)) {
        finish(null);
        return;
      }
      current = redirectUrl;
      request.followRedirect();
    });
    request.on("response", (response) => {
      const header = response.headers["content-type"];
      const type = (Array.isArray(header) ? header[0] : header) ?? "";
      // An error page still tells where the bookmark leads; its HTML is not the site's.
      if (response.statusCode >= 400 || !/html/i.test(type)) {
        finish({ url: current, html: null });
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      const page = (): ProbedPage => ({ url: current, html: Buffer.concat(chunks).toString("utf8") });
      response.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
        size += chunk.length;
        if (size >= MAX_HTML_BYTES || /<\/head\s*>|<body[\s>]/i.test(chunk.toString("latin1"))) finish(page());
      });
      response.on("end", () => finish(page()));
      response.on("aborted", () => finish(chunks.length > 0 ? page() : null));
      response.on("error", () => finish(chunks.length > 0 ? page() : null));
    });
    request.on("error", () => finish(null));
    request.end();
  });
}
