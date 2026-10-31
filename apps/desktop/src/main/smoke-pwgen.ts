import type http from "node:http";
import { clipboard, nativeTheme, type WebContents } from "electron";
import type { FieldDropdownState } from "../shared/credentials-ipc";
import { dropdownEntries } from "../shared/field-dropdown";
import { PASSWORD_CHARSETS } from "../shared/password-rules";
import type { AppContext } from "./context";
import { windowShot } from "./smoke-cert-errors";
import type { BrowserWindowCtl, TabRuntime } from "./window";

interface Helpers {
  /** The smoke server; its pages are also served for every host under corvus-smoke.test. */
  url: string;
  win: BrowserWindowCtl;
  check: (name: string, ok: boolean, detail?: unknown) => void;
}

const page = (title: string, body: string): string => `<!doctype html><html><head><title>${title}</title>
<style>body{font:14px sans-serif;margin:32px} .field{display:flex;flex-direction:column;gap:4px;margin:0 0 14px;max-width:320px}</style></head><body>
<main><h1>${title}</h1><form onsubmit="event.preventDefault(); document.body.dataset.sent = '1'">${body}<button type="submit">Continue</button></form></main></body></html>`;

const field = (id: string, label: string, attrs: string): string => `<div class="field"><label for="${id}">${label}</label><input id="${id}" ${attrs}></div>`;

/** A sign-up form: e-mail, a new password (autocomplete new-password) and its confirmation (named by its label only). */
const SIGNUP_PAGE = page(
  "Create your account",
  field("email", "E-mail", 'name="email" type="email" autocomplete="username"') + field("pw", "Password", 'name="password" type="password" autocomplete="new-password"') + field("pw2", "Confirm password", 'name="password2" type="password"'),
);
/** A change-password form: current, new and confirmation, told apart by their labels only. */
const CHANGE_PAGE = page(
  "Change your password",
  field("current", "Current password", 'name="current" type="password"') + field("new", "New password", 'name="new" type="password"') + field("confirm", "Confirm new password", 'name="confirm" type="password"'),
);
/** A sign-up form whose password takes at most 16 letters and digits. */
const LIMITS_PAGE = page(
  "Join the club",
  field("user", "Username", 'name="user" type="text"') + field("pw", "Password", 'name="pw" type="password" autocomplete="new-password" maxlength="16" pattern="[A-Za-z0-9]+"') + field("pw2", "Repeat password", 'name="pw2" type="password"'),
);
/** A sign-in form: one password field. */
const SIGNIN_PAGE = page("Sign in", field("u", "Username", 'name="u" type="text" autocomplete="username"') + field("p", "Password", 'name="p" type="password" autocomplete="current-password"'));

const PAGES: Record<string, string> = { "/pwgen-signup": SIGNUP_PAGE, "/pwgen-change": CHANGE_PAGE, "/pwgen-limits": LIMITS_PAGE, "/pwgen-signin": SIGNIN_PAGE };

/** The pages of the password generator smoke, served by the shared smoke server. */
export function servePasswordGeneratorSmokeRoute(req: http.IncomingMessage, res: http.ServerResponse): boolean {
  const html = PAGES[(req.url ?? "/").split("?")[0] ?? "/"];
  if (!html) return false;
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
  return true;
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function until(cond: () => boolean | Promise<boolean>, timeoutMs = 8000): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await cond()) return true;
    await sleep(100);
  }
  return false;
}

export const js = <T>(wc: WebContents | null | undefined, expr: string): Promise<T | null> =>
  !wc || wc.isDestroyed() ? Promise.resolve(null) : (wc.executeJavaScript(expr, true) as Promise<T>).catch(() => null);

const SYMBOL = new RegExp(`[${PASSWORD_CHARSETS.symbols.replace(/[-\\^\]]/g, "\\$&")}]`);
const DIGIT = /[0-9]/;

