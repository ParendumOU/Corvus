import type http from "node:http";
import type { WebContents, WebFrameMain } from "electron";
import { dropdownEntries } from "../shared/field-dropdown";
import { base32Encode, totpCode, type TotpConfig } from "../shared/totp";
import type { AppContext } from "./context";
import { windowShot } from "./smoke-cert-errors";
import { dropdownDriver } from "./smoke-otp-fill";
import type { BrowserWindowCtl, TabRuntime } from "./window";

interface Helpers {
  /** The smoke server; its pages are also served for every host under corvus-smoke.test, for corvus-smoke.example, corvus-smoke.org and localhost. */
  url: string;
  win: BrowserWindowCtl;
  check: (name: string, ok: boolean, detail?: unknown) => void;
}

/** Every value set in a field, as the page itself hears it (input and change events, in shadow roots too): a fill Corvus refused must leave nothing here. Also counts the events a script made (isTrusted false), which bot checks reject. */
const RECORD = `const record = (root) => { for (const type of ["input", "change"]) root.addEventListener(type, (e) => { const el = e.composedPath()[0]; (window.__seen = window.__seen || []).push(String((el && el.value) || "")); if (!e.isTrusted) window.__untrusted = (window.__untrusted || 0) + 1; }, true); };`;
const LOGIN_FORM = `<form onsubmit="return false"><label>Username <input id="u" name="username" autocomplete="username"></label> <label>Password <input id="p" name="password" type="password" autocomplete="current-password"></label> <button>Sign in</button></form>`;
const STYLE = "<style>body{font:14px sans-serif;margin:12px} label{display:block;margin:6px 0} iframe{width:460px;height:200px;border:1px solid #bbb}</style>";
const page = (title: string, body: string): string => `<!doctype html><html><head><title>${title}</title>${STYLE}</head><body>${body}<script>${RECORD} record(document);</script></body></html>`;

/** A sign-in form embedded in other sites' pages. */
const LOGIN_PAGE = page("Embedded sign-in", `<h3>Sign in</h3>${LOGIN_FORM}`);
/** A 2FA step embedded likewise. */
const OTP_PAGE = page("Embedded 2FA", `<h3>Two-step verification</h3><form onsubmit="return false"><label>Verification code <input id="code" name="code" autocomplete="one-time-code" inputmode="numeric" maxlength="6"></label></form>`);
/** The sign-in form inside a web component's open shadow root. */
const COMPONENT_PAGE = page(
  "Embedded component sign-in",
  `<h3>Sign in</h3><corvus-frame-login></corvus-frame-login><script>customElements.define("corvus-frame-login", class extends HTMLElement { constructor() { super(); const root = this.attachShadow({ mode: "open" }); root.innerHTML = ${JSON.stringify(LOGIN_FORM)}; ${RECORD} record(root); } });</script>`,
);

const attr = (s: string): string => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

/**
 * A page of one site that embeds `src` (style and sandbox as the query says), with a login form of its
 * own when `top=1` and a second frame of the same page when `twin=1`.
 */
function hostPage(q: URLSearchParams): string {
  const frame = (id: string): string => `<iframe id="${id}" src="${attr(q.get("src") ?? "")}"${q.get("style") ? ` style="${attr(q.get("style")!)}"` : ""}${q.has("sandbox") ? ` sandbox="${attr(q.get("sandbox")!)}"` : ""}></iframe>`;
  const own = q.get("top") === "1" ? `<h3>The shop's own sign-in</h3>${LOGIN_FORM.replace('id="u"', 'id="tu"').replace('id="p"', 'id="tp"')}` : "";
  return page("Shop", `<h1>Shop</h1><p>A page that embeds a sign-in form.</p>${own}${frame("f")}${q.get("twin") === "1" ? frame("g") : ""}`);
}

