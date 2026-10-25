import { net, type IncomingMessage, type Session } from "electron";
import type { FetchInit, HostResponse, HosterNet } from "./types";

/** Pages are read up to this size; hoster pages are far smaller. */
const MAX_TEXT_BYTES = 4 * 1024 * 1024;
const MAX_REDIRECTS = 10;
const PAGE_TYPES = /text\/html|application\/(?:json|xhtml\+xml|xml|javascript)|text\/(?:xml|javascript|css)/i;

const first = (value: string | string[] | undefined): string | null => (Array.isArray(value) ? (value[0] ?? null) : (value ?? null));

/**
 * One request through the session (its cookies, proxy and user agent), following redirects itself:
 * session.fetch never tells the final address, which a hoster page's relative links and short
 * links need.
 */
function request(session: Session, url: string, init: FetchInit, signal: AbortSignal): Promise<HostResponse> {
  return new Promise<HostResponse>((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("Stopped"));
      return;
    }
    const headers: Record<string, string> = { ...(init.headers ?? {}) };
    let body: string | undefined;
    if (init.form) {
      body = new URLSearchParams(init.form).toString();
      headers["content-type"] = "application/x-www-form-urlencoded";
    } else if (init.json !== undefined) {
      body = JSON.stringify(init.json);
      headers["content-type"] = "application/json";
    }
    const req = net.request({ method: init.method ?? (body !== undefined ? "POST" : "GET"), url, session, useSessionCookies: true, redirect: "manual" });
    for (const [name, value] of Object.entries(headers)) {
      try {
        req.setHeader(name, value);
      } catch {
        // a header Chromium keeps for itself
      }
    }
    let finalUrl = url;
    let redirects = 0;
    const abort = (): void => req.abort();
    signal.addEventListener("abort", abort, { once: true });
    req.on("redirect", (_status, _method, redirectUrl) => {
      if (++redirects > MAX_REDIRECTS || !/^https?:\/\//i.test(redirectUrl)) {
        req.abort();
        reject(new Error("Too many redirects"));
        return;
      }
      finalUrl = redirectUrl;
      req.followRedirect();
    });
    req.on("error", (err) => {
      signal.removeEventListener("abort", abort);
      reject(signal.aborted ? new Error("Stopped") : err);
    });
    req.on("abort", () => reject(new Error("Stopped")));
    req.on("response", (res: IncomingMessage) => {
      const status = res.statusCode;
      const header = (name: string): string | null => first(res.headers[name.toLowerCase()]);
      const type = header("content-type") ?? "";
      const disposition = header("content-disposition") ?? "";
      let text: Promise<string> | null = null;
      const read = (): Promise<string> =>
        (text ??= new Promise<string>((done, fail) => {
          const chunks: Buffer[] = [];
          let size = 0;
          let ended = false;
          const finish = (): void => {
            if (ended) return;
            ended = true;
            signal.removeEventListener("abort", abort);
            done(Buffer.concat(chunks).toString("utf8"));
          };
          res.on("data", (chunk: Buffer) => {
            if (ended) return;
            chunks.push(chunk);
            size += chunk.length;
            if (size >= MAX_TEXT_BYTES) {
              finish();
              req.abort();
            }
          });
          res.on("end", finish);
          res.on("aborted", () => (ended ? undefined : fail(new Error("Stopped"))));
          res.on("error", (err: Error) => (ended ? undefined : fail(err)));
        }));
      resolve({
        status,
        url: finalUrl,
        header,
        isFile: status >= 200 && status < 300 && (/attachment|filename=/i.test(disposition) || (type !== "" && !PAGE_TYPES.test(type))),
        text: read,
        json: async () => JSON.parse(await read()) as unknown,
        cancel: async () => {
          signal.removeEventListener("abort", abort);
          req.abort();
        },
      });
    });
    if (body !== undefined) req.write(body);
    req.end();
  });
}

/** Hoster requests through a profile's session: its cookies, its proxy, its user agent. */
export function sessionNet(session: Session, signal: AbortSignal): HosterNet {
  return {
    fetch(url: string, init: FetchInit = {}) {
      if (!/^https?:\/\//i.test(url)) return Promise.reject(new Error("Only web addresses can be fetched"));
      return request(session, url, init, signal);
    },
    cookie: async (url, name) => (await session.cookies.get({ url, name }))[0]?.value ?? null,
    setCookie: (url, name, value) => session.cookies.set({ url, name, value, secure: true, expirationDate: Math.floor(Date.now() / 1000) + 30 * 86400 }),
    sleep: (ms) =>
      new Promise<void>((resolve, reject) => {
        if (signal.aborted) {
          reject(new Error("Stopped"));
          return;
        }
        const timer = setTimeout(resolve, ms);
        signal.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            reject(new Error("Stopped"));
          },
          { once: true },
        );
      }),
  };
}
