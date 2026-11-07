import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { nativeTheme, safeStorage, type WebContents } from "electron";
import { NEW_TAB_URL } from "../shared/internal-urls";
import { base32Decode, totpAt } from "../shared/totp";
import type { AppContext } from "./context";
import { ProfileLock, isProfileLocked } from "./profile-lock";
import { windowShot } from "./smoke-cert-errors";
import { pageOf } from "./tab-page";
import type { BrowserWindowCtl, TabRuntime } from "./window";

interface Helpers {
  win: BrowserWindowCtl;
  check: (name: string, ok: boolean, detail?: unknown) => void;
  capture: (name: string, wc: WebContents) => Promise<void>;
}

const PIN = "246810";
const SHOTS = "profile-lock";
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const js = <T>(wc: WebContents, expr: string): Promise<T | null> => (wc.executeJavaScript(expr) as Promise<T>).catch(() => null);

async function until(cond: () => boolean | Promise<boolean>, timeoutMs = 10_000): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await cond()) return true;
    await sleep(120);
  }
  return false;
}

/** A page with a title, a "secret" line and a key listener that tries to swallow every key. */
const page = (title: string): string =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body style="font-family:sans-serif;padding:24px">` +
  `<h1>${title}</h1><p>Account balance 1234.56</p><input id="q" autofocus>` +
  `<script>addEventListener("keydown", (e) => { e.preventDefault(); e.stopPropagation(); }, true)</script></body></html>`;

/** Sets a React input's value as typing would. */
const fillInput = (selector: string, value: string): string => `(() => {
  const input = document.querySelector(${JSON.stringify(selector)});
  if (!input) return false;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, ${JSON.stringify(value)});
  input.dispatchEvent(new Event("input", { bubbles: true }));
  return true;
})()`;

/** Types into the lock form's field and presses Unlock. */
const typeAndUnlock = (secret: string): string => `${fillInput("[data-lock-secret]", secret)} && (document.querySelector("[data-lock-unlock]").click(), true)`;

/**
 * The profile lock (CORVUS_SMOKE_ONLY=profilelock): a profile with a PIN, Alt+H from a page that
 * swallows keys, everything hidden and refused while locked (tabs, Corvus pages, page RPC, agents,
 * autofill), the lock screen with nothing of the pages, a wrong PIN, the right one, and the
 * windows back as they were; screenshots of the lock screen in both themes and languages.
 */
export async function runProfileLockSmoke(ctx: AppContext, { win, check, capture }: Helpers): Promise<void> {
  const server = http.createServer((req, res) => {
    const name = (req.url ?? "/").includes("b") ? "Lock smoke B" : "Lock smoke A";
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(page(name));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const { theme: themeBefore, language: languageBefore } = ctx.settings.get().appearance;
  let lw: BrowserWindowCtl | null = null;
  let profileId: string | null = null;
  try {
    // Docker has no system keychain: Electron's in-memory one stands in for it (a lock needs one).
    if (!safeStorage.isEncryptionAvailable() && process.platform === "linux") safeStorage.setUsePlainTextEncryption(true);
    if (!safeStorage.isEncryptionAvailable()) {
      check("profile lock: the system keychain works here (a lock needs it)", false, { backend: safeStorage.getSelectedStorageBackend?.() });
      return;
    }
    const profile = await ctx.profileLocks.createProfile("Lock smoke", { kind: "pin", secret: PIN });
    profileId = profile.id;
    const runtime = ctx.profiles.get(profile.id);
    const login = runtime.credentials.add({ origin: base, username: "ana", password: "lock-smoke-pw", totp: { secret: "JBSWY3DPEHPK3PXP", algorithm: "SHA1", digits: 6, period: 30 } });
    const vault = JSON.parse(fs.readFileSync(path.join(runtime.dataDir, "credentials.json"), "utf8")) as { key: { data: string } };
    const layered = safeStorage.decryptString(Buffer.from(vault.key.data, "base64")).startsWith("corvus-lk1:");
    check("profile lock: a new profile with a PIN, its vault key sealed under the lock key", runtime.lock.kind === "pin" && !runtime.locked && layered, { layered });

    lw = ctx.windows.open(profile.id, [`${base}/a`, `${base}/b`]);
    const w = lw;
    const [tabA, tabB] = w.tabRuntimes() as [TabRuntime, TabRuntime];
    await until(() => tabA.title === "Lock smoke A" && !tabA.loading);
    w.activate(tabA.id);
    const settingsTab = w.createTab("corvus://settings/#profile-lock", { activate: false });
    await until(async () => (await js<boolean>(settingsTab.view.webContents, "Boolean(document.querySelector('#profile-lock [data-lock-now]'))")) === true, 15_000);
    w.activate(settingsTab.id);
    await sleep(400);
    await capture(`${SHOTS}/settings-lock-section`, settingsTab.view.webContents);
    w.activate(tabA.id);
    await until(() => w.chrome.webContents.isLoading() === false);
    await sleep(300);

    // Alt+H in a page that swallows every key: Corvus takes it first.
    const pageWc = tabA.view.webContents;
    w.win.focus();
    pageWc.focus();
    pageWc.sendInputEvent({ type: "keyDown", keyCode: "H", modifiers: ["alt"] });
    pageWc.sendInputEvent({ type: "keyUp", keyCode: "H", modifiers: ["alt"] });
    const lockedByKey = await until(() => runtime.locked, 5000);
    check("profile lock: Alt+H in a page that swallows keys locks the profile", lockedByKey);
    if (!lockedByKey) ctx.profileLocks.lock(runtime);

    const [width = 0, height = 0] = w.win.getContentSize();
    const others = w.win.contentView.children.filter((c) => c !== w.chrome);
    const chromeBounds = w.chrome.getBounds();
    check(
      "profile lock: every view but the lock screen is hidden, the lock screen covers the window",
      w.locked && others.length >= 3 && others.every((c) => !c.getVisible()) && w.chrome.getVisible() && chromeBounds.width === width && chromeBounds.height === height,
      { others: others.map((c) => c.getVisible()), chromeBounds, width, height },
    );
    const form = await until(async () => (await js<boolean>(w.chrome.webContents, "Boolean(document.querySelector('[data-lock-screen] [data-lock-secret]'))")) === true);
    const chromeText = (await js<string>(w.chrome.webContents, "document.body.innerText + ' ' + document.body.innerHTML")) ?? "";
    const state = w.state();
    check(
      "profile lock: the chrome UI shows only the lock form, no tab titles or addresses",
      form && !chromeText.includes("Lock smoke A") && !chromeText.includes("Lock smoke B") && !chromeText.includes("127.0.0.1") && !chromeText.includes("tab-strip") && state.tabs.length === 0 && state.lock?.kind === "pin",
      { form, tabs: state.tabs.length, leak: ["Lock smoke A", "127.0.0.1"].filter((s) => chromeText.includes(s)) },
    );
    let readable = true;
    try {
      runtime.credentials.list();
    } catch (err) {
      readable = !isProfileLocked(err);
    }
    check(
      "profile lock: secrets left memory (the vault throws), tabs muted, Corvus pages let go of",
      !readable && w.tabRuntimes().filter((t) => pageOf(t.view)).every((t) => t.view.webContents.isAudioMuted() || Boolean(t.pendingUrl)) && Boolean(w.getTab(settingsTab.id)?.pendingUrl),
      { readable, settingsPending: w.getTab(settingsTab.id)?.pendingUrl },
    );

    // New tabs and Corvus pages wait behind the lock, and a Corvus page loaded anyway is empty and refused.
    const newTab = w.createTab(NEW_TAB_URL);
    w.openSingleton("corvus://settings/");
    const forced = w.tabRuntimes().find((t) => t.id === tabB.id)!;
    await forced.view.webContents.loadURL("corvus://history/").catch(() => undefined);
    const forcedText = await js<string>(forced.view.webContents, "document.body.innerText");
    const rpc = await js<string>(forced.view.webContents, "window.corvusInternal ? window.corvusInternal.call('history.query', {}).then(() => 'answered', (e) => String(e)) : 'no bridge'");
    check(
      "profile lock: new tabs and Settings stay unloaded and hidden; a Corvus page shows nothing and its calls are refused",
      Boolean(newTab.pendingUrl) && !newTab.view.getVisible() && w.tabRuntimes().every((t) => !t.view.getVisible()) && forcedText === "" && String(rpc).includes("This profile is locked"),
      { newTab: newTab.pendingUrl, forcedText, rpc },
    );

    // Agents and autofill cannot use the locked profile.
    let snapshotRefused = false;
    try {
      await ctx.controller.snapshot(tabA.id);
    } catch {
      snapshotRefused = true;
    }
    const agentTabs = await ctx.controller.listTabs();
    const target = ctx.windows.target();
    let loginsRefused = false;
    try {
      runtime.logins.matchesFor(`${base}/a`);
    } catch (err) {
      loginsRefused = isProfileLocked(err);
    }
    check(
      "profile lock: agents and autofill are refused (no tab of it listed or targeted, snapshot refused, logins throw, pages' autofill messages ignored)",
      snapshotRefused && !agentTabs.some((t) => w.hasTab(t.id)) && target !== w && loginsRefused && !ctx.windows.byUnlockedTab(pageWc),
      { snapshotRefused, listed: agentTabs.filter((t) => w.hasTab(t.id)).length, loginsRefused },
    );

    // A wrong PIN is refused, with an error on the form.
    await js(w.chrome.webContents, typeAndUnlock("000000"));
    const wrongShown = await until(async () => (await js<boolean>(w.chrome.webContents, "Boolean(document.querySelector('[data-lock-error]'))")) === true);
    check("profile lock: a wrong PIN is refused and says so", wrongShown && runtime.locked);
    await windowShot(w, "lock-screen-wrong-pin-en-light", SHOTS);

    // Screenshots: both themes, both languages (the chrome UI reloads to take the language).
    for (const [language, theme] of [["en", "light"], ["en", "dark"], ["es", "light"], ["es", "dark"]] as const) {
      ctx.settings.update({ appearance: { language, theme } });
      nativeTheme.themeSource = theme;
      w.chrome.webContents.reload();
      await until(async () => (await js<boolean>(w.chrome.webContents, "Boolean(document.querySelector('[data-lock-secret]'))")) === true);
      await sleep(500);
      if (language === "es") {
        const text = (await js<string>(w.chrome.webContents, "document.body.innerText")) ?? "";
        check(`profile lock: the lock screen in Spanish (${theme})`, text.includes("Este perfil está bloqueado") && text.includes("Desbloquear"), text.slice(0, 200));
      }
      await windowShot(w, `lock-screen-${language}-${theme}`, SHOTS);
    }
    ctx.settings.update({ appearance: { language: "en", theme: "light" } });
    nativeTheme.themeSource = "light";
    w.chrome.webContents.reload();
    await until(async () => (await js<boolean>(w.chrome.webContents, "Boolean(document.querySelector('[data-lock-secret]'))")) === true);
    // Locked from a fresh start too: a new lock object from disk is locked.
    check("profile lock: the profile starts locked after a restart", new ProfileLock(runtime.dataDir, safeStorage).locked);

    // The right PIN: the window comes back as it was.
    await js(w.chrome.webContents, typeAndUnlock(PIN));
    const unlocked = await until(() => !runtime.locked && !w.locked);
    const back = await until(async () => (await js<boolean>(w.chrome.webContents, "Boolean(document.querySelector('.tab-strip') && document.body.innerText.includes('Lock smoke A'))")) === true);
    const active = w.activeTab();
    check(
      "profile lock: the right PIN unlocks, the tabs and their pages come back, the vault opens",
      unlocked && back && Boolean(active?.view.getVisible()) && !tabA.view.webContents.isAudioMuted() && runtime.credentials.get(login.id)?.password === "lock-smoke-pw",
      { unlocked, back, active: active?.url, visible: active?.view.getVisible() },
    );
    w.activate(settingsTab.id);
    const settingsBack = await until(async () => (await js<boolean>(pageOf(w.getTab(settingsTab.id)!.view)!, "Boolean(document.querySelector('#profile-lock [data-lock-now]'))")) === true, 15_000);
    check("profile lock: Settings loads again once unlocked", settingsBack);
    await windowShot(w, "unlocked-en-light", SHOTS);

    // An authenticator app from Settings (QR code, confirmed with a code), then a lock opened with its next code.
    const settingsWc = pageOf(w.getTab(settingsTab.id)!.view)!;
    await js(settingsWc, `document.querySelector('[data-lock-add="totp"]').click()`);
    await until(async () => (await js<boolean>(settingsWc, "Boolean(document.querySelector('[data-lock-current]'))")) === true);
    await js(settingsWc, fillInput("[data-lock-current]", PIN));
    await js(settingsWc, "document.querySelector('[data-lock-save]').click()");
    const shown = await until(async () => Boolean(await js<string>(settingsWc, "document.querySelector('[data-lock-totp-secret]')?.textContent")));
    const secret = ((await js<string>(settingsWc, "document.querySelector('[data-lock-totp-secret]').textContent")) ?? "").replace(/\s+/g, "");
    await sleep(300);
    await capture(`${SHOTS}/settings-authenticator-setup`, settingsWc);
    const now = Math.floor(Date.now() / 1000);
    await js(settingsWc, fillInput("[data-lock-totp-code]", await totpAt(base32Decode(secret), now)));
    await js(settingsWc, "document.querySelector('[data-lock-save]').click()");
    const added = await until(() => runtime.lock.hasMethod("totp"));
    check("profile lock: Settings adds an authenticator app (QR code shown once, confirmed with a code)", shown && added && secret.length >= 32, { shown, added });
    ctx.profileLocks.lock(runtime);
    const codeButton = await until(async () => (await js<boolean>(w.chrome.webContents, "[...document.querySelectorAll('[data-lock-screen] button')].some((b) => b.textContent.includes('authenticator'))")) === true);
    await js(w.chrome.webContents, "[...document.querySelectorAll('[data-lock-screen] button')].find((b) => b.textContent.includes('authenticator')).click()");
    await until(async () => (await js<boolean>(w.chrome.webContents, "Boolean(document.querySelector('[data-lock-code]'))")) === true);
    await windowShot(w, "lock-screen-authenticator-en-light", SHOTS);
    // The code used to add the app works once: the next one opens the profile.
    await js(w.chrome.webContents, fillInput("[data-lock-code]", await totpAt(base32Decode(secret), now + 30)));
    await js(w.chrome.webContents, "document.querySelector('[data-lock-unlock]').click()");
    check("profile lock: the lock screen opens with the authenticator app's next code", codeButton && (await until(() => !runtime.locked)));
  } catch (err) {
    check("profile lock: unexpected error", false, (err as Error).stack ?? String(err));
  } finally {
    ctx.settings.update({ appearance: { theme: themeBefore, language: languageBefore } });
    nativeTheme.themeSource = themeBefore;
    if (lw && !lw.isDisposed()) lw.close();
    await sleep(500);
    if (profileId) await ctx.profiles.remove(profileId).catch(() => undefined);
    server.close();
    win.relayout();
  }
}
