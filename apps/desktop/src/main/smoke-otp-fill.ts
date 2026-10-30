import type http from "node:http";
import { nativeTheme, type MenuItemConstructorOptions, type WebContents } from "electron";
import { base32Encode, totpCode, type TotpConfig } from "../shared/totp";
import type { AppContext } from "./context";
import { windowShot } from "./smoke-cert-errors";
import { narrowWindow } from "./smoke-pairing";
import type { BrowserWindowCtl } from "./window";

interface Helpers {
  /** The smoke server; its pages are also served for every host under corvus-smoke.test. */
  url: string;
  win: BrowserWindowCtl;
  check: (name: string, ok: boolean, detail?: unknown) => void;
  capture: (name: string, wc: WebContents) => Promise<void>;
}

/**
 * A sign-in page asking for username, password and the 2FA code in one form. The code field is the
 * hard kind: its label is not tied to it, it has no autocomplete, inputmode or maxlength, only a
 * "1 2 3 4 5 6" placeholder and help text about the authenticator app.
 */
const ONE_FORM_PAGE = `<!doctype html><html><head><title>Perimeter server administration</title>
<style>body{font:14px sans-serif;margin:32px} .field{display:flex;flex-direction:column;gap:4px;margin:0 0 14px;max-width:320px} small{color:#666}</style></head><body>
<main><h1>Perimeter server administration</h1>
<form method="GET" action="/after-login" onsubmit="return false">
<div class="field"><label for="u">Username</label><input id="u" name="username" type="text" autocomplete="username"></div>
<div class="field"><label for="p">Password</label><input id="p" name="password" type="password" autocomplete="current-password"></div>
<div class="field"><label>Verification code</label><input id="code" name="code" type="text" placeholder="1 2 3 4 5 6" autocomplete="off"><small>The 6-digit code shown by your authenticator app.</small></div>
<button type="submit">Verify</button>
</form></main></body></html>`;

/** The second step of a two-step sign-in: the code field shows up a moment after the page loaded. */
const TWO_STEP_PAGE = `<!doctype html><html><head><title>Two-step verification</title></head><body>
<main><h1>Two-step verification</h1><div id="step"></div></main>
<script>setTimeout(() => { document.getElementById("step").innerHTML = '<form onsubmit="return false"><p>Enter the code from your authenticator app.</p><input id="token" name="token" inputmode="numeric" maxlength="6"><button>Verify</button></form>'; }, 900);</script>
</body></html>`;