/** A real click at the middle of an element of `wc` (a click on a view first gives it the keyboard, as on screen). */
export async function clickAt(wc: WebContents, selector: string): Promise<boolean> {
  const box = await js<{ x: number; y: number }>(wc, `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
  if (!box) return false;
  wc.focus();
  for (const type of ["mouseDown", "mouseUp"] as const) wc.sendInputEvent({ type, x: box.x, y: box.y, button: "left", clickCount: 1 });
  return true;
}

/** Real keys: named ones (Enter, Escape, Down, V with Ctrl) or characters typed. */
export function key(wc: WebContents, keyCode: string, modifiers: Array<"control"> = []): void {
  for (const type of ["keyDown", "keyUp"] as const) wc.sendInputEvent({ type, keyCode, modifiers });
}
function typeText(wc: WebContents, text: string): void {
  for (const ch of text) for (const type of ["keyDown", "char", "keyUp"] as const) wc.sendInputEvent({ type, keyCode: ch });
}

/**
 * The strong password generator in the dropdown under password fields (CORVUS_SMOKE_ONLY=pwgen runs
 * only this): a sign-up form's new password with no saved login gets "Suggest a strong password" with a
 * preview, while the field keeps the keyboard (typing and Ctrl+V go to it, the arrows and Enter open the
 * generator, Escape closes it); the generator's length (typed in its box, which keeps the keyboard) and
 * classes change the password and are remembered; Copy puts it on the clipboard; Use fills the new
 * password and its confirmation (never a change form's current one) and the save prompt offers it after
 * the submit; a field's maxlength and pattern are respected, and said; a filled password field offers
 * "Copy password"; a sign-in field with a saved login, and agents' tabs, get no suggestion. Screenshots
 * in English and Spanish.
 */
export async function runPasswordGeneratorSmoke(ctx: AppContext, { url, win, check }: Helpers): Promise<void> {
  const port = new URL(url).port;
  const at = (sub: string, path: string): string => `http://${sub}.pwgen.corvus-smoke.test:${port}${path}`;
  const before = { ...ctx.settings.get().passwords };
  const { language: languageBefore } = ctx.settings.get().appearance;
  ctx.settings.update({ appearance: { language: "en" }, passwords: { generatorLength: 24, generatorLowercase: true, generatorUppercase: true, generatorDigits: true, generatorSymbols: true } });
  // The saved login is for the smoke server's IP address: its logins stay on that host (the pages here
  // are on other hosts of one domain, which would share a login saved for one of them).
  const knownSite = url.replace(/\/$/, "");
  const known = win.profile.credentials.add({ origin: knownSite, username: "known-smoke@example.com", password: "known-pass-smoke-1" });
  const dropdown = () => ctx.autofill.fieldDropdown(win);
  const state = (): FieldDropdownState | null => dropdown()?.state() ?? null;
  const menu = (): WebContents | null => dropdown()?.webContents ?? null;
  const types = (): string[] => {
    const s = state();
    return s ? dropdownEntries(s).map((e) => e.type) : [];
  };
  const opened = (token: number): Promise<boolean> => until(() => (state()?.token ?? 0) > token && Boolean(dropdown()?.bounds()), 5000);
  const closed = (): Promise<boolean> => until(() => !state(), 4000);
  const tabs: TabRuntime[] = [];
  const open = async (target: string): Promise<{ tab: TabRuntime; wc: WebContents }> => {
    const tab = win.createTab(target);
    tabs.push(tab);
    const wc = tab.view.webContents;
    await until(() => !wc.isDestroyed() && wc.getURL() === target && !tab.loading);
    await sleep(400);
    return { tab, wc };
  };
  const clickField = async (wc: WebContents, selector: string): Promise<boolean> => {
    const token = state()?.token ?? 0;
    await clickAt(wc, selector);
    return opened(token);
  };
  const value = (wc: WebContents, id: string): Promise<string | null> => js<string>(wc, `document.getElementById(${JSON.stringify(id)}).value`);
  const setValue = (wc: WebContents, id: string, text: string): Promise<unknown> =>
    js(wc, `(() => { const el = document.getElementById(${JSON.stringify(id)}); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, ${JSON.stringify(text)}); el.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`);
  const focusOn = async (wc: WebContents, id: string): Promise<boolean> => wc.isFocused() && (await js<boolean>(wc, `document.activeElement === document.getElementById(${JSON.stringify(id)})`)) === true;
  const generated = (): string => state()?.generator?.password ?? "";
  const promptPassword = (password: string, username: string): Promise<boolean> =>
    until(async () => (await js<boolean>(win.chrome.webContents, `(() => { const f = document.querySelector(".af-save"); return Boolean(f) && f.querySelector("input[name=password]").value === ${JSON.stringify(password)} && f.querySelector("input[name=username]").value === ${JSON.stringify(username)}; })()`)) === true, 6000);
  const cancelPrompt = async (): Promise<void> => {
    await js(win.chrome.webContents, `document.querySelector(".af-save .af-cancel")?.click(); true`);
    await until(async () => (await js<boolean>(win.chrome.webContents, `!document.querySelector(".af-save")`)) === true, 3000);
  };
  const shot = (name: string): Promise<void> => windowShot(win, name, "pwgen");

  try {
    // ---- A sign-up form, no saved login: the suggestion, the keyboard staying in the field.
    const signup = await open(at("signup", "/pwgen-signup"));
    const wc = signup.wc;
    const shown = await clickField(wc, "#pw");
    const first = state();
    check(
      "password generator: a new-password field with no saved login suggests a strong password, with a preview, and the field keeps the keyboard",
      shown && JSON.stringify(types()) === JSON.stringify(["suggest", "manage"]) && first?.generator?.password.length === 24 && !first.generator.open && (await focusOn(wc, "pw")) && !menu()?.isFocused(),
      { shown, types: types(), length: first?.generator?.password.length },
    );
    await shot("suggest-en");

    clipboard.writeText("pasted-smoke-1");
    key(wc, "V", ["control"]);
    const pasted = await until(async () => (await value(wc, "pw")) === "pasted-smoke-1", 3000);
    check("password generator: Ctrl+V with the suggestion open pastes into the field and closes it", pasted && (await closed()), { pasted });
    await setValue(wc, "pw", "");
    await clickField(wc, "#pw");
    typeText(wc, "k");
    const typed = await until(async () => (await value(wc, "pw")) === "k", 3000);
    check("password generator: typing with the suggestion open goes to the field and closes it", typed && (await closed()), { typed });
    await setValue(wc, "pw", "");

    // The arrows and Enter open the generator from the field; Escape closes it.
    await clickField(wc, "#pw");
    key(wc, "Down");
    const highlighted = await until(() => state()?.highlight === 0, 2000);
    key(wc, "Enter");
    const genOpen = await until(() => state()?.generator?.open === true, 2000);
    const keyboardStays = await focusOn(wc, "pw");
    key(wc, "Escape");
    const escaped = await closed();
    check("password generator: Down and Enter open the generator from the field (which keeps the keyboard), Escape closes it", highlighted && genOpen && keyboardStays && escaped && (await focusOn(wc, "pw")), { highlighted, genOpen, keyboardStays, escaped });

    // A real click on the suggestion opens the generator; the keyboard goes back to the field.
    await clickField(wc, "#pw");
    const preview = generated();
    await clickAt(menu()!, ".fd-suggest");
    const clickedOpen = await until(() => state()?.generator?.open === true, 2000);
    const back = await until(() => focusOn(wc, "pw"), 2000);
    check("password generator: a click on the suggestion opens the generator with that password, and the keyboard goes back to the field", clickedOpen && back && generated() === preview, { clickedOpen, back });
    await sleep(300);
    await shot("generator-en");

    // The classes: a real click on Symbols, then digits off: the password follows.
    await clickAt(menu()!, ".fd-check:nth-child(4)");
    const noSymbols = await until(() => state()?.generator?.options.symbols === false && !SYMBOL.test(generated()), 2000);
    const backAfterBox = await until(() => focusOn(wc, "pw"), 2000);
    dropdown()?.onAction({ type: "toggle", token: state()!.token, option: "digits" });
    const noDigits = await until(() => state()?.generator?.options.digits === false && !DIGIT.test(generated()) && !SYMBOL.test(generated()), 2000);
    check("password generator: unticking symbols and digits makes a password without them (a click on a box leaves the keyboard in the field)", noSymbols && noDigits && backAfterBox, { noSymbols, noDigits, backAfterBox, password: generated().replace(/./g, "*") });
    for (const option of ["digits", "symbols"] as const) dropdown()?.onAction({ type: "toggle", token: state()!.token, option });
    const restored = await until(() => SYMBOL.test(generated()) && DIGIT.test(generated()), 2000);

    // The length, typed in its box: the dropdown keeps the keyboard there until Escape gives it back.
    await clickAt(menu()!, ".fd-gen-len");
    await sleep(400);
    const typing = Boolean(menu()?.isFocused()) && !wc.isFocused() && Boolean(state()?.generator?.open);
    menu()?.selectAll();
    await sleep(100);
    typeText(menu()!, "32");
    key(menu()!, "Enter");
    const longer = await until(() => state()?.generator?.options.length === 32 && generated().length === 32, 3000);
    check("password generator: a click in the length box keeps the keyboard in the dropdown, and the typed length makes a password that long", restored && typing && longer && Boolean(state()), { restored, typing, longer, length: generated().length });
    key(menu()!, "Escape");
    const escapedTyping = await closed();
    const fieldBack = await until(() => focusOn(wc, "pw"), 2000);
    check("password generator: Escape in the length box closes it and gives the keyboard back to the field", escapedTyping && fieldBack, { escapedTyping, fieldBack });
    check("password generator: the person's last choices are remembered", ctx.settings.get().passwords.generatorLength === 32 && ctx.settings.get().passwords.generatorSymbols, ctx.settings.get().passwords);

    // Copy, then Use: the new password and its confirmation.
    await clickField(wc, "#pw");
    const remembered = state()?.generator?.options.length;
    await clickAt(menu()!, ".fd-suggest");
    await until(() => state()?.generator?.open === true, 2000);
    const password = generated();
    clipboard.writeText("");
    await clickAt(menu()!, ".fd-gen-copy");
    const copied = await until(async () => (await clipboard.readText()) === password && state()?.generator?.copied === true, 2000);
    check("password generator: Copy puts the generated password on the clipboard and says Copied", remembered === 32 && copied, { remembered, copied });
    await shot("generator-copied-en");
    await clickAt(menu()!, ".fd-gen-use");
    const filled = await until(async () => (await value(wc, "pw")) === password && (await value(wc, "pw2")) === password, 4000);
    const secret = (await js<boolean>(wc, `document.getElementById("pw").hasAttribute("data-corvus-secret") && document.getElementById("pw2").hasAttribute("data-corvus-secret")`)) === true;
    const kept = ctx.autofill.stateFor(win);
    check(
      "password generator: Use fills the new password and its confirmation (marked secret), and keeps it ready to save before the form is sent",
      filled && secret && !state() && (await value(wc, "email")) === "" && kept.canSave && !kept.savePrompt,
      { filled, secret, state: kept },
    );
    await setValue(wc, "email", "new-smoke@example.com");
    await shot("signup-filled-en");

    // The field holds a password now: "Copy password" copies it, never showing it.
    await clickField(wc, "#pw");
    const withCopy = types();
    clipboard.writeText("");
    await clickAt(menu()!, ".fd-copy");
    const fieldCopied = await until(async () => (await clipboard.readText()) === password && state()?.copy === "copied", 2000);
    const shownText = await js<string>(menu(), `document.body.innerText`);
    check(
      "password generator: a filled password field offers Copy password, which copies its value without showing it and closes",
      withCopy[0] === "copy" && fieldCopied && !String(shownText).includes(password) && (await closed()),
      { withCopy, fieldCopied },
    );

    // Sent: the save prompt offers the generated password with the e-mail.
    await js(wc, `document.querySelector("form").requestSubmit(); true`);
    check("password generator: after the form is sent, the save prompt offers the generated password", await promptPassword(password, "new-smoke@example.com"));
    await cancelPrompt();

    // ---- A change form: Use fills the new password and its confirmation, never the current one.
    const change = await open(at("change", "/pwgen-change"));
    await setValue(change.wc, "current", "old-pass-smoke-1");
    await clickField(change.wc, "#new");
    const changeTypes = types();
    key(change.wc, "Down");
    key(change.wc, "Enter");
    await until(() => state()?.generator?.open === true, 2000);
    const changed = generated();
    key(change.wc, "Enter");
    const changeFilled = await until(async () => (await value(change.wc, "new")) === changed && (await value(change.wc, "confirm")) === changed, 4000);
    check(
      "password generator: on a change form, Enter in the generator fills the new password and its confirmation, and the current password stays",
      changeTypes[0] === "suggest" && changeFilled && (await value(change.wc, "current")) === "old-pass-smoke-1",
      { changeTypes, changeFilled },
    );
    // Its current password: no suggestion, no account, only a small Copy password.
    await clickField(change.wc, "#current");
    const compact = types();
    await sleep(300);
    await shot("copy-en");
    clipboard.writeText("");
    await clickAt(menu()!, ".fd-copy");
    const currentCopied = await until(async () => (await clipboard.readText()) === "old-pass-smoke-1", 2000);
    check("password generator: a change form's filled current password offers only Copy password, which copies it", JSON.stringify(compact) === JSON.stringify(["copy"]) && currentCopied, { compact, currentCopied });
    await closed();
    await js(change.wc, `document.querySelector("form").requestSubmit(); true`);
    check("password generator: a sent change form offers to save the new password, not the current one", await promptPassword(changed, ""));
    await cancelPrompt();

    // ---- A field that takes at most 16 letters and digits.
    const limits = await open(at("limits", "/pwgen-limits"));
    await clickField(limits.wc, "#pw");
    await clickAt(menu()!, ".fd-suggest");
    await until(() => state()?.generator?.open === true, 2000);
    const gen = state()?.generator;
    const fitted = Boolean(gen && gen.options.length === 16 && gen.password.length === 16 && !SYMBOL.test(gen.password) && gen.fixed.symbols && gen.notes.some((n) => n.type === "max" && n.length === 16) && gen.notes.some((n) => n.type === "without" && n.option === "symbols"));
    const said = await js<number>(menu(), `document.querySelectorAll(".fd-gen-notes li").length`);
    await sleep(200);
    await shot("generator-limits-en");
    const limited = gen?.password ?? "";
    dropdown()?.onAction({ type: "use", token: state()!.token });
    const limitsFilled = await until(async () => (await value(limits.wc, "pw")) === limited && (await value(limits.wc, "pw2")) === limited, 4000);
    check("password generator: a field's maxlength and pattern cut the length and drop symbols, the generator says so, and Use fills what fits", fitted && said === 2 && limitsFilled, { fitted, said, limitsFilled, notes: gen?.notes });

    // ---- Sign-in forms: a saved login means no suggestion; none means one.
    const knownTab = await open(`${knownSite}/pwgen-signin`);
    await clickField(knownTab.wc, "#p");
    const knownTypes = types();
    const fresh = await open(at("fresh", "/pwgen-signin"));
    await clickField(fresh.wc, "#p");
    const freshTypes = types();
    check(
      "password generator: a sign-in password field lists its saved login and no suggestion, and suggests one when there is no login to offer",
      knownTypes.includes("account") && !knownTypes.includes("suggest") && JSON.stringify(freshTypes) === JSON.stringify(["suggest", "manage"]),
      { knownTypes, freshTypes },
    );
    key(fresh.wc, "Escape");
    await closed();

    // ---- An agent's tab: nothing.
    const agent = await open(at("agent", "/pwgen-signup"));
    win.markAgent(agent.tab.id);
    const agentToken = state()?.token ?? 0;
    await clickAt(agent.wc, "#pw");
    await sleep(1500);
    check("password generator: never offered in an agent's tab", (state()?.token ?? 0) === agentToken && !state(), { state: state() });

    // ---- In Spanish (dark).
    ctx.settings.update({ appearance: { language: "es" } });
    nativeTheme.themeSource = "dark";
    const es = await open(at("signup-es", "/pwgen-signup"));
    await clickField(es.wc, "#pw");
    await sleep(300);
    const esRow = await js<string>(menu(), `document.querySelector(".fd-suggest .af-user")?.textContent ?? ""`);
    await shot("suggest-es");
    await clickAt(menu()!, ".fd-suggest");
    await until(() => state()?.generator?.open === true, 2000);
    await sleep(300);
    const esUse = await js<string>(menu(), `document.querySelector(".fd-gen-use")?.textContent ?? ""`);
    await shot("generator-es");
    dropdown()?.onAction({ type: "use", token: state()!.token });
    await until(async () => Boolean(await value(es.wc, "pw2")), 3000);
    await shot("signup-filled-es");
    await clickField(es.wc, "#pw");
    await sleep(300);
    await shot("copy-es");
    key(es.wc, "Escape");
    await closed();
    const esLimits = await open(at("limits-es", "/pwgen-limits"));
    await clickField(esLimits.wc, "#pw");
    await clickAt(menu()!, ".fd-suggest");
    await until(() => state()?.generator?.open === true, 2000);
    await sleep(300);
    const esNote = await js<string>(menu(), `document.querySelector(".fd-gen-notes li")?.textContent ?? ""`);
    await shot("generator-limits-es");
    key(esLimits.wc, "Escape");
    await closed();
    check(
      "password generator: in Spanish",
      esRow === "Sugerir una contraseña segura" && esUse === "Usar contraseña" && esNote === "Este sitio admite como máximo 16 caracteres.",
      { esRow, esUse, esNote },
    );
  } finally {
    nativeTheme.themeSource = "system";
    ctx.settings.update({ appearance: { language: languageBefore }, passwords: before });
    win.profile.credentials.remove(known.id);
    for (const tab of tabs) if (win.getTab(tab.id)) win.closeTab(tab.id);
  }
}
