import type http from "node:http";
import { clipboard, nativeTheme, type WebContents } from "electron";
import { dropdownEntries, dropdownLabel } from "../shared/field-dropdown";
import { base32Encode, totpCode, type TotpConfig } from "../shared/totp";
import type { AppContext } from "./context";
import { tr } from "./menu-i18n";
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

/**
 * Reads and drives the account dropdown under a field of `win`: its labels as the field menu had them
 * (the first accounts, then "Other <domain> accounts"), the folded section's, and a pick of one (the
 * same as a press on it), plus waiting for it to open after a click (`token` before the click).
 */
export function dropdownDriver(ctx: AppContext, win: BrowserWindowCtl) {
  const state = () => ctx.autofill.fieldDropdown(win)?.state() ?? null;
  const words = { noUsername: tr("(no username)"), twoFaOnly: tr("2FA only"), codeFor: tr("2FA code for") };
  const label = (s: NonNullable<ReturnType<typeof state>>) => (m: (typeof s.first)[number]): string => dropdownLabel(m, s.kind, words);
  return {
    state,
    token: (): number => state()?.token ?? 0,
    /** Opened (and placed on screen) since `before`. */
    opened: (before: number, timeoutMs = 5000): Promise<boolean> => until(() => (state()?.token ?? 0) > before && Boolean(ctx.autofill.fieldDropdown(win)?.bounds()), timeoutMs),
    labels(): string[] {
      const s = state();
      return s ? [...s.first.map(label(s)), ...(s.others.length > 0 ? [tr("Other {domain} accounts", { domain: s.domain })] : [])] : [];
    },
    others(): string[] {
      const s = state();
      return s ? s.others.map(label(s)) : [];
    },
    pick(text: string): boolean {
      const s = state();
      const index = s ? dropdownEntries(s).findIndex((e) => e.type === "account" && label(s)(e.account) === text) : -1;
      if (!s || index < 0) return false;
      ctx.autofill.fieldDropdown(win)?.onAction({ type: "activate", token: s.token, index });
      return true;
    },
  };
}