/** The pages of the 2FA fill smoke, served by the shared smoke server. */
export function serveOtpFillSmokeRoute(req: http.IncomingMessage, res: http.ServerResponse): boolean {
  const pathname = (req.url ?? "/").split("?")[0] ?? "/";
  const page = pathname === "/otp-one-form" ? ONE_FORM_PAGE : pathname === "/otp-two-step" ? TWO_STEP_PAGE : null;
  if (!page) return false;
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(page);
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

const js = <T>(wc: WebContents, expr: string): Promise<T | null> => (wc.isDestroyed() ? Promise.resolve(null) : (wc.executeJavaScript(expr, true) as Promise<T>).catch(() => null));

/** A made-up secret per seed: no real account's. */
const fakeConfig = (seed: number): TotpConfig => ({ secret: base32Encode(Uint8Array.from({ length: 20 }, (_, i) => (seed * 71 + i * 37 + 11) & 0xff)), algorithm: "SHA1", digits: 6, period: 30 });

/** Codes valid around now (previous, current, next window), to tolerate a window rollover. */
async function nearbyCodes(config: TotpConfig): Promise<string[]> {
  const now = Date.now();
  return Promise.all([-30_000, 0, 30_000].map(async (offset) => (await totpCode(config, now + offset)).code));
}

const labelsOf = (items: MenuItemConstructorOptions[]): string[] => items.filter((i) => i.label).map((i) => i.label!);
const submenuOf = (items: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] => (items.find((i) => Array.isArray(i.submenu))?.submenu as MenuItemConstructorOptions[] | undefined) ?? [];

/**
 * Picking an account fills its 2FA code too: a page with username, password and verification code in
 * one form is filled by one pick in the menu under a login field, under the code field ("2FA code
 * for ..."), or in the omnibox key panel; what the person typed stays when the pick was for the code.
 * A two-step page's code field (shown after the page loaded) offers the site's account with a 2FA on
 * click and fills nothing before. Accounts of the page's own host come first, the domain's other
 * hosts' apart. Screenshots of the key panel with long usernames, light and dark, English and Spanish.
 */
export async function runOtpFillSmoke(ctx: AppContext, { url, win, check }: Helpers): Promise<void> {
  const port = new URL(url).port;
  const at = (sub: string): string => `http://${sub}.corvus-smoke.test:${port}`;
  const host = `edge.corvus-smoke.test:${port}`;
  const vault = win.profile.credentials;
  const edgeTotp = fakeConfig(1);
  const ids = [
    vault.add({ origin: at("edge"), username: "edge-admin", password: "pw-edge-smoke" }).id,
    // The 2FA as an import adds it: a login of its own, merged with the password's into one account.
    vault.add({ origin: at("edge"), username: "edge-admin", password: "", totp: edgeTotp }).id,
    vault.add({ origin: at("central"), username: "info-smoke@example.com", password: "", totp: fakeConfig(2) }).id,
    vault.add({ origin: at("cloud"), username: "x7q2k9m4zr8vt3wn5bpl-generated-smoke-account@example.com", password: "", totp: fakeConfig(3) }).id,
    vault.add({ origin: at("cloud"), username: "owner-smoke@example.com", password: "pw-cloud-smoke" }).id,
    vault.add({ origin: at("home"), username: "home-smoke", password: "pw-home-smoke" }).id,
  ];
  let items: MenuItemConstructorOptions[] | null = null;
  ctx.autofill.setFieldMenuProbe((shown) => {
    items = shown;
  });
  const menu = (): MenuItemConstructorOptions[] => items ?? [];
  const pick = (label: string): boolean => {
    const item = menu().find((i) => i.label === label);
    (item?.click as (() => void) | undefined)?.();
    return Boolean(item);
  };
  try {
    const tab = win.createTab(`${at("edge")}/otp-one-form`);
    const wc = tab.view.webContents;
    await until(() => !wc.isDestroyed() && wc.getURL().includes("/otp-one-form") && !tab.loading);
    const detected = await until(() => ctx.autofill.stateFor(win).otpAvailable && ctx.autofill.stateFor(win).matchCount > 0);
    check("2FA fill: a code field labelled apart, with a \"1 2 3 4 5 6\" placeholder and authenticator help, is detected", detected, ctx.autofill.stateFor(win));

    const clickField = async (page: WebContents, selector: string): Promise<void> => {
      items = null;
      const box = await js<{ x: number; y: number }>(page, `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
      if (!box) return;
      page.focus();
      page.sendInputEvent({ type: "mouseDown", x: box.x, y: box.y, button: "left", clickCount: 1 });
      page.sendInputEvent({ type: "mouseUp", x: box.x, y: box.y, button: "left", clickCount: 1 });
      await until(() => items !== null, 5000);
    };
    const fields = (): Promise<{ u: string; p: string; code: string } | null> =>
      js(wc, `({ u: document.getElementById("u").value, p: document.getElementById("p").value, code: document.getElementById("code").value })`);
    const clear = (): Promise<unknown> => js(wc, `["u", "p", "code"].forEach((id) => { document.getElementById(id).value = ""; }); true`);
    const allThree = async (username = "edge-admin"): Promise<boolean> =>
      until(async () => {
        const f = await fields();
        return Boolean(f && f.u === username && f.p === "pw-edge-smoke" && (await nearbyCodes(edgeTotp)).includes(f.code));
      }, 8000);

    // The code field: "2FA code for" the accounts with a 2FA, the page's own host first.
    await clickField(wc, "#code");
    const codeLabel = `2FA code for edge-admin  \u00b7  ${host}`;
    const codeMenu = labelsOf(menu());
    const codeOthers = labelsOf(submenuOf(menu()));
    check(
      "2FA fill: clicking the code field offers \"2FA code for\" the page's account, the domain's other accounts with a 2FA in a submenu",
      codeMenu[0] === codeLabel && codeMenu.includes("Other corvus-smoke.test accounts") && codeOthers.length === 2 && codeOthers.every((l) => l.startsWith("2FA code for ")) && !codeOthers.some((l) => l.includes("2FA only")),
      { codeMenu, codeOthers },
    );
    pick(codeLabel);
    check("2FA fill: picking it from the code field fills username, password and the current code", await allThree(), { ...(await fields()), code: undefined });

    // A login field: the same account, one pick fills all three.
    await clear();
    await clickField(wc, "#u");
    const loginLabel = `edge-admin  \u00b7  ${host}`;
    const loginMenu = labelsOf(menu());
    const loginOthers = labelsOf(submenuOf(menu()));
    check(
      "2FA fill: the login field menu lists the page's own host first and the domain's other accounts apart",
      loginMenu[0] === loginLabel && loginMenu.includes("Other corvus-smoke.test accounts") && loginOthers.length === 4 && loginOthers.some((l) => l.includes("\u2026")),
      { loginMenu, loginOthers },
    );
    pick(loginLabel);
    check("2FA fill: picking the account in a login field fills username, password and the current code", await allThree(), { ...(await fields()), code: undefined });

    // What the person typed stays when the pick is for the code.
    await clear();
    await js(wc, `document.getElementById("u").value = "typed-by-hand"; true`);
    await clickField(wc, "#code");
    pick(codeLabel);
    check("2FA fill: a pick for the code keeps a typed username and fills the empty fields", await allThree("typed-by-hand"), { ...(await fields()), code: undefined });

    // The omnibox key panel: one row per account, the page's own first, the rest folded away.
    await clear();
    await panelSmoke(ctx, win, { check, allThree, clear, codes: () => nearbyCodes(edgeTotp) });

    // A two-step sign-in: the code field shows up after the page loaded; nothing is filled before a click.
    const step = win.createTab(`${at("edge")}/otp-two-step`);
    const sw = step.view.webContents;
    await until(() => !sw.isDestroyed() && sw.getURL().includes("/otp-two-step") && !step.loading);
    await until(() => js<boolean>(sw, `Boolean(document.getElementById("token"))`).then(Boolean));
    await sleep(800);
    const untouched = (await js<string>(sw, `document.getElementById("token").value`)) === "";
    await clickField(sw, "#token");
    const stepMenu = labelsOf(menu());
    pick(codeLabel);
    const stepCode = await until(async () => (await nearbyCodes(edgeTotp)).includes((await js<string>(sw, `document.getElementById("token").value`)) ?? ""), 8000);
    check("2FA fill: a two-step page's late code field offers the site's account with a 2FA on click and fills its code", untouched && stepMenu[0] === codeLabel && stepCode, { untouched, stepMenu, stepCode });
    win.closeTab(step.id);
    win.closeTab(tab.id);
  } finally {
    ctx.autofill.setFieldMenuProbe(null);
    nativeTheme.themeSource = "system";
    ctx.settings.update({ appearance: { language: "en" } });
    for (const id of ids) vault.remove(id);
  }
}

const chromeJs = <T>(win: BrowserWindowCtl, expr: string): Promise<T | null> => js<T>(win.chrome.webContents, expr);

/** Where the key panel's parts sit: every part inside the panel, the panel inside the window. */
const PANEL_LAYOUT = `(() => {
  const panel = document.querySelector(".omni-autofill-panel");
  if (!panel) return null;
  const p = panel.getBoundingClientRect();
  const inside = [...panel.querySelectorAll("*")].every((el) => { const r = el.getBoundingClientRect(); return r.width === 0 || (r.left >= p.left - 1 && r.right <= p.right + 1); });
  return {
    rows: [...panel.querySelectorAll(".af-row .af-user")].map((e) => e.textContent),
    folded: Boolean(panel.querySelector(".af-others")) && !panel.querySelector(".af-others-list"),
    inside: inside && p.left >= 0 && p.right <= window.innerWidth,
    width: Math.round(p.width),
  };
})()`;

interface PanelLayout {
  rows: string[];
  folded: boolean;
  inside: boolean;
  width: number;
}

/**
 * The omnibox key panel on the one-form page: the page's own account first, the others folded, long
 * usernames inside the panel (also in a narrow window), the live code on the 2FA button, a row pick
 * and a code pick each filling all three fields; screenshots in English and Spanish, light and dark.
 */
async function panelSmoke(
  ctx: AppContext,
  win: BrowserWindowCtl,
  { check, allThree, clear, codes }: { check: Helpers["check"]; allThree: () => Promise<boolean>; clear: () => Promise<unknown>; codes: () => Promise<string[]> },
): Promise<void> {
  const openPanel = async (): Promise<boolean> => {
    await chromeJs(win, `document.querySelector(".omni-autofill-panel") || document.querySelector(".omni-autofill")?.click(); true`);
    return until(() => chromeJs<boolean>(win, `document.querySelectorAll(".omni-autofill-panel .af-row").length > 0`).then(Boolean), 5000);
  };
  const unfold = async (): Promise<boolean> => {
    await chromeJs(win, `document.querySelector(".af-others-list") || document.querySelector(".af-others")?.click(); true`);
    return until(() => chromeJs<boolean>(win, `document.querySelectorAll(".omni-autofill-panel .af-row").length === 5`).then(Boolean), 3000);
  };
  const closePanel = (): Promise<unknown> => chromeJs(win, `document.querySelector(".omni-panel-backdrop")?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); true`);
  const press = (selector: string): Promise<unknown> =>
    chromeJs(win, `document.querySelector(${JSON.stringify(selector)}).dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true })); true`);

  const opened = await openPanel();
  const folded = await chromeJs<PanelLayout>(win, PANEL_LAYOUT);
  check("2FA fill: the key panel lists the page's own account first, folds the domain's others, and nothing spills out", opened && folded?.rows[0] === "edge-admin" && folded.rows.length === 1 && folded.folded && folded.inside, folded);
  const unfolded = await unfold();
  const shown = await until(async () => (await codes()).includes((await chromeJs<string>(win, `document.querySelector(".af-row .af-code-num")?.textContent ?? ""`))?.replace(" ", "") ?? ""), 5000);
  const wide = await chromeJs<PanelLayout>(win, PANEL_LAYOUT);
  let narrow: PanelLayout | null = null;
  await narrowWindow(win.win, async () => {
    narrow = await chromeJs<PanelLayout>(win, PANEL_LAYOUT);
  });
  check(
    "2FA fill: unfolded, long usernames stay inside the panel (wide and narrow window) and the 2FA button shows the live code",
    unfolded && shown && wide?.inside === true && wide.rows.length === 5 && (narrow as PanelLayout | null)?.inside === true,
    { unfolded, shown, wide, narrow },
  );
  await closePanel();

  for (const language of ["en", "es"] as const) {
    ctx.settings.update({ appearance: { language } });
    win.chrome.webContents.reload();
    await until(() => chromeJs<boolean>(win, `Boolean(document.querySelector(".omni-autofill"))`).then(Boolean), 10_000);
    await sleep(500);
    await openPanel();
    nativeTheme.themeSource = "light";
    await sleep(400);
    await windowShot(win, `key-panel-${language}-folded-light`, "otp-fill");
    await unfold();
    await sleep(300);
    for (const theme of ["light", "dark"] as const) {
      nativeTheme.themeSource = theme;
      await sleep(400);
      await windowShot(win, `key-panel-${language}-${theme}`, "otp-fill");
    }
    await closePanel();
  }
  nativeTheme.themeSource = "system";
  ctx.settings.update({ appearance: { language: "en" } });
  win.chrome.webContents.reload();
  await until(() => chromeJs<boolean>(win, `Boolean(document.querySelector(".omni-autofill"))`).then(Boolean), 10_000);
  await sleep(500);

  await openPanel();
  await press(".af-row .af-fill");
  check("2FA fill: picking the account in the key panel fills username, password and the current code", await allThree());
  await clear();
  await openPanel();
  await press(".af-row .af-code");
  check("2FA fill: the key panel's \"Fill 2FA code\" button fills the code, and the empty username and password", await allThree());
}
