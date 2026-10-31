import type http from "node:http";
import { nativeTheme, type WebContents } from "electron";
import type { FieldDropdownState } from "../shared/credentials-ipc";
import { dropdownEntries } from "../shared/field-dropdown";
import type { AppContext } from "./context";
import { AUTOFILL_WORLD_ID, fillLoginByRefScript, type FillOutcome } from "./credential-scripts";
import { windowShot } from "./smoke-cert-errors";
import { clickAt, js, key, sleep, until } from "./smoke-pwgen";
import type { BrowserWindowCtl, TabRuntime } from "./window";

interface Helpers {
  /** The smoke server; its pages are also served for every host under corvus-smoke.test. */
  url: string;
  win: BrowserWindowCtl;
  check: (name: string, ok: boolean, detail?: unknown) => void;
}

const page = (title: string, body: string): string => `<!doctype html><html><head><title>${title}</title>
<style>body{font:14px sans-serif;margin:32px} .field{display:flex;flex-direction:column;gap:4px;margin:0 0 14px;max-width:320px} .hidden{display:none}</style></head><body>
<main><h1>${title}</h1>${body}</main>
<script>window.__events = []; document.addEventListener("input", (e) => __events.push("input:" + e.target.id), true); document.addEventListener("change", (e) => __events.push("change:" + e.target.id), true);</script>
</body></html>`;

/**
 * The first step of a two-page sign-in, built like login.ionos.es's: only the e-mail (autocomplete
 * "username", autofocus), "Next", and a hidden decoy password field at the end of the form.
 */
const STEP1_PAGE = page(
  "Sign in",
  `<form method="POST" action="/idf-step2" novalidate>
<div class="field"><label for="username">E-mail</label><input type="email" name="identifier" id="username" required autofocus autocomplete="username"></div>
<button type="submit">Next</button>
<input type="password" class="hidden" name="hiddenPassword" tabindex="-1">
</form>`,
);
/** Its second step: the password alone. */
const STEP2_PAGE = page(
  "Enter your password",
  `<form onsubmit="event.preventDefault(); document.body.dataset.sent = '1'">
<div class="field"><label for="password">Password</label><input type="password" id="password" name="password" autocomplete="current-password"></div>
<button type="submit">Sign in</button></form>`,
);
/** Both steps in one page, the password step swapped in without a new address. */
const SPA_PAGE = page(
  "Account",
  `<div id="app"><form onsubmit="event.preventDefault(); next()">
<div class="field"><label for="email">Email</label><input type="email" id="email" name="email" autocomplete="username"></div>
<button type="submit">Continue</button></form></div>
<script>function next() { document.getElementById("app").innerHTML = '<form onsubmit="event.preventDefault(); document.body.dataset.sent = 1"><div class="field"><label for="pw">Password</label><input type="password" id="pw" name="pw" autocomplete="current-password"></div><button type="submit">Sign in</button></form>'; }</script>`,
);
/** A first step with no form and no password field at all (as Google's or Microsoft's). */
const NO_FORM_PAGE = page(
  "Sign in to continue",
  `<div class="card"><div class="field"><label for="identifierId">Email or phone</label><input type="email" id="identifierId" name="identifier" autocomplete="username"></div><div><button type="button">Next</button></div></div>`,
);
/** A newsletter and a search on a site with saved logins: neither offers them. */
const NEWS_PAGE = page(
  "News",
  `<form onsubmit="event.preventDefault()"><div class="field"><label for="news">Get our newsletter</label><input type="email" id="news" name="email" autocomplete="email" placeholder="Your e-mail"></div><button type="submit">Subscribe</button></form>
<form role="search" onsubmit="event.preventDefault()"><input type="search" id="q" name="q" aria-label="Search"><button type="submit">Search</button></form>`,
);

const PAGES: Record<string, string> = { "/idf-step1": STEP1_PAGE, "/idf-step2": STEP2_PAGE, "/idf-spa": SPA_PAGE, "/idf-noform": NO_FORM_PAGE, "/idf-news": NEWS_PAGE };