/**
 * Picking an account fills its 2FA code too: a page with username, password and verification code in
 * one form is filled by one pick in the menu under a login field, under the code field ("2FA code
 * for ..."), or in the omnibox key panel; what the person typed stays when the pick was for the code.
 * A two-step page's code field (shown after the page loaded) offers the site's account with a 2FA on
 * click and fills nothing before. Accounts of the page's own host come first, the domain's other
 * hosts' apart, and the account used last on the site leads. A caret left in the address bar never
 * takes a click meant for the key button or its panel. The key panel's copy button says "Copied".
 * Screenshots of the key panel with long usernames, light and dark, English and Spanish.
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
  const dropdown = dropdownDriver(ctx, win);
  const menu = (): string[] => dropdown.labels();
  const pick = (label: string): boolean => dropdown.pick(label);
  try {
    const tab = win.createTab(`${at("edge")}/otp-one-form`);
    const wc = tab.view.webContents;
    await until(() => !wc.isDestroyed() && wc.getURL().includes("/otp-one-form") && !tab.loading);
    const detected = await until(() => ctx.autofill.stateFor(win).otpAvailable && ctx.autofill.stateFor(win).matchCount > 0);
    check("2FA fill: a code field labelled apart, with a \"1 2 3 4 5 6\" placeholder and authenticator help, is detected", detected, ctx.autofill.stateFor(win));

    const clickField = async (page: WebContents, selector: string): Promise<void> => {
      const before = dropdown.token();
      const box = await js<{ x: number; y: number }>(page, `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
      if (!box) return;
      page.focus();
      page.sendInputEvent({ type: "mouseDown", x: box.x, y: box.y, button: "left", clickCount: 1 });
      page.sendInputEvent({ type: "mouseUp", x: box.x, y: box.y, button: "left", clickCount: 1 });
      await dropdown.opened(before);
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
    const codeMenu = menu();
    const codeOthers = dropdown.others();
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
    const loginMenu = menu();
    const loginOthers = dropdown.others();
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

    // The dropdown leaves the keyboard in the field: real clicks, Ctrl+V, the arrows, Enter and Escape.
    await dropdownKeysSmoke(ctx, win, { check, tab, wc, dropdown, clickField, clear, allThree });

    // The omnibox key panel: one row per account, the page's own first, the rest folded away.
    await clear();
    await panelSmoke(ctx, win, { check, allThree, clear, codes: () => nearbyCodes(edgeTotp) });

    // The address bar keeps a caret it had when the page took the keyboard: real clicks on the key
    // button, in its panel and in a field's menu must not hand it back to the address bar.
    await clear();
    await caretSmoke(win, { check, allThree, clear, fieldMenu: async () => {
      await clickField(wc, "#u");
      return pick(loginLabel);
    } });

    // A two-step sign-in: the code field shows up after the page loaded; nothing is filled before a click.
    const openTwoStep = async (sub: string) => {
      const step = win.createTab(`${at(sub)}/otp-two-step`);
      const sw = step.view.webContents;
      await until(() => !sw.isDestroyed() && sw.getURL().includes("/otp-two-step") && !step.loading);
      await until(() => js<boolean>(sw, `Boolean(document.getElementById("token"))`).then(Boolean));
      return { step, sw, token: () => js<string>(sw, `document.getElementById("token").value`) };
    };
    const { step, sw, token } = await openTwoStep("edge");
    await sleep(800);
    const untouched = (await token()) === "";
    await clickField(sw, "#token");
    const stepMenu = menu();
    pick(codeLabel);
    const stepCode = await until(async () => (await nearbyCodes(edgeTotp)).includes((await token()) ?? ""), 8000);
    check("2FA fill: a two-step page's late code field offers the site's account with a 2FA on click and fills its code", untouched && stepMenu[0] === codeLabel && stepCode, { untouched, stepMenu, stepCode });
    win.closeTab(step.id);

    // Several accounts with a 2FA and none of the page's own host: the one used last on the site comes
    // first (the field menu and the key panel), the others still listed below it.
    const verify = await openTwoStep("verify");
    await clickField(verify.sw, "#token");
    const before = menu().filter((l) => l.startsWith("2FA code for "));
    const infoLabel = before.find((l) => l.includes("info-smoke@example.com")) ?? "";
    pick(infoLabel);
    const infoFilled = await until(async () => (await nearbyCodes(fakeConfig(2))).includes((await verify.token()) ?? ""), 8000);
    win.closeTab(verify.step.id);
    const again = await openTwoStep("verify");
    await clickField(again.sw, "#token");
    const after = menu().filter((l) => l.startsWith("2FA code for "));
    await chromeJs(win, `document.querySelector(".omni-autofill")?.click(); true`);
    await until(() => chromeJs<boolean>(win, `document.querySelectorAll(".omni-autofill-panel .af-row").length > 0`).then(Boolean), 5000);
    const panelRows = (await chromeJs<string[]>(win, `[...document.querySelectorAll(".omni-autofill-panel .af-row .af-user")].map((e) => e.textContent)`)) ?? [];
    await windowShot(win, "key-panel-two-step-last-used", "otp-fill");
    await chromeJs(win, `document.querySelector(".omni-panel-backdrop")?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); true`);
    check(
      "2FA fill: on a two-step page with several accounts with a 2FA, the one used last on the site is offered first, the others below it",
      before.length === 3 && before[0] !== infoLabel && infoFilled && after[0] === infoLabel && after.length === 3 && before.every((l) => after.includes(l)) && panelRows[0] === "info-smoke@example.com" && panelRows.length === 3,
      { before, infoFilled, after, panelRows },
    );
    win.closeTab(again.step.id);
    win.closeTab(tab.id);

    await copySmoke(ctx, win, { check, url: `${at("edge")}/login`, codes: () => nearbyCodes(edgeTotp) });
  } finally {
    nativeTheme.themeSource = "system";
    ctx.settings.update({ appearance: { language: "en" } });
    for (const id of ids) vault.remove(id);
  }
}

const chromeJs = <T>(win: BrowserWindowCtl, expr: string): Promise<T | null> => js<T>(win.chrome.webContents, expr);

/**
 * Where the key panel's parts sit: every part inside the panel, the panel inside the window, and each
 * "2FA only" tag shown in full inside its row (not cut off by the username or the 2FA button).
 */
