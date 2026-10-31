import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { WebContents } from "electron";
import type { AppContext } from "./context";
import { writeBrowserFixtures } from "./smoke-import-fixtures";
import { FIXTURE_PASSWORDS, FIXTURE_SECRETS } from "./smoke-password-fixtures";
import type { BrowserWindowCtl } from "./window";

interface PasswordImportSmokeHelpers {
  win: BrowserWindowCtl;
  check: (name: string, ok: boolean, detail?: unknown) => void;
  capture: (name: string, wc: WebContents) => Promise<void>;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function until(fn: () => Promise<boolean> | boolean, timeoutMs = 15_000): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await fn()) return true;
    await sleep(150);
  }
  return false;
}

const js = <T>(wc: WebContents, code: string): Promise<T> => wc.executeJavaScript(code) as Promise<T>;
/** Waits until the page painted what the last script changed (open details, scrolling). */
const painted = async (wc: WebContents): Promise<void> => {
  await js(wc, "new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))");
  await sleep(250);
};
const ROW = (source: string, profile: string): string => `[data-import-source="${source}"] [data-import-profile="${profile}"]`;

/** The password export the stub "browser" saves: a login it protected, and an undated change. */
const EXPORT_CSV = ["name,url,username,password,note", "bank.example.com,https://bank.example.com/,ana@example.com,fixture-bank-pw,", "shop.example.org,https://shop.example.org/login,bob,fixture-shop-changed,"].join("\n");
const SECRETS = [...FIXTURE_SECRETS, "fixture-bank-pw", "fixture-shop-changed"];

/**
 * Passwords from other browsers, end to end in Settings > Import (the Welcome page shows the same
 * panel): the Passwords row with its count and note, the Import click reading the fixture Chrome
 * (Linux "v10" values) and Firefox (key4.db) profiles into the vault, the result with its reasons,
 * re-importing adding nothing, the guided export for protected passwords (a stub stands in for the
 * browser; no real browser ever starts), the review's Update, Spanish, and no secret in any log.
 */
