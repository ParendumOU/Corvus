import type http from "node:http";
import type { WebContents } from "electron";
import type { FieldDropdownState } from "../shared/credentials-ipc";
import { dropdownEntries } from "../shared/field-dropdown";
import type { AppContext } from "./context";
import { windowShot } from "./smoke-cert-errors";
import { clickAt, js, sleep, until } from "./smoke-pwgen";
import type { BrowserWindowCtl, TabRuntime } from "./window";

interface Helpers {
  /** The smoke server; its pages are also served for every host under corvus-smoke.test. */
  url: string;
  win: BrowserWindowCtl;
  check: (name: string, ok: boolean, detail?: unknown) => void;
}

const page = (title: string, body: string): string => `<!doctype html><html><head><title>${title}</title>
<style>body{font:14px sans-serif;margin:32px} .field{display:flex;flex-direction:column;gap:4px;margin:0 0 14px;max-width:320px}</style></head><body>
<main><h1>${title}</h1>${body}</main></body></html>`;

/** A sign-in that asks for the e-mail only and mails a code (no password, ever). */
const SIGNIN_PAGE = page(
  "Sign in",
  `<form method="POST" action="/rem-code">
<div class="field"><label for="email">Email</label><input type="email" id="email" name="email" autocomplete="email" placeholder="Enter your email"></div>
<button type="submit">Continue with email</button></form>`,
);
/** The next page: the code sent by e-mail. */
const CODE_PAGE = page(
  "Check your email",
  `<form onsubmit="event.preventDefault()"><div class="field"><label for="code">Verification code</label><input id="code" name="code" inputmode="numeric" autocomplete="one-time-code"></div><button type="submit">Verify</button></form>`,
);

const PAGES: Record<string, string> = { "/rem-signin": SIGNIN_PAGE, "/rem-code": CODE_PAGE };

/** The pages of the remembered-username smoke, served by the shared smoke server (any method). */
export function serveRememberEmailSmokeRoute(req: http.IncomingMessage, res: http.ServerResponse): boolean {
  const html = PAGES[(req.url ?? "/").split("?")[0] ?? "/"];
  if (!html) return false;
  req.resume();
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
  return true;
}

/**
 * A sign-in without a password (CORVUS_SMOKE_ONLY=rememberemail runs only this): the e-mail sent from
 * a page that asks only for it (then for a code) is remembered for the site, offers itself under the
 * field next time and fills it; a private window remembers nothing; Settings shows it as a username
 * only (no password to show or copy, no auto sign-in) and Delete there forgets it. Screenshots.
 */