const PANEL_LAYOUT = `(() => {
  const panel = document.querySelector(".omni-autofill-panel");
  if (!panel) return null;
  const p = panel.getBoundingClientRect();
  const inside = [...panel.querySelectorAll("*")].every((el) => { const r = el.getBoundingClientRect(); return r.width === 0 || (r.left >= p.left - 1 && r.right <= p.right + 1); });
  const tags = [...panel.querySelectorAll(".af-tag")].map((tag) => {
    const r = tag.getBoundingClientRect();
    const fill = tag.closest(".af-fill").getBoundingClientRect();
    return { text: tag.textContent, whole: r.width > 0 && tag.scrollWidth <= tag.clientWidth + 1 && r.right <= fill.right + 1 };
  });
  return {
    rows: [...panel.querySelectorAll(".af-row .af-user")].map((e) => e.textContent),
    folded: Boolean(panel.querySelector(".af-others")) && !panel.querySelector(".af-others-list"),
    inside: inside && p.left >= 0 && p.right <= window.innerWidth,
    width: Math.round(p.width),
    tags,
  };
})()`;

interface PanelLayout {
  rows: string[];
  folded: boolean;
  inside: boolean;
  width: number;
  tags: Array<{ text: string; whole: boolean }>;
}

/** Every "2FA only" tag (the two 2FA-only accounts of the one-form page, unfolded) shown in full, with `label`. */
const tagsWhole = (layout: PanelLayout | null, label: string): boolean => layout?.tags.length === 2 && layout.tags.every((tag) => tag.whole && tag.text === label);

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

  const tagShown: Record<string, unknown> = {};
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
    const label = language === "es" ? "Solo 2FA" : "2FA only";
    const full = await chromeJs<PanelLayout>(win, PANEL_LAYOUT);
    let small: PanelLayout | null = null;
    await narrowWindow(win.win, async () => {
      small = await chromeJs<PanelLayout>(win, PANEL_LAYOUT);
    });
    tagShown[language] = { ok: tagsWhole(full, label) && tagsWhole(small, label), width: full?.width, tags: full?.tags, narrow: (small as PanelLayout | null)?.tags };
    for (const theme of ["light", "dark"] as const) {
      nativeTheme.themeSource = theme;
      await sleep(400);
      await windowShot(win, `key-panel-${language}-${theme}`, "otp-fill");
    }
    await closePanel();
  }
  check(
    "2FA fill: the \"2FA only\" tag shows in full next to the username in the 360 px panel (and a narrow window), in English and Spanish",
    Object.values(tagShown).every((v) => (v as { ok: boolean }).ok),
    tagShown,
  );
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

/** A real click on Corvus's UI: its view takes the keyboard first, as on screen, then the mouse goes down and up. */
async function clickChrome(win: BrowserWindowCtl, selector: string): Promise<boolean> {
  const box = await chromeJs<{ x: number; y: number }>(
    win,
    `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`,
  );
  if (!box) return false;
  const chromeWc = win.chrome.webContents;
  chromeWc.focus();
  await sleep(100);
  for (const type of ["mouseDown", "mouseUp"] as const) chromeWc.sendInputEvent({ type, x: box.x, y: box.y, button: "left", clickCount: 1 });
  await sleep(150);
  return true;
}