export async function runPasswordImportSmoke(ctx: AppContext, h: PasswordImportSmokeHelpers): Promise<void> {
  const { win, check, capture } = h;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "corvus-pwimport-smoke-"));
  const downloads = fs.mkdtempSync(path.join(os.tmpdir(), "corvus-pwimport-downloads-"));
  const vault = win.profile.credentials;
  const before = new Set(vault.all().map((c) => c.id));
  const language = ctx.settings.get().appearance.language;
  const logged: string[] = [];
  const methods = ["log", "info", "warn", "error", "debug"] as const;
  const originals = methods.map((m) => console[m]);
  methods.forEach((m, i) => {
    console[m] = (...args: unknown[]) => {
      logged.push(args.map((a) => (a instanceof Error ? `${a.message}\n${a.stack ?? ""}` : typeof a === "string" ? a : JSON.stringify(a))).join(" "));
      originals[i]!.apply(console, args);
    };
  });
  let tabId: string | null = null;
  try {
    ctx.browserImport.setTestRoots(writeBrowserFixtures(root));
    ctx.browserImport.setTestKeyProviders({});
    const opened: string[] = [];
    ctx.passwordExports.setTest((id) => {
      opened.push(id);
      setTimeout(() => fs.writeFileSync(path.join(downloads, "Chrome Passwords.csv"), EXPORT_CSV), 400);
      return true;
    }, downloads);
    ctx.settings.update({ appearance: { language: "en" } });
    const tab = win.createTab("corvus://settings/#import");
    tabId = tab.id;
    const wc = tab.view.webContents;
    const chrome = ROW("chrome", "Default");
    const rowsReady = await until(() => js<boolean>(wc, `Boolean(document.querySelector('${chrome} [data-import-kind="passwords"] input')?.checked && document.querySelector('${chrome} [data-import-guided]'))`));
    const rowText = await js<string>(wc, `document.querySelector('${chrome}')?.innerText ?? ''`);
    await js(wc, `document.querySelector('${chrome}').scrollIntoView({ block: "start" }); true`);
    await painted(wc);
    await capture("pwimport-rows-en", wc);
    check(
      "password import: each browser profile shows Passwords with its count (rows, nothing decrypted), ticked, the note on what happens, and the guided export for the protected ones",
      rowsReady &&
        rowText.includes("5 saved passwords") &&
        rowText.includes("Corvus reads the passwords saved in Google Chrome on this computer once, now, into its encrypted vault.") &&
        rowText.includes("Google Chrome protects 1 saved password"),
      rowText.slice(0, 600),
    );

    // Import only the passwords of the Chrome profile.
    const importOnly = async (row: string): Promise<void> => {
      await js(wc, `(() => { for (const label of document.querySelectorAll('${row} [data-import-kind]')) { const input = label.querySelector('input'); if (input.checked !== (label.dataset.importKind === "passwords")) input.click(); } return true; })()`);
      await sleep(100);
      await js(wc, `document.querySelector('${row} [data-import-run]').click(); true`);
    };
    const counts = (row: string): Promise<string> => js<string>(wc, `document.querySelector('${row} [data-import-password-counts]')?.innerText ?? ''`);
    await importOnly(chrome);
    const first = (await until(async () => (await counts(chrome)).startsWith("Passwords:"))) ? await counts(chrome) : "";
    const { chromeMail, chromeShop, chromeAccount, firefoxForum } = FIXTURE_PASSWORDS;
    const inVault = [chromeMail, chromeShop, chromeAccount].every((l) => vault.findByLogin(l.origin, l.username)?.password === l.password);
    await js(wc, `for (const d of document.querySelectorAll('${chrome} [data-import-reasons]')) d.open = true; document.querySelector('${chrome} [data-import-password-result]').scrollIntoView({ block: "center" }); true`);
    const reasons = await js<string[]>(wc, `[...document.querySelectorAll('${chrome} [data-import-reason]')].map((r) => r.dataset.importReason + ": " + r.innerText.replace(/\\s+/g, " "))`);
    await painted(wc);
    await capture("pwimport-result-en", wc);
    check(
      "password import: the Import click brings the readable logins into the vault and says what happened, with reasons by site and username",
      first === "Passwords: 3 new, 2 protected by the browser, 3 skipped. Google Chrome still keeps its own copy of these passwords." &&
        inVault &&
        reasons.some((r) => r.startsWith("app-bound:") && r.includes("bank.example.com · ana@example.com")) &&
        reasons.some((r) => r.startsWith("keyring:") && r.includes("keyring.example.com")) &&
        ["android", "never-save", "federated"].every((reason) => reasons.some((r) => r.startsWith(`${reason}:`))),
      { first, inVault, reasons },
    );

    // Pressing Import again adds and changes nothing.
    const snapshot = JSON.stringify(vault.all());
    await js(wc, `document.querySelector('${chrome} [data-import-run]').click(); true`);
    const second = (await until(async () => (await counts(chrome)).includes("already saved"))) ? await counts(chrome) : "";
    check("password import: re-importing adds nothing and changes nothing", second.startsWith("Passwords: 3 already saved, 2 protected by the browser, 3 skipped.") && JSON.stringify(vault.all()) === snapshot, second);

    // Protected passwords through the browser's own export, from the same panel.
    const guided = `${chrome} [data-import-guided]`;
    await js(wc, `document.querySelector('${guided} [data-import-export]').click(); true`);
    const waiting = await until(() => js<boolean>(wc, `Boolean(document.querySelector('${guided} [data-import-export-waiting]'))`), 5000);
    const exported = await until(() => js<boolean>(wc, `Boolean(document.querySelector('${guided} [data-import-password-counts]'))`), 20_000);
    const guidedCounts = await counts(guided);
    const csvGone = !fs.existsSync(path.join(downloads, "Chrome Passwords.csv"));
    await js(wc, `document.querySelector('${guided}').scrollIntoView({ block: "center" }); true`);
    await painted(wc);
    await capture("pwimport-guided-en", wc);
    check(
      "password import: the guided export opens the browser's page (stubbed), waits for the CSV in Downloads, imports it through the same rules and deletes it",
      opened.join() === "chrome" && waiting && exported && guidedCounts.startsWith("Passwords: 1 new, 1 to review.") && vault.findByLogin("https://bank.example.com", "ana@example.com")?.password === "fixture-bank-pw" && csvGone && vault.findByLogin(chromeShop.origin, chromeShop.username)?.password === chromeShop.password,
      { opened, waiting, exported, guidedCounts, csvGone },
    );
    await js(wc, `document.querySelector('${guided} [data-import-review-row] button').click(); true`);
    const reviewed = await until(() => vault.findByLogin(chromeShop.origin, chromeShop.username)?.password === "fixture-shop-changed", 5000);
    check("password import: Update applies a reviewed change (the old password goes to the login's history)", reviewed && (vault.findByLogin(chromeShop.origin, chromeShop.username)?.passwordHistory?.length ?? 0) > 0, reviewed);

    // Firefox's logins (key4.db with no primary password) through the same merge.
    const firefox = ROW("firefox", "abcd1234.default-release");
    await importOnly(firefox);
    const fox = (await until(async () => (await counts(firefox)).startsWith("Passwords:"))) ? await counts(firefox) : "";
    check(
      "password import: Firefox's saved logins come in from key4.db, the ones Corvus has counted as already saved",
      fox.startsWith("Passwords: 1 new, 1 already saved, 1 skipped.") && vault.findByLogin(firefoxForum.origin, firefoxForum.username)?.password === firefoxForum.password,
      fox,
    );

    // Spanish.
    ctx.settings.update({ appearance: { language: "es" } });
    wc.reload();
    const esReady = await until(() => js<boolean>(wc, `document.documentElement.lang === "es" && Boolean(document.querySelector('${chrome} [data-import-kind="passwords"] input'))`));
    await js(wc, `document.querySelector('${chrome}').scrollIntoView({ block: "start" }); true`);
    await painted(wc);
    await capture("pwimport-rows-es", wc);
    const esRow = await js<string>(wc, `document.querySelector('${chrome}')?.innerText ?? ''`);
    await importOnly(chrome);
    const esCounts = (await until(async () => (await counts(chrome)).startsWith("Contraseñas:"))) ? await counts(chrome) : "";
    await js(wc, `for (const d of document.querySelectorAll('${chrome} [data-import-reasons]')) d.open = true; document.querySelector('${chrome} [data-import-password-result]').scrollIntoView({ block: "center" }); true`);
    await painted(wc);
    await capture("pwimport-result-es", wc);
    check(
      "password import: the rows, the note and the result read in Spanish",
      esReady && esRow.includes("5 contraseñas guardadas") && esRow.includes("Corvus lee una sola vez, ahora,") && esCounts.startsWith("Contraseñas: 2 ya guardadas, 1 más antiguas sin tocar, 2 protegidas por el navegador, 3 omitidas."),
      { esRow: esRow.slice(0, 300), esCounts },
    );

    // No password, made-up or not, reached a log or the page's markup.
    const html = await js<string>(wc, "document.documentElement.outerHTML");
    const leaked = SECRETS.filter((s) => logged.some((line) => line.includes(s)) || html.includes(s));
    check("password import: no password reaches a log or the page", leaked.length === 0, leaked);
  } finally {
    methods.forEach((m, i) => {
      console[m] = originals[i]!;
    });
    ctx.settings.update({ appearance: { language } });
    ctx.passwordExports.setTest(null, null);
    ctx.browserImport.setTestKeyProviders(null);
    ctx.browserImport.setTestRoots(null);
    if (tabId) win.closeTab(tabId);
    // Removed the way a sync removes them: no deletion memory is left in the smoke profile.
    vault.applyRemote(vault.all().filter((c) => !before.has(c.id)).map((c) => ({ id: c.id, cred: null })));
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(downloads, { recursive: true, force: true });
  }
}
