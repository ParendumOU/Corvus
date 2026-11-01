import type { WebContents } from "electron";
import { dropdownEntries } from "../shared/field-dropdown";
import { base32Encode, totpCode, type TotpConfig } from "../shared/totp";
import type { SimilarLoginRequest } from "./autofill-service";
import type { AppContext } from "./context";
import type { BrowserWindowCtl } from "./window";

interface Helpers {
  /** The smoke server; corvus-smoke.test and corvus-smoke.example both reach it. */
  url: string;
  win: BrowserWindowCtl;
  check: (name: string, ok: boolean, detail?: unknown) => void;
  capture: (name: string, wc: WebContents) => Promise<void>;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function until(cond: () => boolean | Promise<boolean>, timeoutMs = 8000): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await cond()) return true;
    await sleep(120);
  }
  return cond();
}

const js = <T>(wc: WebContents, expr: string): Promise<T | null> => (wc.isDestroyed() ? Promise.resolve(null) : (wc.executeJavaScript(expr, true) as Promise<T>).catch(() => null));

/**
 * Logins of a similar site: a login saved for corvus-smoke.test, on the same page served as
 * corvus-smoke.example. The login field's dropdown lists it only in its own folded section; picking it
 * asks first and fills the login, and nothing is saved; under the code field, picking its code (after
 * the same question) fills it and saves a copy of the login for corvus-smoke.example with the same
 * 2FA, which the page then offers as its own. A declined question fills nothing. Screenshot of the
 * dropdown with the section open.
 */
export async function runSimilarLoginsSmoke(ctx: AppContext, { url, win, check, capture }: Helpers): Promise<void> {
  const port = new URL(url).port;
  const saved = `http://corvus-smoke.test:${port}`;
  const here = `http://corvus-smoke.example:${port}`;
  const vault = win.profile.credentials;
  const totp: TotpConfig = { secret: base32Encode(Uint8Array.from({ length: 20 }, (_, i) => (i * 53 + 7) & 0xff)), algorithm: "SHA1", digits: 6, period: 30 };
  const login = vault.add({ origin: saved, username: "similar-smoke", password: "pw-similar-smoke", totp });
  const asked: SimilarLoginRequest[] = [];
  let answer = false;
  ctx.autofill.setSimilarApprover(async (_win, req) => {
    asked.push(req);
    return answer;
  });
  const state = () => ctx.autofill.fieldDropdown(win)?.state() ?? null;
  const tab = win.createTab(`${here}/otp-one-form`);
  const wc = tab.view.webContents;
  const fields = (): Promise<{ u: string; p: string; code: string } | null> =>
    js(wc, `({ u: document.getElementById("u").value, p: document.getElementById("p").value, code: document.getElementById("code").value })`);
  const clear = (): Promise<unknown> => js(wc, `["u", "p", "code"].forEach((id) => { document.getElementById(id).value = ""; }); true`);
  const clickField = async (selector: string): Promise<boolean> => {
    const before = state()?.token ?? 0;
    const box = await js<{ x: number; y: number }>(wc, `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
    if (!box) return false;
    wc.focus();
    wc.sendInputEvent({ type: "mouseDown", x: box.x, y: box.y, button: "left", clickCount: 1 });
    wc.sendInputEvent({ type: "mouseUp", x: box.x, y: box.y, button: "left", clickCount: 1 });
    return until(() => (state()?.token ?? 0) > before && Boolean(ctx.autofill.fieldDropdown(win)?.bounds()));
  };
  /** Presses an entry of the open dropdown, as a click on it does. */
  const press = (find: (e: ReturnType<typeof dropdownEntries>[number]) => boolean): boolean => {
    const s = state();
    const index = s ? dropdownEntries(s).findIndex(find) : -1;
    if (!s || index < 0) return false;
    ctx.autofill.fieldDropdown(win)?.onAction({ type: "activate", token: s.token, index });
    return true;
  };
  const similarAccount = (e: ReturnType<typeof dropdownEntries>[number]): boolean => e.type === "account" && e.account.fit === "similar";
  try {
    await until(() => !wc.isDestroyed() && wc.getURL().includes("/otp-one-form") && !tab.loading);
    await until(() => ctx.autofill.stateFor(win).matchCount === 0);

    await clickField("#u");
    const folded = state();
    check(
      "similar sites: the login field's dropdown offers corvus-smoke.test's login only in a folded section of its own",
      folded?.first.length === 0 && folded.others.length === 0 && folded.similar.length === 1 && folded.similarSites === "corvus-smoke.test" && !folded.similarOpen && !dropdownEntries(folded).some(similarAccount),
      folded && { first: folded.first.length, similar: folded.similar.map((m) => [m.username, m.site, m.fit]), sites: folded.similarSites },
    );
    press((e) => e.type === "similar");
    await until(() => state()?.similarOpen === true);
    await sleep(300);
    const menu = ctx.autofill.fieldDropdown(win)?.webContents;
    if (menu) await capture("similar-logins-dropdown", menu);

    press(similarAccount);
    await sleep(800);
    check("similar sites: a declined question fills nothing", asked.length === 1 && !asked[0]!.saveCopy && (await fields())?.p === "", { asked, fields: await fields() });

    answer = true;
    await clickField("#u");
    press((e) => e.type === "similar");
    press(similarAccount);
    const filled = await until(async () => (await fields())?.p === "pw-similar-smoke");
    check(
      "similar sites: confirmed, its login is filled and nothing is saved for the site",
      filled && asked.length === 2 && asked[1]!.host === "corvus-smoke.example" && asked[1]!.site.startsWith("corvus-smoke.test") && !vault.findByLogin(here, "similar-smoke"),
      { asked: asked[1], fields: await fields() },
    );

    await clear();
    await clickField("#code");
    press((e) => e.type === "similar");
    press(similarAccount);
    const codes = await Promise.all([-30_000, 0, 30_000].map(async (offset) => (await totpCode(totp, Date.now() + offset)).code));
    const coded = await until(async () => codes.includes((await fields())?.code ?? ""));
    const copy = vault.findByLogin(here, "similar-smoke");
    check(
      "similar sites: its 2FA code is filled and the login is saved for the site with the same 2FA",
      coded && asked.length === 3 && asked[2]!.saveCopy && copy?.password === "pw-similar-smoke" && copy.totp?.secret === totp.secret && vault.get(login.id)?.origin === saved,
      { saveCopy: asked[2]?.saveCopy, copy: copy && { origin: copy.origin, totp: Boolean(copy.totp) } },
    );

    await clickField("#u");
    const own = state();
    check("similar sites: the copy is then the site's own account", own?.first.length === 1 && own.first[0]?.fit === "exact" && own.first[0].hasTotp && own.similar.length === 0, own && { first: own.first, similar: own.similar.length });
  } finally {
    ctx.autofill.setSimilarApprover(null);
    ctx.autofill.fieldDropdown(win)?.close();
    for (const c of vault.all()) if (c.username === "similar-smoke") vault.remove(c.id);
    win.closeTab(tab.id);
  }
}