/** The address bar had the caret and the page took the keyboard: the caret stays behind in Corvus's UI. */
async function leaveCaret(win: BrowserWindowCtl): Promise<boolean | null> {
  win.focusOmnibox();
  await sleep(200);
  win.focusContent();
  await sleep(300);
  return chromeJs<boolean>(win, `document.activeElement === document.querySelector(".omni-input")`);
}

const OMNIBOX_FOCUSED = `Boolean(document.querySelector(".omnibox.focused"))`;

/**
 * A click on the key button while the address bar still holds the caret it had before the page took
 * the keyboard opens the panel (the address bar does not take the click), and a click on a row of the
 * panel fills the account; a pick in a login field's menu fills too and leaves the address bar alone.
 */
async function caretSmoke(
  win: BrowserWindowCtl,
  { check, allThree, clear, fieldMenu }: { check: Helpers["check"]; allThree: () => Promise<boolean>; clear: () => Promise<unknown>; fieldMenu: () => Promise<boolean> },
): Promise<void> {
  const leftover = await leaveCaret(win);
  const clicked = await clickChrome(win, ".omni-autofill");
  const opened = await until(() => chromeJs<boolean>(win, `Boolean(document.querySelector(".omni-autofill-panel.af-accounts"))`).then(Boolean), 2000);
  const barFocused = await chromeJs<boolean>(win, OMNIBOX_FOCUSED);
  await windowShot(win, "key-panel-after-leftover-caret", "otp-fill");
  const rowClicked = opened && (await clickChrome(win, ".omni-autofill-panel .af-row .af-fill"));
  const filled = rowClicked && (await allThree());
  check(
    "2FA fill: with a caret left in the address bar, a click on the key button opens its panel and a click on a row fills the account",
    clicked && opened && barFocused === false && filled,
    { leftover, clicked, opened, barFocused, rowClicked, filled },
  );
  await chromeJs(win, `document.querySelector(".omni-panel-backdrop")?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); true`);

  await clear();
  const leftoverAgain = await leaveCaret(win);
  const picked = await fieldMenu();
  const menuFilled = picked && (await allThree());
  const barAfterMenu = await chromeJs<boolean>(win, OMNIBOX_FOCUSED);
  check(
    "2FA fill: with a caret left in the address bar, a pick in a login field's menu fills the account and the address bar stays unfocused",
    menuFilled && barAfterMenu === false,
    { leftover: leftoverAgain, picked, menuFilled, barAfterMenu },
  );
}

/**
 * On a page without a code field the key panel's 2FA button copies the code: the button says
 * "Copied" for a moment (the code is on the clipboard) and the panel then closes by itself.
 */