/** A page between the shop and the sign-in frame: of another site, with a login form of its own. */
const midPage = (q: URLSearchParams): string => page("Widget", `<h3>Widget</h3>${LOGIN_FORM}<iframe id="inner" src="${attr(q.get("src") ?? "")}" style="width:440px;height:160px"></iframe>`);


/** The pages of the frame autofill smoke, served by the shared smoke server. */
export function serveFrameFillSmokeRoute(req: http.IncomingMessage, res: http.ServerResponse): boolean {
  const u = new URL(req.url ?? "/", "http://x");
  const routes: Record<string, () => string> = {
    "/ff-login": () => LOGIN_PAGE,
    "/ff-otp": () => OTP_PAGE,
    "/ff-component": () => COMPONENT_PAGE,
    "/ff-host": () => hostPage(u.searchParams),
    "/ff-mid": () => midPage(u.searchParams),
  };
  const route = routes[u.pathname];
  if (!route) return false;
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(route());
  return true;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function until(cond: () => boolean | Promise<boolean>, timeoutMs = 10_000): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await cond()) return true;
    await sleep(120);
  }
  return false;
}

const frameJs = <T>(frame: WebFrameMain | undefined | null, expr: string): Promise<T | null> => (frame && !frame.detached ? (frame.executeJavaScript(expr, true) as Promise<T>).catch(() => null) : Promise.resolve(null));

/** A made-up 2FA secret: no real account's. */
const fakeConfig = (seed: number): TotpConfig => ({ secret: base32Encode(Uint8Array.from({ length: 20 }, (_, i) => (seed * 53 + i * 29 + 7) & 0xff)), algorithm: "SHA1", digits: 6, period: 30 });
const nearbyCodes = async (config: TotpConfig): Promise<string[]> => Promise.all([-30_000, 0, 30_000].map(async (offset) => (await totpCode(config, Date.now() + offset)).code));

/** Every field value of a frame (in its web components too) and every value its page heard set. */
interface FrameHeld {
  values: string[];
  seen: string[];
  untrusted: number;
}
const HELD = `(() => { const values = []; const walk = (root) => { for (const el of root.querySelectorAll("input")) values.push(el.value); for (const el of root.querySelectorAll("*")) if (el.shadowRoot) walk(el.shadowRoot); }; walk(document); return { values, seen: window.__seen || [], untrusted: window.__untrusted || 0 }; })()`;

/**
 * Logins and 2FA codes in iframes. A click in a login field of a frame offers the logins saved for the
 * frame's own origin, never the page's: in a frame of the page's origin the page's login, in a frame
 * of another site that site's login with "This form is on <host>", and nothing in a frame of a site
 * without saved logins. A pick fills that frame alone (nested frames too, web components in frames
 * too, a 2FA code too). Nothing reaches a frame that is hidden, transparent, zero-size, off screen or
 * sandboxed, one that went to another page, became hidden or lost the keyboard before the pick.
 */