export async function runRememberEmailSmoke(ctx: AppContext, { url, win, check }: Helpers): Promise<void> {
  const port = new URL(url).port;
  const site = `http://rem.corvus-smoke.test:${port}`;
  const signin = `${site}/rem-signin`;
  const email = "rem-smoke@example.com";
  const vault = win.profile.credentials;
  const atSite = () => vault.all().filter((c) => c.origin === site);
  const dropdown = () => ctx.autofill.fieldDropdown(win);
  const state = (): FieldDropdownState | null => dropdown()?.state() ?? null;
  const accounts = (): string[] => {
    const s = state();
    return s ? dropdownEntries(s).flatMap((e) => (e.type === "account" ? [e.account.username] : [])) : [];
  };
  const tabs: TabRuntime[] = [];
  const loaded = (tab: TabRuntime, path: string): Promise<boolean> => until(() => !tab.view.webContents.isDestroyed() && tab.view.webContents.getURL().includes(path) && !tab.loading);
  const open = async (w: BrowserWindowCtl, target: string): Promise<{ tab: TabRuntime; wc: WebContents }> => {
    const tab = w.createTab(target, { activate: true });
    if (w === win) tabs.push(tab);
    await loaded(tab, new URL(target).pathname);
    await sleep(400);
    return { tab, wc: tab.view.webContents };
  };
  const typeAndSend = async (w: BrowserWindowCtl, text: string): Promise<{ tab: TabRuntime; wc: WebContents; sent: boolean }> => {
    const one = await open(w, signin);
    await clickAt(one.wc, "#email");
    await sleep(200);
    await one.wc.insertText(text);
    await clickAt(one.wc, "button[type=submit]");
    return { ...one, sent: await loaded(one.tab, "/rem-code") };
  };
  const value = (wc: WebContents): Promise<string | null> => js<string>(wc, `document.getElementById("email")?.value ?? null`);
  let privateWin: BrowserWindowCtl | null = null;
  let passwordsTab: TabRuntime | null = null;

  try {
    for (const c of atSite()) vault.remove(c.id);

    // ---- Sent once: remembered for the site, with no password and no save prompt.
    const first = await typeAndSend(win, email);
    const remembered = await until(() => atSite().length === 1, 4000);
    const saved = atSite()[0];
    await sleep(500);
    check(
      "remembered e-mail: the e-mail sent from a sign-in that asks for no password is kept for the site (username only), and no save prompt opens",
      first.sent && remembered && saved?.username === email && saved.password === "" && !saved.totp && !ctx.autofill.stateFor(win).canSave,
      { sent: first.sent, saved: saved && { username: saved.username, hasPassword: saved.password !== "" }, bar: ctx.autofill.stateFor(win) },
    );

    // ---- Next visit: offered under the field and in the key button; a pick fills it.
    const again = await open(win, signin);
    const offered = await until(() => ctx.autofill.stateFor(win).matchCount === 1, 5000);
    const token = state()?.token ?? 0;
    await clickAt(again.wc, "#email");
    const shown = await until(() => (state()?.token ?? 0) > token && Boolean(dropdown()?.bounds()), 5000);
    const listed = accounts();
    await windowShot(win, "offered-en", "rememberemail");
    const s = state();
    const index = s ? dropdownEntries(s).findIndex((e) => e.type === "account" && e.account.username === email) : -1;
    if (s && index >= 0) dropdown()?.onAction({ type: "activate", token: s.token, index });
    const filled = await until(async () => (await value(again.wc)) === email, 4000);
    await sleep(300);
    check(
      "remembered e-mail: the next visit offers it under the e-mail field and in the key button, and a pick fills it (the page stays on its first step)",
      offered && shown && JSON.stringify(listed) === JSON.stringify([email]) && filled && again.wc.getURL().endsWith("/rem-signin"),
      { offered, shown, listed, filled, url: again.wc.getURL() },
    );

    // ---- Sent again (picked, or retyped in another case): still one entry.
    await clickAt(again.wc, "button[type=submit]");
    await loaded(again.tab, "/rem-code");
    await typeAndSend(win, "REM-smoke@example.com");
    await sleep(500);
    check("remembered e-mail: sending it again, in any case, keeps one entry", atSite().length === 1, { usernames: atSite().map((c) => c.username) });

    // ---- A private window remembers nothing.
    privateWin = ctx.windows.openPrivate(win.profile.profile.id, []);
    const priv = await typeAndSend(privateWin, "rem-private@example.com");
    await sleep(800);
    check(
      "remembered e-mail: an e-mail sent from a private window is never kept",
      priv.sent && !vault.all().some((c) => c.username === "rem-private@example.com") && atSite().length === 1,
      { sent: priv.sent, usernames: atSite().map((c) => c.username) },
    );
    privateWin.close();
    await until(() => !ctx.windows.all().includes(privateWin!), 5000);
    privateWin = null;

    // ---- Settings: a "Username only" row with no password to show or copy, then Delete forgets it.
    const id = atSite()[0]?.id ?? "";
    passwordsTab = win.createTab("corvus://passwords/#passwords", { activate: true });
    const wc = passwordsTab.view.webContents;
    const row = `.pw-list .pt-row[data-id=${JSON.stringify(id)}]`;
    const truthy = async (expr: string): Promise<boolean> => (await js<boolean>(wc, `Boolean(${expr})`)) === true;
    const click = (selector: string): Promise<unknown> => js(wc, `document.querySelector(${JSON.stringify(selector)})?.click(); true`);
    await until(() => truthy(`document.querySelector(${JSON.stringify(row)})`), 15_000);
    await js(wc, `document.querySelector(${JSON.stringify(row)})?.scrollIntoView({ block: "center" }); true`);
    const chip = await js<string>(wc, `document.querySelector(${JSON.stringify(`${row} .pt-status`)})?.innerText ?? ""`);
    const noSecrets = await truthy(`document.querySelector(${JSON.stringify(`${row} .pt-reveal`)}).disabled && document.querySelector(${JSON.stringify(`${row} .pt-copy-password`)}).disabled && !document.querySelector(${JSON.stringify(`${row} .pt-option .toggle`)})`);
    await sleep(500);
    await windowShot(win, "settings-en", "rememberemail");
    check("remembered e-mail: Settings lists it as a username only, with no password to show or copy and no auto sign-in", /Username only/.test(chip ?? "") && noSecrets, { chip, noSecrets });

    await click(`${row} .pt-delete`);
    await until(() => truthy(`document.querySelector(".modal-card .dl-next")`), 3000);
    await click(".modal-card .dl-next");
    await until(() => truthy(`document.querySelector(".modal-card .dl-confirm") && !document.querySelector(".modal-card .dl-confirm").disabled`), 5000);
    await click(".modal-card .dl-confirm");
    const deleted = await until(async () => atSite().length === 0 && (await truthy(`!document.querySelector(${JSON.stringify(row)})`)), 5000);
    win.closeTab(passwordsTab.id);
    passwordsTab = null;
    const after = await open(win, signin);
    await sleep(800);
    const quiet = ctx.autofill.stateFor(win).matchCount === 0 && (await value(after.wc)) === "";
    check("remembered e-mail: Delete in Settings forgets it, and the sign-in page offers nothing again", deleted && quiet, { deleted, quiet, bar: ctx.autofill.stateFor(win) });
  } finally {
    if (privateWin) privateWin.close();
    if (passwordsTab && win.getTab(passwordsTab.id)) win.closeTab(passwordsTab.id);
    for (const c of atSite()) vault.remove(c.id);
    for (const tab of tabs) if (win.getTab(tab.id)) win.closeTab(tab.id);
  }
}