async function copySmoke(ctx: AppContext, win: BrowserWindowCtl, { check, url, codes }: { check: Helpers["check"]; url: string; codes: () => Promise<string[]> }): Promise<void> {
  const tab = win.createTab(url);
  const wc = tab.view.webContents;
  await until(() => !wc.isDestroyed() && wc.getURL().includes("/login") && !tab.loading);
  await until(() => ctx.autofill.stateFor(win).matchCount > 0);
  const results: Record<string, unknown> = {};
  for (const [language, copiedLabel, theme] of [["en", "Copied", "light"], ["es", "Copiado", "dark"]] as const) {
    ctx.settings.update({ appearance: { language } });
    win.chrome.webContents.reload();
    await until(() => chromeJs<boolean>(win, `Boolean(document.querySelector(".omni-autofill"))`).then(Boolean), 10_000);
    await sleep(500);
    nativeTheme.themeSource = theme;
    clipboard.writeText("nothing copied yet");
    await chromeJs(win, `document.querySelector(".omni-autofill")?.click(); true`);
    await until(() => chromeJs<boolean>(win, `Boolean(document.querySelector(".omni-autofill-panel .af-code.copy"))`).then(Boolean), 5000);
    const pressedAt = Date.now();
    await chromeJs(win, `document.querySelector(".af-code.copy").dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true })); true`);
    const says = await until(() => chromeJs<boolean>(win, `document.querySelector(".af-code.copy.copied .af-swap > span:not(.off)")?.textContent === ${JSON.stringify(copiedLabel)}`).then(Boolean), 1000);
    const clip = String(await clipboard.readText());
    const expected = await codes();
    const onClipboard = expected.includes(clip);
    await windowShot(win, `key-panel-copied-${language}-${theme}`, "otp-fill");
    const stillOpen = (await chromeJs<boolean>(win, `Boolean(document.querySelector(".omni-autofill-panel"))`)) === true;
    const closed = await until(() => chromeJs<boolean>(win, `!document.querySelector(".omni-autofill-panel")`).then(Boolean), 4000);
    results[language] = { says, onClipboard, clip: clip.length > 12 ? `${clip.slice(0, 12)}...` : clip, expected, stillOpen, closed, closedAfterMs: Date.now() - pressedAt };
  }
  nativeTheme.themeSource = "system";
  ctx.settings.update({ appearance: { language: "en" } });
  win.chrome.webContents.reload();
  await until(() => chromeJs<boolean>(win, `Boolean(document.querySelector(".omni-input"))`).then(Boolean), 10_000);
  win.closeTab(tab.id);
  check(
    "2FA fill: the key panel's copy button says \"Copied\" (English and Spanish), the code is on the clipboard, and the panel then closes by itself",
    Object.values(results).every((r) => {
      const v = r as { says: boolean; onClipboard: boolean; stillOpen: boolean; closed: boolean; closedAfterMs: number };
      return v.says && v.onClipboard && v.stillOpen && v.closed && v.closedAfterMs >= 1000;
    }),
    results,
  );
}

/**
 * The dropdown under a field never takes the keyboard (the native menu it replaced did, so Ctrl+V did
 * nothing): after a real click into the username or the code field it shows under the field while
 * the page and the field keep the keyboard; a real Ctrl+V pastes into the field and closes it; Escape
 * closes it; the down arrow opens it from the field, moves to the first account, and Enter fills it;
 * and a real click on one of its rows fills too and leaves the keyboard on the page. Screenshots in
 * English (light) and Spanish (dark).
 */