export async function runFrameFillSmoke(ctx: AppContext, { url, win, check }: Helpers): Promise<void> {
  const port = new URL(url).port;
  const A = `http://shop.corvus-smoke.test:${port}`;
  const B = `http://corvus-smoke.example:${port}`;
  const C = `http://localhost:${port}`;
  /** A site no check saves a login for. */
  const D = `http://corvus-smoke.org:${port}`;
  const vault = win.profile.credentials;
  const embedTotp = fakeConfig(41);
  const shop = vault.add({ origin: A, username: "shop-smoke", password: "pw-shop-frame-smoke" });
  const embed = vault.add({ origin: B, username: "embed-smoke", password: "pw-embed-frame-smoke", totp: embedTotp });
  const deep = vault.add({ origin: C, username: "deep-smoke", password: "pw-deep-frame-smoke" });
  const PASSWORDS = ["pw-shop-frame-smoke", "pw-embed-frame-smoke", "pw-deep-frame-smoke"];
  const dropdown = dropdownDriver(ctx, win);
  const tabs: TabRuntime[] = [];

  const host = (q: Record<string, string>): string => `${A}/ff-host?${new URLSearchParams(q).toString()}`;
  const open = async (target: string): Promise<{ tab: TabRuntime; wc: WebContents }> => {
    const tab = win.createTab(target);
    tabs.push(tab);
    const wc = tab.view.webContents;
    await until(() => !wc.isDestroyed() && wc.getURL() === target && !tab.loading);
    return { tab, wc };
  };
  /** The frame of the tab with that origin whose page has `ready` true, once it has loaded. */
  const frameOf = async (wc: WebContents, origin: string, ready = `Boolean(document.getElementById("p"))`, skip?: WebFrameMain): Promise<WebFrameMain | undefined> => {
    let found: WebFrameMain | undefined;
    await until(async () => {
      for (const f of wc.mainFrame.framesInSubtree) {
        if (f === wc.mainFrame || f === skip || f.origin !== origin) continue;
        if (await frameJs<boolean>(f, `document.readyState === "complete" && ${ready}`)) {
          found = f;
          return true;
        }
      }
      return false;
    }, 10_000);
    return found;
  };
  /** The middle of the last element, in the tab's page: each frame element's place up the chain plus the element's box in its frame. */
  const pointOf = async (steps: [WebFrameMain, string][]): Promise<{ x: number; y: number } | null> => {
    let x = 0;
    let y = 0;
    for (const [i, [frame, expr]] of steps.entries()) {
      const r = await frameJs<{ x: number; y: number; w: number; h: number; cl: number; ct: number }>(frame, `(() => { const el = ${expr}; if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height, cl: el.clientLeft, ct: el.clientTop }; })()`);
      if (!r) return null;
      if (i < steps.length - 1) {
        x += r.x + r.cl;
        y += r.y + r.ct;
      } else {
        x += r.x + r.w / 2;
        y += r.y + r.h / 2;
      }
    }
    return { x: Math.round(x), y: Math.round(y) };
  };
  /** Real input through the DevTools input domain, which routes it to the frame under it (or with the keyboard), whatever its process. */
  const cdp = async (wc: WebContents, commands: [string, Record<string, unknown>][]): Promise<void> => {
    wc.focus();
    const attach = !wc.debugger.isAttached();
    if (attach) wc.debugger.attach("1.3");
    try {
      for (const [method, params] of commands) await wc.debugger.sendCommand(method, params);
    } finally {
      if (attach) wc.debugger.detach();
    }
  };
  const click = (wc: WebContents, at: { x: number; y: number }): Promise<void> => cdp(wc, ["mousePressed", "mouseReleased"].map((type) => ["Input.dispatchMouseEvent", { type, ...at, button: "left", clickCount: 1 }]));
  const arrowDown = (wc: WebContents): Promise<void> => cdp(wc, ["rawKeyDown", "keyUp"].map((type) => ["Input.dispatchKeyEvent", { type, key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 }]));
  /** A real click at a point; true when the dropdown opened for it. */
  const clickOpens = async (wc: WebContents, at: { x: number; y: number } | null, timeoutMs = 5000): Promise<boolean> => {
    const before = dropdown.token();
    if (!at) return false;
    await click(wc, at);
    return dropdown.opened(before, timeoutMs);
  };
  const usernames = (): string[] => {
    const s = dropdown.state();
    return s ? dropdownEntries(s).flatMap((e) => (e.type === "account" ? [e.account.username] : [])) : [];
  };
  const pickUser = (username: string): boolean => {
    const s = dropdown.state();
    const index = s ? dropdownEntries(s).findIndex((e) => e.type === "account" && e.account.username === username) : -1;
    if (!s || index < 0) return false;
    ctx.autofill.fieldDropdown(win)?.onAction({ type: "activate", token: s.token, index });
    return true;
  };
  const held = async (frame: WebFrameMain | undefined): Promise<FrameHeld | null> => frameJs<FrameHeld>(frame, HELD);
  /** No saved password and no 2FA code (current, previous or next) reached the frame: none in its fields, none heard by its page. */
  const clean = async (frame: WebFrameMain | undefined): Promise<{ ok: boolean; held: FrameHeld | null }> => {
    const h = await held(frame);
    const text = JSON.stringify(h);
    const secrets = [...PASSWORDS, ...(await nearbyCodes(embedTotp))];
    return { ok: Boolean(h) && !secrets.some((s) => text.includes(s)), held: h };
  };
  const filledWith = async (frame: WebFrameMain | undefined, username: string, password: string, root = "document"): Promise<boolean> =>
    until(async () => Boolean(await frameJs<boolean>(frame, `(() => { const r = ${root}; return r.querySelector("#u").value === ${JSON.stringify(username)} && r.querySelector("#p").value === ${JSON.stringify(password)}; })()`)), 6000);

  try {
    // 1: same origin. The page's own login, filled into the frame alone; the page's own form stays empty.
    {
      const { wc } = await open(host({ src: `${A}/ff-login`, top: "1" }));
      const frame = await frameOf(wc, A);
      const opened = await clickOpens(wc, frame ? await pointOf([[wc.mainFrame, `document.getElementById("f")`], [frame, `document.getElementById("p")`]]) : null);
      check("frames: a click in a login field of a same-origin frame offers the page's login", opened && usernames().join() === "shop-smoke" && dropdown.state()?.formHost === "", { opened, users: usernames(), formHost: dropdown.state()?.formHost });
      pickUser("shop-smoke");
      check("frames: picking it fills username and password into that frame", await filledWith(frame, "shop-smoke", "pw-shop-frame-smoke"), await held(frame));
      const typed = await held(frame);
      check("frames: the frame hears the fill as typing (trusted input and change events only, as with Chrome autofill)", Boolean(typed && typed.seen.length >= 4 && typed.untrusted === 0), typed && { events: typed.seen.length, untrusted: typed.untrusted });
      const top = await frameJs<{ u: string; p: string }>(wc.mainFrame, `({ u: document.getElementById("tu").value, p: document.getElementById("tp").value })`);
      check("frames: the page's own login form stays empty", top?.u === "" && top?.p === "", top);
    }

    // 2: another site's frame on a page with its own saved login: only the frame site's login, named as such; the page's never reaches it.
    {
      const { wc } = await open(host({ src: `${B}/ff-login`, top: "1" }));
      const frame = await frameOf(wc, B);
      const field = frame ? await pointOf([[wc.mainFrame, `document.getElementById("f")`], [frame, `document.getElementById("u")`]]) : null;
      const opened = await clickOpens(wc, field);
      const s = dropdown.state();
      check(
        "frames: a click in a login field of another site's frame offers that site's login only, never the page's, and says \"This form is on\" that host",
        opened && usernames().join() === "embed-smoke" && s?.formHost === `corvus-smoke.example:${port}`,
        { opened, users: usernames(), formHost: s?.formHost },
      );
      // What the person sees: the dropdown naming the frame's site, over the page that embeds it.
      await windowShot(win, "frame-login-other-site", "framefill");
      pickUser("embed-smoke");
      check("frames: picking it fills that site's login into its frame", await filledWith(frame, "embed-smoke", "pw-embed-frame-smoke"), await held(frame));
      const after = await held(frame);
      check("frames: the page's password never reaches the other site's frame", Boolean(after) && !JSON.stringify(after).includes("pw-shop-frame-smoke"), after);
      // The down arrow in the field opens it too (the frame still has the keyboard).
      await frameJs(frame, `document.getElementById("u").value = ""; document.getElementById("p").value = ""; document.getElementById("u").focus(); true`);
      const before = dropdown.token();
      await arrowDown(wc);
      check("frames: the down arrow in such a field opens the frame site's logins too", (await dropdown.opened(before)) && usernames().join() === "embed-smoke", usernames());
    }

    // 3: a frame of a site without saved logins: nothing offered, though the page has a login.
    {
      const { wc } = await open(host({ src: `${D}/ff-login`, top: "1" }));
      const frame = await frameOf(wc, D);
      const opened = await clickOpens(wc, frame ? await pointOf([[wc.mainFrame, `document.getElementById("f")`], [frame, `document.getElementById("p")`]]) : null, 2500);
      const c = await clean(frame);
      const saved = win.profile.logins.matchesFor(D).length;
      check("frames: a frame of a site without saved logins offers nothing, not even the page's login or a same-name site's, and gets no secret", saved === 0 && Boolean(frame) && !opened && c.ok, { saved, opened, users: usernames(), ...c });
    }

    // 4: nested frames: the inner frame's own site's login, into the inner frame only.
    {
      const { wc } = await open(host({ src: `${B}/ff-mid?src=${encodeURIComponent(`${C}/ff-login`)}`, style: "width:480px;height:380px" }));
      const mid = await frameOf(wc, B, `Boolean(document.getElementById("inner"))`);
      const inner = await frameOf(wc, C);
      const opened = await clickOpens(wc, mid && inner ? await pointOf([[wc.mainFrame, `document.getElementById("f")`], [mid, `document.getElementById("inner")`], [inner, `document.getElementById("p")`]]) : null);
      check("frames: in a frame inside a frame, the inner frame's site's login is offered", opened && usernames().join() === "deep-smoke" && dropdown.state()?.formHost === `localhost:${port}`, { opened, users: usernames() });
      pickUser("deep-smoke");
      check("frames: picking it fills the inner frame", await filledWith(inner, "deep-smoke", "pw-deep-frame-smoke"), await held(inner));
      const m = await clean(mid);
      check("frames: the frame in between gets nothing, though it has a login form of its own", m.ok && m.held?.values.every((v) => v === "") === true, m);
    }

    // 5: a 2FA code field in another site's frame: that site's code.
    {
      const { wc } = await open(host({ src: `${B}/ff-otp` }));
      const frame = await frameOf(wc, B, `Boolean(document.getElementById("code"))`);
      const opened = await clickOpens(wc, frame ? await pointOf([[wc.mainFrame, `document.getElementById("f")`], [frame, `document.getElementById("code")`]]) : null);
      check("frames: a click in a 2FA field of another site's frame offers that site's 2FA code", opened && dropdown.state()?.kind === "otp" && usernames().join() === "embed-smoke", { opened, kind: dropdown.state()?.kind, users: usernames() });
      pickUser("embed-smoke");
      let code = "";
      const filled = await until(async () => {
        code = (await frameJs<string>(frame, `document.getElementById("code").value`)) ?? "";
        return (await nearbyCodes(embedTotp)).includes(code);
      }, 6000);
      check("frames: picking it fills the current code into that frame", filled, { length: code.length });
    }

    // 6: a web component inside a frame.
    {
      const { wc } = await open(host({ src: `${B}/ff-component` }));
      const shadow = `document.querySelector("corvus-frame-login").shadowRoot`;
      const frame = await frameOf(wc, B, `Boolean(document.querySelector("corvus-frame-login") && ${shadow}.getElementById("p"))`);
      const opened = await clickOpens(wc, frame ? await pointOf([[wc.mainFrame, `document.getElementById("f")`], [frame, `${shadow}.getElementById("p")`]]) : null);
      check("frames: a click in a web component's password field inside a frame offers the frame site's login", opened && usernames().join() === "embed-smoke", { opened, users: usernames() });
      pickUser("embed-smoke");
      check("frames: picking it fills the component's fields in that frame", await filledWith(frame, "embed-smoke", "pw-embed-frame-smoke", shadow), await held(frame));
      const typed = await held(frame);
      check("frames: the component's fields hear the fill as typing too (trusted events only)", Boolean(typed && typed.seen.length >= 4 && typed.untrusted === 0), typed && { events: typed.seen.length, untrusted: typed.untrusted });
    }

    // 7: the frame goes to another page of its site, or to another site, between the click and the pick: nothing reaches it.
    for (const [label, next] of [
      ["another page of its site", `${B}/ff-login?again=1`],
      ["another site", `${C}/ff-login?again=1`],
    ] as const) {
      const { wc } = await open(host({ src: `${B}/ff-login` }));
      const frame = await frameOf(wc, B);
      const opened = await clickOpens(wc, frame ? await pointOf([[wc.mainFrame, `document.getElementById("f")`], [frame, `document.getElementById("p")`]]) : null);
      await frameJs(wc.mainFrame, `document.getElementById("f").src = ${JSON.stringify(next)}; true`);
      const moved = await frameOf(wc, new URL(next).origin, `location.search === "?again=1" && Boolean(document.getElementById("p"))`);
      await ctx.autofill.pickAccount(win, "login", embed.id);
      const c = await clean(moved);
      check(`frames: a frame that went to ${label} after the click gets no password from the pick`, opened && Boolean(moved) && c.ok && c.held?.values.every((v) => v === "") === true, { opened, moved: moved?.url, ...c });
    }

    // 8: the frame becomes transparent between the click and the pick: nothing reaches it.
    {
      const { wc } = await open(host({ src: `${B}/ff-login` }));
      const frame = await frameOf(wc, B);
      const opened = await clickOpens(wc, frame ? await pointOf([[wc.mainFrame, `document.getElementById("f")`], [frame, `document.getElementById("p")`]]) : null);
      await frameJs(wc.mainFrame, `document.getElementById("f").style.opacity = "0"; true`);
      await ctx.autofill.pickAccount(win, "login", embed.id);
      const c = await clean(frame);
      check("frames: a frame made transparent after the click gets no password from the pick", opened && c.ok, { opened, ...c });
    }

    // 9: the keyboard moved to another frame of the same site between the click and the pick: nothing reaches either.
    {
      const { wc } = await open(host({ src: `${B}/ff-login`, twin: "1" }));
      const first = await frameOf(wc, B);
      const second = await frameOf(wc, B, `Boolean(document.getElementById("p"))`, first);
      const opened = await clickOpens(wc, first ? await pointOf([[wc.mainFrame, `document.getElementById("f")`], [first, `document.getElementById("p")`]]) : null);
      // A click on the second frame's heading: the keyboard goes there, to no field.
      const heading = second ? await pointOf([[wc.mainFrame, `document.getElementById("g")`], [second, `document.querySelector("h3")`]]) : null;
      if (heading) await click(wc, heading);
      const moved = await until(() => wc.focusedFrame?.routingId === second?.routingId && wc.focusedFrame?.processId === second?.processId, 3000);
      await ctx.autofill.pickAccount(win, "login", embed.id);
      const [c1, c2] = [await clean(first), await clean(second)];
      check("frames: once the keyboard left the clicked frame for another, a pick sends the password to neither", opened && moved && c1.ok && c2.ok && [...(c1.held?.values ?? []), ...(c2.held?.values ?? [])].every((v) => v === ""), { opened, moved, c1, c2 });
    }

    // 10: hidden frames (clickjacking): transparent, zero-size, off screen. A real click goes through a
    // transparent frame; the others cannot be clicked, so their preload's report is replayed with a
    // field it claims to show: the parent's own view of the frame decides.
    for (const [label, style] of [
      ["transparent", "opacity:0;position:absolute;left:12px;top:60px"],
      ["nearly transparent", "opacity:0.2"],
      ["zero-size", "width:0;height:0;border:0"],
      ["off screen", "position:absolute;left:-3000px;top:0"],
      ["hidden by an opacity filter", "filter:opacity(0)"],
    ] as const) {
      const { tab, wc } = await open(host({ src: `${B}/ff-login`, style }));
      const frame = await frameOf(wc, B);
      const box = await frameJs<{ x: number; y: number; width: number; height: number }>(frame, `(() => { const r = document.getElementById("p").getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height }; })()`);
      let opened = false;
      if (frame && box) {
        if (label === "transparent") opened = await clickOpens(wc, await pointOf([[wc.mainFrame, `document.getElementById("f")`], [frame, `document.getElementById("p")`]]), 2500);
        const before = dropdown.token();
        await ctx.autofill.onFieldClicked(win, tab, { kind: "login", ...box }, { processId: frame.processId, routingId: frame.routingId, origin: frame.origin, top: false, doc: "0".repeat(32), sight: { box, shown: true, opacity: 1, viewWidth: 460, viewHeight: 200 } });
        opened ||= dropdown.token() !== before;
      }
      const c = await clean(frame);
      check(`frames: a frame that is ${label} gets no dropdown and no password`, Boolean(frame && box) && !opened && c.ok, { opened, ...c });
    }

    // 11: sandboxed frames: an opaque origin is never filled, nor a sandboxed frame that keeps its origin.
    for (const [label, sandbox] of [
      ["sandboxed (opaque origin)", "allow-scripts allow-forms"],
      ["sandboxed but keeps its origin", "allow-scripts allow-forms allow-same-origin"],
    ] as const) {
      const { tab, wc } = await open(host({ src: `${B}/ff-login`, sandbox }));
      const opaque = !sandbox.includes("allow-same-origin");
      let frame: WebFrameMain | undefined;
      await until(async () => {
        frame = wc.mainFrame.frames[0];
        return Boolean(frame && (await frameJs<boolean>(frame, `document.readyState === "complete" && Boolean(document.getElementById("p"))`)));
      });
      const opened = await clickOpens(wc, frame ? await pointOf([[wc.mainFrame, `document.getElementById("f")`], [frame, `document.getElementById("p")`]]) : null, 2500);
      let replayed = false;
      if (frame) {
        const box = { x: 20, y: 60, width: 160, height: 22 };
        const before = dropdown.token();
        await ctx.autofill.onFieldClicked(win, tab, { kind: "login", ...box }, { processId: frame.processId, routingId: frame.routingId, origin: frame.origin, top: false, doc: "0".repeat(32), sight: { box, shown: true, opacity: 1, viewWidth: 460, viewHeight: 200 } });
        replayed = dropdown.token() !== before;
      }
      const c = await clean(frame);
      check(`frames: a frame that is ${label} gets no dropdown and no password`, Boolean(frame) && (frame?.origin === "null") === opaque && !opened && !replayed && c.ok, { origin: frame?.origin, opened, replayed, ...c });
    }

    // 12: a data: URL frame (an opaque origin) offers nothing.
    {
      const { wc } = await open(host({ src: `data:text/html,${encodeURIComponent(`<!doctype html><body>${LOGIN_FORM}</body>`)}` }));
      let frame: WebFrameMain | undefined;
      await until(async () => {
        frame = wc.mainFrame.frames[0];
        return Boolean(frame && (await frameJs<boolean>(frame, `Boolean(document.getElementById("p"))`)));
      });
      const opened = await clickOpens(wc, frame ? await pointOf([[wc.mainFrame, `document.getElementById("f")`], [frame, `document.getElementById("p")`]]) : null, 2500);
      const c = await clean(frame);
      check("frames: a data: URL frame gets no dropdown and no password", Boolean(frame) && !opened && c.ok, { opened, ...c });
    }
  } finally {
    for (const tab of tabs) if (!tab.view.webContents.isDestroyed()) win.closeTab(tab.id);
    for (const id of [shop.id, embed.id, deep.id]) vault.remove(id);
  }
}
