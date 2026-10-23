import type http from "node:http";
import type { WebContents } from "electron";
import type { AppContext } from "./context";
import type { BrowserWindowCtl } from "./window";
import { SIGN_IN_HOSTS } from "./user-agent";

/** User agents the smoke server saw, by request ("start", "doc:typed", "xhr:link", ...). */
const seen = new Map<string, string>();

export function serveSignInSmokeRoute(req: http.IncomingMessage, res: http.ServerResponse): boolean {
  const url = new URL(req.url ?? "/", "http://smoke");
  if (!url.pathname.startsWith("/signin-ua/")) return false;
  const ua = String(req.headers["user-agent"] ?? "");
  const via = url.searchParams.get("via") ?? "";
  const port = String(req.headers.host ?? "").split(":")[1] ?? "";
  const html = (body: string) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(`<!doctype html><html><head><title>Sign-in UA</title></head><body>${body}</body></html>`);
  };
  switch (url.pathname) {
    case "/signin-ua/start":
      seen.set(`doc:start${via}`, ua);
      html(`<a id="go" href="http://localhost:${port}/signin-ua/login?via=link">Sign in</a><script>fetch("/signin-ua/xhr?via=start${encodeURIComponent(via)}")</script>`);
      return true;
    case "/signin-ua/redirect":
      res.writeHead(302, { Location: `http://localhost:${port}/signin-ua/login?via=redirect` });
      res.end();
      return true;
    case "/signin-ua/login":
      seen.set(`doc:${via}`, ua);
      html(
        `<h1>Sign in</h1><a id="leave" href="http://127.0.0.1:${port}/signin-ua/start?via=leave">Back to the site</a>` +
          `<script>fetch("/signin-ua/xhr?via=${encodeURIComponent(via)}")</script>`,
      );
      return true;
    case "/signin-ua/xhr":
      seen.set(`xhr:${via}`, ua);
      res.writeHead(204);
      res.end();
      return true;
  }
  return false;
}

interface SignInSmokeHelpers {
  url: string;
  win: BrowserWindowCtl;
  check: (name: string, ok: boolean, detail?: unknown) => void;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function seenAs(key: string, timeoutMs = 8000): Promise<string | null> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const ua = seen.get(key);
    if (ua !== undefined) return ua;
    await sleep(100);
  }
  return null;
}

/** Electron's UA without the Corvus token: what Google's sign-in accepts. */
const isElectron = (ua: string | null | undefined): boolean => !!ua && ua.includes(" Electron/") && !/\b[Cc]orvus\//.test(ua);
/** The regular Chrome UA every other site gets. */
const isChrome = (ua: string | null | undefined): boolean => !!ua && ua.includes(" Chrome/") && !ua.includes("Electron/") && !/\b[Cc]orvus\//.test(ua);

/**
 * Google's sign-in host gets Electron's own UA, everything else the Chrome one, whichever way the tab
 * gets there (typed, link, server redirect), for the document, its requests and navigator.userAgent.
 * "localhost" stands in for accounts.google.com. Passkeys stay hidden from sites unless turned on.
 */
export async function runSignInSmoke(ctx: AppContext, h: SignInSmokeHelpers): Promise<void> {
  const { win, check } = h;
  const base = new URL(h.url);
  const port = base.port;
  SIGN_IN_HOSTS.add("localhost");
  const tab = win.createTab(`${base.origin}/signin-ua/start?via=first`);
  const wc: WebContents = tab.view.webContents;
  /** Runs a navigation and reports the UA of the page it landed on (after any restart). */
  const visit = async (via: string, go: () => unknown): Promise<{ doc?: string; xhr?: string; navigator?: string }> => {
    seen.delete(`doc:${via}`);
    seen.delete(`xhr:${via}`);
    go();
    await seenAs(`xhr:${via}`);
    await sleep(300);
    const navigator = (await wc.executeJavaScript("navigator.userAgent").catch(() => undefined)) as string | undefined;
    return { doc: seen.get(`doc:${via}`), xhr: seen.get(`xhr:${via}`), navigator };
  };
  const all = (v: { doc?: string; xhr?: string; navigator?: string }, ok: (ua: string | undefined) => boolean) => ok(v.doc) && ok(v.xhr) && ok(v.navigator);
  try {
    const first = await visit("startfirst", () => undefined);
    check("sign-in UA: other sites get the Chrome UA", all(first, isChrome), first);

    const typed = await visit("typed", () => void wc.loadURL(`http://localhost:${port}/signin-ua/login?via=typed`).catch(() => undefined));
    check("sign-in UA: typed sign-in URL sends Electron's UA (document, requests, navigator)", all(typed, isElectron), typed);

    const back = await visit("startback", () => void wc.loadURL(`${base.origin}/signin-ua/start?via=back`).catch(() => undefined));
    check("sign-in UA: going elsewhere goes back to the Chrome UA", all(back, isChrome), back);

    const link = await visit("link", () => void wc.executeJavaScript(`document.getElementById("go").click()`).catch(() => undefined));
    check("sign-in UA: a link to the sign-in host sends Electron's UA", all(link, isElectron), link);

    // The page leaving by itself is not restarted (it could be a form POST); what follows is Chrome.
    const leave = await visit("startleave", () => void wc.executeJavaScript(`document.getElementById("leave").click()`).catch(() => undefined));
    check("sign-in UA: a page leaving the sign-in host gets the Chrome UA for what follows", isChrome(leave.xhr) && isChrome(leave.navigator), leave);

    void wc.loadURL(`${base.origin}/signin-ua/start?via=again`).catch(() => undefined);
    await seenAs("xhr:startagain");
    const redirected = await visit("redirect", () => void wc.loadURL(`${base.origin}/signin-ua/redirect`).catch(() => undefined));
    check("sign-in UA: a redirect to the sign-in host sends Electron's UA", all(redirected, isElectron), redirected);
  } finally {
    SIGN_IN_HOSTS.delete("localhost");
    win.closeTab(tab.id);
  }
  const passkeyApi = async (): Promise<string> => {
    const probe = win.createTab(`${base.origin}/signin-ua/start`);
    try {
      await sleep(800);
      return (await probe.view.webContents.executeJavaScript("typeof PublicKeyCredential").catch(() => "error")) as string;
    } finally {
      win.closeTab(probe.id);
    }
  };
  const before = ctx.settings.get().passwords.passkeys;
  try {
    ctx.settings.update({ passwords: { passkeys: false } });
    const off = await passkeyApi();
    ctx.settings.update({ passwords: { passkeys: true } });
    const on = await passkeyApi();
    check("passkeys: hidden from sites by default, offered when turned on", off === "undefined" && on === "function", { off, on });
  } finally {
    ctx.settings.update({ passwords: { passkeys: before } });
  }
}