async function dropdownKeysSmoke(
  ctx: AppContext,
  win: BrowserWindowCtl,
  {
    check,
    tab,
    wc,
    dropdown,
    clickField,
    clear,
    allThree,
  }: {
    check: Helpers["check"];
    tab: { view: { getBounds(): { x: number; y: number } } };
    wc: WebContents;
    dropdown: ReturnType<typeof dropdownDriver>;
    clickField: (page: WebContents, selector: string) => Promise<void>;
    clear: () => Promise<unknown>;
    allThree: () => Promise<boolean>;
  },
): Promise<void> {
  const key = (keyCode: string, modifiers: Array<"control"> = []): void => {
    for (const type of ["keyDown", "keyUp"] as const) wc.sendInputEvent({ type, keyCode, modifiers });
  };
  const value = (id: string): Promise<string | null> => js<string>(wc, `document.getElementById(${JSON.stringify(id)}).value`);
  const where = async (id: string) => {
    const menu = ctx.autofill.fieldDropdown(win);
    return {
      open: Boolean(dropdown.state()),
      bounds: menu?.bounds() ?? null,
      pageFocused: wc.isFocused(),
      fieldFocused: (await js<boolean>(wc, `document.activeElement === document.getElementById(${JSON.stringify(id)})`)) === true,
      chromeFocused: win.chrome.webContents.isFocused(),
      menuFocused: menu?.webContents?.isFocused() ?? false,
    };
  };

  for (const [id, kind, pasteText] of [["u", "login", "pasted-smoke-user"], ["code", "otp", "246810"]] as const) {
    await clear();
    await clickField(wc, `#${id}`);
    const bottom = (await js<number>(wc, `document.getElementById(${JSON.stringify(id)}).getBoundingClientRect().bottom`)) ?? 0;
    const shown = await where(id);
    const fieldBottom = tab.view.getBounds().y + bottom;
    const under = Boolean(shown.bounds && shown.bounds.y >= fieldBottom - 12 && shown.bounds.y <= fieldBottom + 4);
    check(
      `field dropdown (${kind}): a real click into the field shows it right under the field, and the page and the field keep the keyboard`,
      shown.open && under && shown.pageFocused && shown.fieldFocused && !shown.chromeFocused && !shown.menuFocused && dropdown.state()?.kind === kind,
      { ...shown, fieldBottom },
    );
    await windowShot(win, `field-dropdown-${kind}-en-light`, "otp-fill");

    clipboard.writeText(pasteText);
    key("V", ["control"]);
    const pasted = await until(async () => (await value(id)) === pasteText, 3000);
    const closedByPaste = await until(() => !dropdown.state(), 3000);
    check(`field dropdown (${kind}): a real Ctrl+V pastes into the field and closes the dropdown`, pasted && closedByPaste, { pasted, closedByPaste, value: await value(id) });

    await clear();
    await clickField(wc, `#${id}`);
    const openBefore = Boolean(dropdown.state());
    key("Escape");
    const closedByEscape = await until(() => !dropdown.state(), 3000);
    const afterEscape = await where(id);
    check(`field dropdown (${kind}): Escape closes it and the field keeps the keyboard`, openBefore && closedByEscape && afterEscape.pageFocused && afterEscape.fieldFocused, { openBefore, closedByEscape, ...afterEscape });

    const before = dropdown.token();
    key("Down");
    const reopened = await dropdown.opened(before);
    key("Down");
    const highlighted = await until(() => dropdown.state()?.highlight === 0, 2000);
    key("Enter");
    const filled = await allThree();
    check(
      `field dropdown (${kind}): the down arrow opens it from the field, moves to the first account, and Enter fills it`,
      reopened && highlighted && filled && !dropdown.state(),
      { reopened, highlighted, filled },
    );
  }

  // A real click on a row of the dropdown (its view takes the keyboard for the click, then hands it back).
  await clear();
  await clickField(wc, "#u");
  const menuWc = ctx.autofill.fieldDropdown(win)?.webContents ?? null;
  const row = menuWc ? await js<{ x: number; y: number }>(menuWc, `(() => { const r = document.querySelector(".af-row").getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`) : null;
  if (menuWc && row) {
    menuWc.focus();
    for (const type of ["mouseDown", "mouseUp"] as const) menuWc.sendInputEvent({ type, x: row.x, y: row.y, button: "left", clickCount: 1 });
  }
  const clickedFill = await allThree();
  const back = await until(() => wc.isFocused(), 3000);
  const barFocused = await chromeJs<boolean>(win, `Boolean(document.querySelector(".omnibox.focused"))`);
  check(
    "field dropdown: a real click on a row fills the account and the keyboard goes back to the page (not to Corvus's UI)",
    Boolean(row) && clickedFill && back && !win.chrome.webContents.isFocused() && barFocused === false,
    { row, clickedFill, back, barFocused },
  );

  // In Spanish and dark.
  ctx.settings.update({ appearance: { language: "es" } });
  nativeTheme.themeSource = "dark";
  await clear();
  for (const [id, kind] of [["u", "login"], ["code", "otp"]] as const) {
    await clickField(wc, `#${id}`);
    await sleep(300);
    await windowShot(win, `field-dropdown-${kind}-es-dark`, "otp-fill");
    key("Escape");
    await until(() => !dropdown.state(), 2000);
  }
  ctx.settings.update({ appearance: { language: "en" } });
  nativeTheme.themeSource = "system";
}