/** The pages of the two-step sign-in smoke, served by the shared smoke server (any method). */
export function serveIdentifierFirstSmokeRoute(req: http.IncomingMessage, res: http.ServerResponse): boolean {
  const html = PAGES[(req.url ?? "/").split("?")[0] ?? "/"];
  if (!html) return false;
  req.resume();
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
  return true;
}

/**
 * Two-step ("identifier first") sign-ins (CORVUS_SMOKE_ONLY=idfirst runs only this): a first step that
 * shows only the e-mail (a hidden decoy password field or no password field at all, a form or none, a
 * new page or the same page for the password) offers the site's saved accounts in the dropdown under
 * the field and in the key panel, and a pick fills the username alone (the decoy stays empty, "Next" is
 * not pressed); the password step then offers that account first, also when the person typed the
 * username, and the save prompt names the username sent from the first step. A newsletter or search
 * field on the same site stays quiet, and an agent's fill on the first step fills the username only.
 * Screenshots in English and Spanish.
 */
export async function runIdentifierFirstSmoke(ctx: AppContext, { url, win, check }: Helpers): Promise<void> {
  const port = new URL(url).port;
  const at = (sub: string, path: string): string => `http://${sub}.idf.corvus-smoke.test:${port}${path}`;
  const site = at("login", "");
  const vault = win.profile.credentials;
  const first = vault.add({ origin: site, username: "first-idf@example.com", password: "idf-pass-1" });
  const second = vault.add({ origin: site, username: "second-idf@example.com", password: "idf-pass-2" });
  const { language: languageBefore } = ctx.settings.get().appearance;
  const dropdown = () => ctx.autofill.fieldDropdown(win);
  const state = (): FieldDropdownState | null => dropdown()?.state() ?? null;
  const accounts = (): string[] => {
    const s = state();
    return s ? dropdownEntries(s).flatMap((e) => (e.type === "account" ? [e.account.username] : [])) : [];
  };
  const opened = (token: number): Promise<boolean> => until(() => (state()?.token ?? 0) > token && Boolean(dropdown()?.bounds()), 5000);
  const tabs: TabRuntime[] = [];
  const loaded = (tab: TabRuntime, path: string): Promise<boolean> => until(() => !tab.view.webContents.isDestroyed() && tab.view.webContents.getURL().includes(path) && !tab.loading);
  const open = async (target: string): Promise<{ tab: TabRuntime; wc: WebContents }> => {
    const tab = win.createTab(target);
    tabs.push(tab);
    await loaded(tab, new URL(target).pathname);
    await sleep(400);
    return { tab, wc: tab.view.webContents };
  };
  const clickField = async (wc: WebContents, selector: string): Promise<boolean> => {
    const token = state()?.token ?? 0;
    await clickAt(wc, selector);
    return opened(token);
  };
  const pick = (username: string): boolean => {
    const s = state();
    const index = s ? dropdownEntries(s).findIndex((e) => e.type === "account" && e.account.username === username) : -1;
    if (!s || index < 0) return false;
    dropdown()?.onAction({ type: "activate", token: s.token, index });
    return true;
  };
  const value = (wc: WebContents, selector: string): Promise<string | null> => js<string>(wc, `document.querySelector(${JSON.stringify(selector)}).value`);
  const decoy = (wc: WebContents): Promise<string | null> => value(wc, "input[name=hiddenPassword]");
  const enter = (wc: WebContents): void => {
    for (const type of ["keyDown", "char", "keyUp"] as const) wc.sendInputEvent({ type, keyCode: type === "char" ? "\r" : "Enter" });
  };
  const chromeJs = <T>(expr: string): Promise<T | null> => js<T>(win.chrome.webContents, expr);
  const shot = (name: string): Promise<void> => windowShot(win, name, "idfirst");

  try {
    // ---- The first step: the accounts under the e-mail field and in the key panel; a pick fills the e-mail only.
    const one = await open(at("login", "/idf-step1"));
    const offered = await until(() => ctx.autofill.stateFor(win).matchCount === 2, 5000);
    const shown = await clickField(one.wc, "#username");
    const listed = accounts();
    const keyboard = one.wc.isFocused() && (await js<boolean>(one.wc, `document.activeElement === document.getElementById("username")`)) === true;
    check(
      "two-step sign-in: the first step (only the e-mail, a hidden decoy password field) offers the site's saved accounts under the field and in the key button, and the field keeps the keyboard",
      offered && shown && listed.length === 2 && listed.includes(first.username) && keyboard,
      { offered, shown, listed, keyboard, state: ctx.autofill.stateFor(win) },
    );
    await shot("step1-en");
    pick(second.username);
    const filled = await until(async () => (await value(one.wc, "#username")) === second.username, 4000);
    await sleep(800);
    const events = (await js<string[]>(one.wc, "window.__events")) ?? [];
    check(
      "two-step sign-in: a pick fills the e-mail only (input and change fired), the hidden decoy password stays empty, and Next is not pressed",
      filled && (await decoy(one.wc)) === "" && one.wc.getURL().endsWith("/idf-step1") && events.includes("input:username") && events.includes("change:username"),
      { filled, decoy: await decoy(one.wc), url: one.wc.getURL(), events },
    );

    // ---- The password step offers the picked account first and fills its password.
    await clickAt(one.wc, "button[type=submit]");
    const two = await loaded(one.tab, "/idf-step2");
    await sleep(400);
    await clickField(one.wc, "#password");
    const onStep2 = accounts();
    await shot("step2-en");
    pick(onStep2[0] ?? "");
    const passwordFilled = await until(async () => (await value(one.wc, "#password")) === "idf-pass-2", 4000);
    check("two-step sign-in: the password step offers the account picked on the first step first, and fills its password", two && onStep2[0] === second.username && passwordFilled, { two, onStep2, passwordFilled });

    // ---- A typed e-mail: the password step offers its account first, and the save prompt names it.
    const typed = await open(at("login", "/idf-step1"));
    await clickAt(typed.wc, "#username");
    await sleep(200);
    await typed.wc.insertText(first.username);
    enter(typed.wc);
    await loaded(typed.tab, "/idf-step2");
    await sleep(400);
    await clickField(typed.wc, "#password");
    const typedOrder = accounts();
    await typed.wc.insertText("idf-typed-pass-3");
    await until(() => !state(), 2000);
    await js(typed.wc, `document.querySelector("form").requestSubmit(); true`);
    const prompt = await until(async () => (await chromeJs<string>(`document.querySelector(".af-save input[name=username]")?.value ?? ""`)) === first.username, 6000);
    check(
      "two-step sign-in: an e-mail typed on the first step comes first on the password step, and the save prompt names it (the password step has no username field)",
      typedOrder[0] === first.username && prompt,
      { typedOrder, prompt, username: await chromeJs<string>(`document.querySelector(".af-save input[name=username]")?.value ?? ""`) },
    );
    await chromeJs(`document.querySelector(".af-save .af-cancel")?.click(); true`);
    await until(async () => (await chromeJs<boolean>(`!document.querySelector(".af-save")`)) === true, 3000);

    // ---- Both steps in one page: the password step is swapped in without a new address.
    const spa = await open(at("app", "/idf-spa"));
    await clickField(spa.wc, "#email");
    const spaListed = accounts();
    pick(first.username);
    await until(async () => (await value(spa.wc, "#email")) === first.username, 4000);
    await js(spa.wc, `document.querySelector("form").requestSubmit(); true`);
    await until(async () => (await js<boolean>(spa.wc, `Boolean(document.getElementById("pw"))`)) === true, 3000);
    await clickField(spa.wc, "#pw");
    const spaOrder = accounts();
    pick(spaOrder[0] ?? "");
    const spaFilled = await until(async () => (await js<string>(spa.wc, `document.getElementById("pw")?.value ?? ""`)) === "idf-pass-1", 4000);
    check(
      "two-step sign-in: on a page that swaps the password step in place, the first step offers the accounts and the password step the picked one first",
      spaListed.length === 2 && spaOrder[0] === first.username && spaFilled && spa.wc.getURL().endsWith("/idf-spa"),
      { spaListed, spaOrder, spaFilled },
    );

    // ---- No form and no password field at all.
    const bare = await open(at("id", "/idf-noform"));
    const bareShown = await clickField(bare.wc, "#identifierId");
    pick(first.username);
    const bareFilled = await until(async () => (await value(bare.wc, "#identifierId")) === first.username, 4000);
    check("two-step sign-in: a first step without a form or any password field offers the accounts and fills the e-mail", bareShown && bareFilled, { bareShown, bareFilled });

    // ---- The key panel on the first step fills the e-mail only too.
    const panel = await open(at("login", "/idf-step1"));
    await until(() => ctx.autofill.stateFor(win).matchCount === 2, 5000);
    await chromeJs(`document.querySelector(".omni-autofill")?.click(); true`);
    await until(async () => ((await chromeJs<number>(`document.querySelectorAll(".omni-autofill-panel .af-row").length`)) ?? 0) > 0, 5000);
    await chromeJs(`document.querySelector(".omni-autofill-panel .af-row .af-fill").dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true })); true`);
    const panelFilled = await until(async () => [first.username, second.username].includes((await value(panel.wc, "#username")) ?? ""), 4000);
    await sleep(500);
    check("two-step sign-in: the key panel's pick on the first step fills the e-mail only and leaves the decoy empty", panelFilled && (await decoy(panel.wc)) === "" && panel.wc.getURL().endsWith("/idf-step1"), { panelFilled, decoy: await decoy(panel.wc) });

    // ---- An agent's fill on the first step: the username only; the decoy is never a password field to fill.
    const agentRun = (wc: WebContents, ref: string | null): Promise<FillOutcome | null> =>
      (wc.executeJavaScriptInIsolatedWorld(AUTOFILL_WORLD_ID, [{ code: fillLoginByRefScript(ref, "agent-idf@example.com", "agent-idf-secret") }]) as Promise<FillOutcome>).catch(() => null);
    const agentPage = await open(at("login", "/idf-step1"));
    const byForm = await agentRun(agentPage.wc, null);
    await js(agentPage.wc, `document.querySelector("input[name=hiddenPassword]").setAttribute("data-corvus-ref", "e9"); true`);
    const byDecoy = await agentRun(agentPage.wc, "e9");
    check(
      "two-step sign-in: an agent's sign-in on the first step fills the username only, and a decoy password field is refused",
      byForm?.ok === true && byForm.user === true && byForm.pass === false && byDecoy?.ok === false && (await value(agentPage.wc, "#username")) === "agent-idf@example.com" && (await decoy(agentPage.wc)) === "",
      { byForm, byDecoy },
    );

    // ---- A newsletter and a search on the same site stay quiet.
    const news = await open(at("news", "/idf-news"));
    const quietToken = state()?.token ?? 0;
    await clickAt(news.wc, "#news");
    await sleep(1200);
    await clickAt(news.wc, "#q");
    await sleep(1200);
    check(
      "two-step sign-in: a newsletter or search field on a site with saved logins offers nothing",
      (state()?.token ?? 0) === quietToken && !ctx.autofill.stateFor(win).available,
      { state: state(), bar: ctx.autofill.stateFor(win) },
    );

    // ---- In Spanish (dark).
    ctx.settings.update({ appearance: { language: "es" } });
    nativeTheme.themeSource = "dark";
    const es = await open(at("login", "/idf-step1"));
    await clickField(es.wc, "#username");
    await sleep(300);
    await shot("step1-es");
    pick(first.username);
    await until(async () => (await value(es.wc, "#username")) === first.username, 4000);
    await clickAt(es.wc, "button[type=submit]");
    await loaded(es.tab, "/idf-step2");
    await sleep(400);
    await clickField(es.wc, "#password");
    await sleep(300);
    await shot("step2-es");
    key(es.wc, "Escape");
  } finally {
    nativeTheme.themeSource = "system";
    ctx.settings.update({ appearance: { language: languageBefore } });
    for (const c of vault.all()) if (c.origin === site) vault.remove(c.id);
    for (const tab of tabs) if (win.getTab(tab.id)) win.closeTab(tab.id);
  }
}
