import crypto from "node:crypto";
import fs from "node:fs";
import type http from "node:http";
import os from "node:os";
import path from "node:path";
import { nativeImage, type WebContents } from "electron";
import type { AgentModelProvider, AgentTurnRequest, TurnEvent } from "@corvus/ai-engine";
import { originKeyOf } from "../shared/credentials";
import { totpCode, type TotpConfig } from "../shared/totp";
import type { AppContext } from "./context";
import { decodeTotpQrFile, exportVaultToKdbx } from "./ipc-credentials";
import { windowShot } from "./smoke-cert-errors";
import { createKdbx, openKdbx } from "./keepass-format";
import { AI_REDACTED_BODY } from "@corvus/webscope";
import type { BrowserWindowCtl } from "./window";

interface SmokeCtx {
  url: string;
  win: BrowserWindowCtl;
  check: (name: string, ok: boolean, detail?: unknown) => void;
  capture: (name: string, wc: WebContents) => Promise<void>;
}

const OTP_PAGE = `<!doctype html><html><head><title>Two-step verification</title></head><body>
<main><h1>Enter your code</h1>
<form method="GET" action="/after-login">
<label for="otp">One-time code</label><input id="otp" name="otp" inputmode="numeric" autocomplete="one-time-code" maxlength="6">
<button type="submit">Verify</button>
</form></main></body></html>`;

const SPLIT_OTP_PAGE = `<!doctype html><html><head><title>Verify</title></head><body>
<main><h1>Enter the 6-digit code</h1>
<form onsubmit="return false"><div class="boxes">
${[1, 2, 3, 4, 5, 6].map((i) => `<input class="d" aria-label="Digit ${i}" maxlength="1" inputmode="numeric">`).join("")}
</div><button type="submit">Verify</button></form></main></body></html>`;

const POST_LOGIN_PAGE = `<!doctype html><html><head><title>Sign in (POST)</title></head><body>
<main><h1>Sign in</h1>
<form method="POST" action="/after-login">
<label for="u">Username</label><input id="u" name="u" type="text" autocomplete="username">
<label for="p">Password</label><input id="p" name="p" type="password" autocomplete="current-password">
<button type="submit">Sign in</button>
</form></main></body></html>`;

/** A password the breach stand-in reports, and how many times. */
const PWNED_PASSWORD = "password123";
const PWNED_COUNT = 251682;
/** What the breach stand-in was asked: path and Add-Padding header. */
const pwnedRequests: Array<{ path: string; padding: string }> = [];

/** Have I Been Pwned's range API stand-in: the known suffix under its prefix, plus padding. */
function servePwnedRange(pathname: string, req: http.IncomingMessage, res: http.ServerResponse): void {
  pwnedRequests.push({ path: pathname, padding: String(req.headers["add-padding"] ?? "") });
  const sha1 = crypto.createHash("sha1").update(PWNED_PASSWORD).digest("hex").toUpperCase();
  const lines = [`${"0".repeat(35)}:0`, `${"F".repeat(35)}:3`];
  if (pathname.endsWith(`/${sha1.slice(0, 5)}`)) lines.splice(1, 0, `${sha1.slice(5)}:${PWNED_COUNT}`);
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end(lines.join("\r\n"));
}

/** Extra pages for the credentials smoke, served by the shared smoke server. */
export function serveCredentialsSmokeRoute(req: http.IncomingMessage, res: http.ServerResponse): boolean {
  const pathname = (req.url ?? "/").split("?")[0] ?? "/";
  if (pathname.startsWith("/pwned/range/")) {
    servePwnedRange(pathname, req, res);
    return true;
  }
  const page = pathname === "/2fa" ? OTP_PAGE : pathname === "/2fa-split" ? SPLIT_OTP_PAGE : pathname === "/login-post" ? POST_LOGIN_PAGE : null;
  if (!page) return false;
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(page);
  return true;
}

const TOTP: TotpConfig = { secret: "JBSWY3DPEHPK3PXPJBSWY3DP", algorithm: "SHA1", digits: 6, period: 30 };

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function poll(fn: () => boolean, tries = 40): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    if (fn()) return true;
    await delay(150);
  }
  return fn();
}

/** Codes valid around now (previous, current, next window), to tolerate a window rollover. */
async function nearbyCodes(config: TotpConfig = TOTP): Promise<string[]> {
  const now = Date.now();
  const codes = await Promise.all([-30_000, 0, 30_000].map(async (offset) => (await totpCode(config, now + offset)).code));
  return [...new Set(codes)];
}

/** True when `text` holds one of the codes as a standalone number (not inside a longer digit run). */
function containsCode(text: string, codes: string[]): boolean {
  return codes.some((code) => new RegExp(`(?<!\\d)${code}(?!\\d)`).test(text));
}

async function openAndWait(win: BrowserWindowCtl, url: string, needle: string) {
  const tab = win.createTab(url);
  const wc = tab.view.webContents;
  await poll(() => !wc.isDestroyed() && wc.getURL().includes(needle) && !tab.loading);
  await delay(250);
  return { tab, wc };
}

/** Writes a PNG with a QR code for `text`, rendered the way a screenshot of a setup page would be. */
async function writeQrPng(text: string): Promise<string> {
  const { default: encodeQR } = await import("qr");
  const modules = encodeQR(text, "raw");
  const scale = 6;
  const quiet = 4;
  const size = (modules.length + quiet * 2) * scale;
  const bgra = Buffer.alloc(size * size * 4, 255);
  modules.forEach((row, y) =>
    row.forEach((dark, x) => {
      if (!dark) return;
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const px = ((y + quiet) * scale + dy) * size + (x + quiet) * scale + dx;
          bgra.writeUInt32LE(0xff000000, px * 4);
        }
      }
    }),
  );
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "corvus-qr-")), "setup.png");
  fs.writeFileSync(file, nativeImage.createFromBitmap(bgra, { width: size, height: size }).toPNG());
  return file;
}

/** Finds an element ref by accessible name in the latest snapshot handed to the model. */
function refFor(messages: AgentTurnRequest["messages"], name: string): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    for (const block of messages[i]!.content) {
      if (block.type === "tool_result" && block.content.includes("elements:")) {
        const match = block.content.match(new RegExp(`(\\be\\d+)\\s+\\w+\\s+"${name}`));
        if (match) return match[1]!;
      }
    }
  }
  return "e1";
}

/** navigate -> snapshot -> fill_totp(code field) -> snapshot -> done. Records every request. */
function totpAgent(url: string, seen: AgentTurnRequest[]): AgentModelProvider {
  return {
    kind: "anthropic-api",
    model: "claude-haiku-5-5",
    async *streamTurn(req): AsyncGenerator<TurnEvent> {
      seen.push(structuredClone(req));
      const issued = req.messages.filter((m) => m.role === "assistant" && m.content.some((c) => c.type === "tool_use")).length;
      const emit = (name: string, input: unknown): TurnEvent => ({ type: "tool_use", id: `otp${issued}`, name, input });
      await delay(20);
      if (issued === 0) yield emit("navigate", { url });
      else if (issued === 1) yield emit("page_snapshot", {});
      else if (issued === 2) yield emit("fill_totp", { ref: refFor(req.messages, "One-time code") });
      else if (issued === 3) yield emit("page_snapshot", {});
      else yield { type: "text", text: "Done." };
      yield { type: "usage", inputTokens: 100, outputTokens: 10, model: "claude-haiku-5-5" };
      yield { type: "end", stopReason: issued <= 3 ? "tool_use" : "end_turn" };
    },
  };
}

/**
 * Drives the password manager end to end headlessly: a seeded login is detected and filled on a login
 * page, then a changed password submitted through the form is captured and saved on the vault. Then
 * 2FA: QR import, one-time-code autofill (single field and split boxes), and the agent tool, blocked
 * without the per-login opt-in and allowed with it, with the code absent from the run transcript.
 */
export async function runCredentialsSmoke(ctx: AppContext, { url, win, check, capture }: SmokeCtx): Promise<void> {
  const base = url.replace(/\/$/, "");
  const origin = originKeyOf(base);
  const vault = win.profile.credentials;
  const seeded = vault.add({ origin, username: "alice", password: "s3cret-pw" });
  check("vault add", vault.get(seeded.id)?.password === "s3cret-pw");

  const tab = win.createTab(`${base}/login`);
  const wc = tab.view.webContents;
  await poll(() => !wc.isDestroyed() && wc.getURL().includes("/login") && !tab.loading);
  await delay(200);

  const detected = await poll(() => ctx.autofill.stateFor(win).available);
  check("autofill detects login form with a saved match", detected, ctx.autofill.stateFor(win));

  await ctx.autofill.fill(win, seeded.id);
  await delay(150);
  const filled = await wc.executeJavaScript(`document.getElementById("u").value + "/" + document.getElementById("p").value`);
  check("autofill fills username and password", filled === "alice/s3cret-pw", filled);
  await capture("passwords-login", wc);

  // Type a new password and submit the form (GET navigation) so it is captured for saving.
  await wc.executeJavaScript(`(() => {
    const p = document.getElementById("p");
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    set.call(p, "rotated-pw");
    p.dispatchEvent(new Event("input", { bubbles: true }));
    document.querySelector("form").requestSubmit();
    return true;
  })()`);

  const canSave = await poll(() => ctx.autofill.stateFor(win).canSave);
  check("autofill offers to save a submitted login", canSave, ctx.autofill.stateFor(win));

  const submitted = ctx.autofill.pendingSave(win);
  if (submitted) ctx.autofill.acceptSave(win, submitted);
  const saved = await poll(() => vault.get(seeded.id)?.password === "rotated-pw");
  check("autofill save updates the stored password", saved, vault.get(seeded.id)?.password);

  // ------------------------------------------------------------------ 2FA (TOTP)

  // QR import: a setup code rendered to a PNG is decoded locally into the otpauth link.
  const uri = `otpauth://totp/Smoke:alice?secret=${TOTP.secret}&issuer=Smoke`;
  const qrFile = await writeQrPng(uri);
  const imported = await decodeTotpQrFile(qrFile);
  check("2FA QR code image decodes locally", imported?.ok === true && imported.uri === uri, imported);
  fs.rmSync(path.dirname(qrFile), { recursive: true, force: true });

  vault.update(seeded.id, { totp: TOTP });
  check("vault stores a 2FA generator", vault.get(seeded.id)?.totp?.secret === TOTP.secret);

  // One-time-code autofill on the user's click.
  const otp = await openAndWait(win, `${base}/2fa`, "/2fa");
  const otpOffered = await poll(() => ctx.autofill.stateFor(win).otpAvailable);
  check("autofill detects a one-time-code field with a saved 2FA code", otpOffered, ctx.autofill.stateFor(win));
  await ctx.autofill.fillTotp(win, seeded.id);
  await delay(150);
  const otpValue = String(await otp.wc.executeJavaScript(`document.getElementById("otp").value`));
  check("autofill fills the current 2FA code", (await nearbyCodes()).includes(otpValue), { length: otpValue.length });
  await capture("passwords-2fa", otp.wc);

  const split = await openAndWait(win, `${base}/2fa-split`, "/2fa-split");
  const splitOffered = await poll(() => ctx.autofill.stateFor(win).otpAvailable);
  await ctx.autofill.fillTotp(win, seeded.id);
  await delay(150);
  const splitValue = String(await split.wc.executeJavaScript(`[...document.querySelectorAll("input.d")].map((i) => i.value).join("")`));
  check("autofill fills split one-digit code boxes", splitOffered && (await nearbyCodes()).includes(splitValue), { offered: splitOffered, length: splitValue.length });

  // Management page renders the login with its live code.
  const page = win.createTab("corvus://passwords");
  await delay(1400);
  const shown = await page.view.webContents.executeJavaScript(
    `Boolean(window.corvusInternal) && document.querySelector(".list-row") && document.body.innerText.includes("alice")`,
  );
  check("corvus://passwords lists saved logins", shown === true, shown);
  const liveCode = String(await page.view.webContents.executeJavaScript(`document.querySelector(".pw-totp-code")?.textContent ?? ""`)).replace(/\s/g, "");
  const warned = await page.view.webContents.executeJavaScript(`document.body.innerText.includes("turns two factors into one")`);
  check("corvus://passwords shows the live 2FA code and the warning", (await nearbyCodes()).includes(liveCode) && warned === true, { warned, length: liveCode.length });
  await capture("passwords", page.view.webContents);
  await checkupSmoke(ctx, base, page.view.webContents, { url, win, check, capture });

  const vaultTarget: AgentTarget = { label: "", totp: TOTP, secrets: [TOTP.secret], setOptIn: (on) => void vault.update(seeded.id, { agentTotp: on }) };
  if (process.env.CORVUS_SMOKE_NO_AGENT !== "1") await agentTotpSmoke(ctx, base, vaultTarget, { url, win, check, capture });
  await autoSignInSmoke(ctx, base, seeded.id, { url, win, check, capture });
  await keepassSmoke(ctx, base, { url, win, check, capture });
  await runSavePromptSmoke(ctx, { url, win, check, capture });
}

/** Types a login into the smoke login page and submits it, as a person would. */
async function submitLogin(wc: WebContents, username: string, password: string): Promise<void> {
  await wc.executeJavaScript(`(() => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    for (const [id, value] of [["u", ${JSON.stringify(username)}], ["p", ${JSON.stringify(password)}]]) {
      const input = document.getElementById(id);
      set.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }
    document.querySelector("form").requestSubmit();
    return true;
  })()`);
}

const chromeJs = <T>(win: BrowserWindowCtl, expr: string): Promise<T | null> => (win.chrome.webContents.executeJavaScript(expr) as Promise<T>).catch(() => null);

async function chromePoll(win: BrowserWindowCtl, expr: string, tries = 40): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    if ((await chromeJs<boolean>(win, expr)) === true) return true;
    await delay(150);
  }
  return false;
}

const PROMPT_OPEN = "Boolean(document.querySelector('.af-save'))";
const PROMPT_CLOSED = "!document.querySelector('.af-save')";

/** What the save prompt shows, read from the chrome UI (whether the password matches, never the password). */
interface PromptView {
  title: string;
  host: string;
  username: string;
  passwordType: string;
  passwordIs: boolean;
  eyeLabel: string;
  button: string;
  never: string;
  focused: boolean;
}

const promptView = (win: BrowserWindowCtl, password: string): Promise<PromptView | null> =>
  chromeJs<PromptView>(
    win,
    `(() => {
      const form = document.querySelector('.af-save');
      if (!form) return null;
      const pw = form.querySelector('input[name=password]');
      return {
        title: form.querySelector('.af-save-title')?.textContent ?? '',
        host: form.querySelector('.af-save-host')?.textContent ?? '',
        username: form.querySelector('input[name=username]')?.value ?? '',
        passwordType: pw?.type ?? '',
        passwordIs: pw?.value === ${JSON.stringify(password)},
        eyeLabel: form.querySelector('.af-eye')?.getAttribute('aria-label') ?? '',
        button: form.querySelector('.af-save-btn')?.textContent ?? '',
        never: form.querySelector('.af-never')?.textContent ?? '',
        focused: form.contains(document.activeElement),
      };
    })()`,
  );

/** Types into a field of the save prompt the way React sees typing. */
const typeInPrompt = (win: BrowserWindowCtl, name: string, value: string): Promise<unknown> =>
  chromeJs(
    win,
    `(() => {
      const input = document.querySelector('.af-save input[name=${name}]');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, ${JSON.stringify(value)});
      input.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    })()`,
  );

/**
 * The save-password prompt after a person submits a login (CORVUS_SMOKE_ONLY=passwords runs only
 * this): it opens by itself once, without taking the keyboard from the page, with the submitted
 * username and the masked password, which the eye reveals; what the person edits is what gets saved
 * (an edited username can turn a new login into an update); Cancel and Escape store nothing; a click
 * elsewhere closes it but the key button still reaches it; "Never for this site" stops it on that host
 * until Settings > Passwords takes the host off its "Never saved" list; and no password ever reaches
 * the window state the chrome UI gets. Screenshots in the light and dark themes, and in Spanish.
 */
export async function runSavePromptSmoke(ctx: AppContext, { url, win, check, capture }: SmokeCtx): Promise<void> {
  const base = url.replace(/\/$/, "");
  const origin = originKeyOf(base);
  const vault = win.profile.credentials;
  const passwords = ["first-pass-1", "edited-pass-2", "cancel-pass-3", "new-pass-4", "other-pass-5", "never-pass-6", "never-pass-7"];
  await chromeJs(win, "window.__saveStates = []; window.corvus.onState((s) => window.__saveStates.push(JSON.stringify(s))); true");
  const loginPage = `${base}/login-post`;
  const { tab, wc } = await openAndWait(win, loginPage, "/login-post");
  const submit = async (username: string, password: string): Promise<boolean> => {
    if (!wc.getURL().includes("/login-post")) {
      win.loadUrl(tab.id, loginPage);
      await poll(() => wc.getURL().includes("/login-post") && !tab.loading);
      await delay(150);
    }
    await submitLogin(wc, username, password);
    return chromePoll(win, PROMPT_OPEN);
  };
  const { theme: themeBefore, language: languageBefore } = ctx.settings.get().appearance;
  ctx.settings.update({ appearance: { theme: "light", language: "en" } });
  try {
    // A new login: the prompt opens by itself and leaves the keyboard where it was.
    const pageFocused = wc.isFocused();
    const chromeFocused = win.chrome.webContents.isFocused();
    const opened = await submit("carol", "first-pass-1");
    const first = await promptView(win, "first-pass-1");
    check("save prompt opens by itself after a submitted login", opened && first?.title === "Save password?" && first.host === "127.0.0.1" && first.button === "Save" && first.never === "Never for this site", first);
    check(
      "save prompt shows the submitted username and the password masked",
      first?.username === "carol" && first.passwordType === "password" && first.passwordIs && first.eyeLabel === "Show password",
      first,
    );
    const focus = { pageBefore: pageFocused, pageAfter: wc.isFocused(), chromeBefore: chromeFocused, chromeAfter: win.chrome.webContents.isFocused(), inPrompt: first?.focused };
    check("save prompt opened by itself leaves the keyboard on the page", first?.focused === false && focus.pageAfter === focus.pageBefore && focus.chromeAfter === focus.chromeBefore, focus);
    check("save prompt opens once per save (shown, it does not open by itself again)", ctx.autofill.stateFor(win).savePrompt === false, ctx.autofill.stateFor(win));
    for (const theme of ["light", "dark"] as const) {
      ctx.settings.update({ appearance: { theme } });
      await delay(400);
      await windowShot(win, `save-password-${theme}`, "save-password");
    }
    ctx.settings.update({ appearance: { theme: "light" } });

    // The eye shows the password and hides it again.
    await chromeJs(win, "document.querySelector('.af-save .af-eye').click(); true");
    await delay(100);
    const shown = await promptView(win, "first-pass-1");
    await windowShot(win, "save-password-revealed-light", "save-password");
    await chromeJs(win, "document.querySelector('.af-save .af-eye').click(); true");
    await delay(100);
    const hidden = await promptView(win, "first-pass-1");
    check(
      "save prompt: the eye reveals the password and hides it again",
      shown?.passwordType === "text" && shown.passwordIs && shown.eyeLabel === "Hide password" && hidden?.passwordType === "password" && hidden.eyeLabel === "Show password",
      { shown: shown && { type: shown.passwordType, label: shown.eyeLabel }, hidden: hidden && { type: hidden.passwordType, label: hidden.eyeLabel } },
    );

    // Edited username and password are what gets saved.
    await typeInPrompt(win, "username", "carol.edited");
    await typeInPrompt(win, "password", "edited-pass-2");
    await chromeJs(win, "document.querySelector('.af-save .af-save-btn').click(); true");
    const saved = await poll(() => vault.findByLogin(origin, "carol.edited")?.password === "edited-pass-2");
    const closed = await chromePoll(win, PROMPT_CLOSED);
    check(
      "save prompt stores the edited username and password",
      saved && closed && !vault.findByLogin(origin, "carol") && !ctx.autofill.stateFor(win).canSave,
      { saved, closed, unedited: Boolean(vault.findByLogin(origin, "carol")), state: ctx.autofill.stateFor(win) },
    );

    // Cancel stores nothing and drops the save.
    const loginsBefore = vault.usernamesAt(origin).length;
    const cancelOpened = await submit("dave", "cancel-pass-3");
    await chromeJs(win, "document.querySelector('.af-save .af-cancel').click(); true");
    const cancelClosed = await chromePoll(win, PROMPT_CLOSED);
    check(
      "save prompt: Cancel stores nothing and dismisses the save",
      cancelOpened && cancelClosed && !vault.findByLogin(origin, "dave") && vault.usernamesAt(origin).length === loginsBefore && !ctx.autofill.stateFor(win).canSave,
      { cancelOpened, cancelClosed, state: ctx.autofill.stateFor(win) },
    );

    // The person clicks into the prompt and types over the username, on the spot. The address bar had
    // the caret last (it was left by a click on the page): the click must not put it back there and
    // close the prompt. A username that is already saved turns the new login into an update; Enter saves.
    win.focusOmnibox();
    await delay(150);
    win.focusContent();
    await delay(150);
    const updateOpened = await submit("frank", "new-pass-4");
    const asNew = await promptView(win, "new-pass-4");
    const field = await chromeJs<{ x: number; y: number }>(
      win,
      "(() => { const r = document.querySelector('.af-save input[name=username]').getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()",
    );
    const chromeWc = win.chrome.webContents;
    chromeWc.focus(); // a click on Corvus's UI focuses its view first, as on screen
    await delay(100);
    if (field) for (const type of ["mouseDown", "mouseUp"] as const) chromeWc.sendInputEvent({ type, x: field.x, y: field.y, button: "left", clickCount: 1 });
    await delay(150);
    const clickedIn = await promptView(win, "new-pass-4");
    // Typing replaces the username once all of it is selected (a busy renderer can take a moment).
    const selectedAll = "(() => { const i = document.querySelector('.af-save input[name=username]'); return !!i && i.selectionStart === 0 && i.selectionEnd === i.value.length; })()";
    for (let i = 0; i < 20; i++) {
      chromeWc.selectAll();
      await delay(50);
      if ((await chromeJs<boolean>(win, selectedAll)) === true) break;
    }
    await chromeWc.insertText("carol.edited");
    await delay(100);
    const asUpdate = await promptView(win, "new-pass-4");
    for (const type of ["keyDown", "char", "keyUp"] as const) chromeWc.sendInputEvent({ type, keyCode: type === "char" ? "\r" : "Enter" });
    const updated = await poll(() => vault.findByLogin(origin, "carol.edited")?.password === "new-pass-4");
    check(
      "save prompt: a click into it edits the username there (the address bar does not take the click)",
      updateOpened && asNew?.title === "Save password?" && clickedIn?.focused === true && asUpdate?.username === "carol.edited",
      { updateOpened, asNew: asNew?.title, clickedIn: clickedIn?.focused, typed: asUpdate?.username },
    );
    check(
      "save prompt: an edited username that is already saved updates that login (Enter saves)",
      asUpdate?.title === "Update password?" && asUpdate.button === "Update" && updated && !vault.findByLogin(origin, "frank") && vault.usernamesAt(origin).length === loginsBefore,
      { asUpdate: asUpdate && { title: asUpdate.title, button: asUpdate.button }, updated, logins: vault.usernamesAt(origin).length },
    );
    const enterClosed = await chromePoll(win, PROMPT_CLOSED);
    const backToPage = await poll(() => wc.isFocused());
    check("save prompt: once saved from the keyboard, the keyboard goes back to the page", enterClosed && backToPage, { enterClosed, backToPage });

    // A click elsewhere closes it; it does not open by itself again (state pushes, tab switches), and
    // the key button still reaches it, with the keyboard; Escape then cancels.
    await submit("gina", "other-pass-5");
    await chromeJs(win, "document.querySelector('.omni-panel-backdrop').dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); true");
    const away = await chromePoll(win, PROMPT_CLOSED);
    win.pushState();
    const other = win.createTab(`${base}/`);
    await delay(400);
    win.activate(tab.id);
    await delay(600);
    const stayedClosed = (await chromeJs<boolean>(win, PROMPT_CLOSED)) === true;
    const stillPending = ctx.autofill.stateFor(win);
    check(
      "save prompt: a click elsewhere closes it and it stays closed, the save still pending behind the key button",
      away && stayedClosed && stillPending.canSave && !stillPending.savePrompt && (await chromeJs<boolean>(win, "Boolean(document.querySelector('.omni-autofill.save'))")) === true,
      { away, stayedClosed, state: stillPending },
    );
    await chromeJs(win, "document.querySelector('.omni-autofill.save').click(); true");
    const reopened = await chromePoll(win, PROMPT_OPEN);
    await delay(150);
    const again = await promptView(win, "other-pass-5");
    await chromeJs(win, "document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true");
    const escaped = await chromePoll(win, PROMPT_CLOSED);
    check(
      "save prompt: the key button opens it again with the keyboard, and Escape cancels",
      reopened && again?.username === "gina" && again.passwordIs && again.focused && escaped && !ctx.autofill.stateFor(win).canSave && !vault.findByLogin(origin, "gina"),
      { reopened, focused: again?.focused, escaped, state: ctx.autofill.stateFor(win) },
    );
    win.closeTab(other.id);

    // "Never for this site": nothing is stored and the prompt no longer comes on this exact host;
    // Settings > Passwords lists the host under "Never saved", and removing it there asks again.
    const host = new URL(base).host;
    const neverOpened = await submit("hank", "never-pass-6");
    await windowShot(win, "save-password-never-light", "save-password");
    await chromeJs(win, "document.querySelector('.af-save .af-never').click(); true");
    const neverClosed = await chromePoll(win, PROMPT_CLOSED);
    const listed = win.profile.siteSettings.neverSave().includes(host);
    const askedAgain = await submit("ivy", "never-pass-7");
    check(
      "save prompt: Never for this site stores nothing and stops offering to save logins on that host",
      neverOpened && neverClosed && listed && !askedAgain && !ctx.autofill.stateFor(win).canSave && !vault.findByLogin(origin, "hank") && !vault.findByLogin(origin, "ivy"),
      { neverOpened, neverClosed, listed, askedAgain, state: ctx.autofill.stateFor(win) },
    );
    const settingsTab = win.createTab("corvus://settings#passwords");
    const swc = settingsTab.view.webContents;
    const rowsJs = `[...document.querySelectorAll(".never-saved .list-row")].map((r) => r.querySelector(".grow")?.textContent ?? "")`;
    const shownInSettings = await poll(() => !swc.isDestroyed() && !settingsTab.loading, 60) && (await (async () => {
      for (let i = 0; i < 40; i++) {
        const rows = (await swc.executeJavaScript(rowsJs).catch(() => [])) as string[];
        if (rows.includes(host)) return true;
        await delay(150);
      }
      return false;
    })());
    await swc.executeJavaScript(`document.querySelector(".never-saved")?.scrollIntoView({ block: "center" }); true`).catch(() => null);
    await delay(300);
    await capture("settings-never-saved", swc);
    await swc.executeJavaScript(`[...document.querySelectorAll(".never-saved .list-row")].find((r) => r.querySelector(".grow")?.textContent === ${JSON.stringify(host)})?.querySelector("button")?.click(); true`).catch(() => null);
    const removed = await poll(() => !win.profile.siteSettings.neverSave().includes(host));
    let emptyShown = false;
    for (let i = 0; i < 40 && !emptyShown; i++) {
      emptyShown = (await swc.executeJavaScript(`!document.querySelector(".never-saved")`).catch(() => false)) === true;
      if (!emptyShown) await delay(150);
    }
    win.closeTab(settingsTab.id);
    win.activate(tab.id);
    await delay(300);
    const backAgain = await submit("ivy", "never-pass-7");
    if (backAgain) {
      await chromeJs(win, "document.querySelector('.af-save .af-cancel').click(); true");
      await chromePoll(win, PROMPT_CLOSED);
    }
    check(
      "Settings > Passwords lists a never-saved site, and removing it there brings the save prompt back on it",
      shownInSettings && removed && emptyShown && backAgain && !vault.findByLogin(origin, "ivy"),
      { host, shownInSettings, removed, emptyShown, backAgain },
    );

    // The password only ever reached the chrome UI through the prompt's own call, never the window state.
    const leaked = await chromeJs<boolean>(win, `window.__saveStates.some((s) => ${JSON.stringify(passwords)}.some((p) => s.includes(p)))`);
    const states = await chromeJs<number>(win, "window.__saveStates.length");
    check("save prompt: no submitted password is in the window state", leaked === false && (states ?? 0) > 0, { leaked, states });

    // In Spanish.
    ctx.settings.update({ appearance: { language: "es", theme: "dark" } });
    win.chrome.webContents.reload();
    await chromePoll(win, "Boolean(document.querySelector('.omni-input'))");
    const spanish = await submit("carol.edited", "other-pass-5");
    const es = await promptView(win, "other-pass-5");
    await windowShot(win, "save-password-es-dark", "save-password");
    check("save prompt in Spanish", spanish && es?.title === "¿Actualizar contraseña?" && es.button === "Actualizar" && es.eyeLabel === "Mostrar contraseña" && es.never === "Nunca en este sitio", es && { title: es.title, button: es.button, eye: es.eyeLabel, never: es.never });
  } finally {
    const left = ctx.autofill.stateFor(win);
    if (left.canSave) ctx.autofill.dismissSave(win, left.saveId);
    win.closeTab(tab.id);
    ctx.settings.update({ appearance: { theme: themeBefore, language: languageBefore } });
    win.chrome.webContents.reload();
    await chromePoll(win, "Boolean(document.querySelector('.omni-input'))");
  }
}

/**
 * Password checkup from corvus://passwords: a click on the button checks every saved password
 * against the breach stand-in with 5-character prefixes only, and the rows show breached,
 * reused and weak logins.
 */
async function checkupSmoke(ctx: AppContext, base: string, wc: WebContents, { win, check, capture }: SmokeCtx): Promise<void> {
  const profileVault = win.profile.credentials;
  ctx.passwordCheckup.endpoint = `${base}/pwned/range/`;
  const added = [
    profileVault.add({ origin: "https://breached.example", username: "bob", password: PWNED_PASSWORD }),
    profileVault.add({ origin: "https://one.example", username: "carol", password: "Tr0ub4dor&3xyzzy!" }),
    profileVault.add({ origin: "https://two.example", username: "carol", password: "Tr0ub4dor&3xyzzy!" }),
  ];
  pwnedRequests.length = 0;
  await delay(600);
  const clicked = await wc.executeJavaScript(`(() => { const b = document.querySelector(".pw-checkup .card-head button"); if (!b) return false; b.click(); return true; })()`);
  type Chips = { breached: string[]; reused: number; weak: number; summary: string };
  let chips: Chips | null = null;
  for (let i = 0; i < 40; i += 1) {
    await delay(200);
    chips = (await wc.executeJavaScript(
      `({ breached: [...document.querySelectorAll(".pw-health.danger")].map((e) => e.textContent), reused: [...document.querySelectorAll(".pw-health")].filter((e) => e.textContent === "Reused").length, weak: [...document.querySelectorAll(".pw-health")].filter((e) => e.textContent === "Weak").length, summary: document.querySelector(".pw-checkup")?.innerText ?? "" })`,
    )) as Chips;
    if (chips && chips.breached.length > 0) break;
  }
  check(
    "password checkup flags the breached, reused and weak logins",
    clicked === true && chips?.breached.length === 1 && chips.breached[0]?.replace(/\D/g, "") === String(PWNED_COUNT) && chips.reused >= 2 && chips.weak >= 1,
    chips,
  );
  check(
    "password checkup sends only 5-character prefixes, padded",
    pwnedRequests.length > 0 && pwnedRequests.every((r) => /^\/pwned\/range\/[0-9A-F]{5}$/.test(r.path) && r.padding === "true"),
    pwnedRequests,
  );
  await capture("passwords-checkup", wc);
  for (const cred of added) profileVault.remove(cred.id);
}

/** Opt-in auto sign-in: asks first, does nothing when declined, fills and submits when confirmed. */
async function autoSignInSmoke(ctx: AppContext, base: string, credId: string, { win, check }: SmokeCtx): Promise<void> {
  let asked = 0;
  let approve = false;
  ctx.autofill.setAutoSignInApprover(async () => {
    asked += 1;
    return { approved: approve, stopOffering: false };
  });
  try {
    // Not opted in: no prompt.
    const plain = await openAndWait(win, `${base}/login`, "/login");
    await delay(600);
    const askedWithoutOptIn = asked;
    win.closeTab(plain.tab.id);

    win.profile.autoSignIn.set(credId, true);
    const declined = await openAndWait(win, `${base}/login`, "/login");
    await poll(() => asked > askedWithoutOptIn);
    await delay(300);
    const declinedState = await declined.wc.executeJavaScript(`location.pathname + "|" + document.getElementById("p").value`);
    win.closeTab(declined.tab.id);

    approve = true;
    const confirmed = await openAndWait(win, `${base}/login`, "/login");
    const signedIn = await poll(() => !confirmed.wc.isDestroyed() && confirmed.wc.getURL().includes("/after-login"));
    const submitted = confirmed.wc.getURL();
    win.closeTab(confirmed.tab.id);

    // Agent-driven tabs never auto sign in.
    const before = asked;
    const agentTab = await ctx.controller.openTab(`${base}/login`);
    await delay(800);
    const agentAsked = asked - before;
    await ctx.controller.closeTab(agentTab.id);

    check(
      "auto sign-in asks first, skips when declined, signs in when confirmed",
      askedWithoutOptIn === 0 && declinedState === "/login|" && signedIn && submitted.includes("u=alice") && agentAsked === 0,
      { askedWithoutOptIn, declinedState: String(declinedState).split("|")[0], signedIn, agentAsked },
    );
  } finally {
    ctx.autofill.setAutoSignInApprover(null);
    win.profile.autoSignIn.set(credId, false);
  }
}

const KP_TOTP: TotpConfig = { secret: "KRSXG5CTMVRXEZLUKN2XAZLSKNSWG4TF", algorithm: "SHA1", digits: 6, period: 30 };
const KP_PASSWORD = "kp-smoke-password";
const KP_MASTER = "smoke-master-pass";

/**
 * KeePass end to end: a database generated for the smoke is added and unlocked, its login is offered
 * and filled on the login page, its 2FA code goes through the same agent gates, agent sign-in is
 * gated by the per-entry opt-in, the vault exports to a new .kdbx, and the database file is never
 * modified.
 */
async function keepassSmoke(ctx: AppContext, base: string, { url, win, check, capture }: SmokeCtx): Promise<void> {
  const kp = win.profile.keepass;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "corvus-kp-smoke-"));
  const file = path.join(dir, "Smoke vault.kdbx");
  const before = ctx.settings.get().passwords.agentAccess;
  try {
    fs.writeFileSync(
      file,
      await createKdbx([{ title: "Smoke site", username: "kp-user", password: KP_PASSWORD, url: base, totp: KP_TOTP }], KP_MASTER, {
        memoryKiB: 4096,
        iterations: 1,
        totpFields: "keepassxc",
      }),
    );
    const hashBefore = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
    kp.addSources([file], "file");
    const dbId = kp.databases().find((d) => d.path === file)?.id ?? "";
    const wrong = await kp.unlock(dbId, "nope", null, false);
    const unlocked = await kp.unlock(dbId, KP_MASTER, null, false);
    check("KeePass database unlocks with the master password only", !wrong.ok && unlocked.ok, { wrong, unlocked });

    // Autofill offers the KeePass login next to the vault one and fills it.
    const login = await openAndWait(win, `${base}/login`, "/login");
    await poll(() => ctx.autofill.stateFor(win).available);
    const suggestion = ctx.autofill.suggestions(win).find((m) => m.source === "keepass");
    check("autofill suggests the KeePass login", suggestion?.username === "kp-user" && suggestion.sourceName === "Smoke vault" && suggestion.hasTotp, suggestion);
    if (suggestion) await ctx.autofill.fill(win, suggestion.id);
    await delay(150);
    const filled = await login.wc.executeJavaScript(`document.getElementById("u").value + "/" + document.getElementById("p").value`);
    check("autofill fills the KeePass login", filled === `kp-user/${KP_PASSWORD}`, { user: String(filled).split("/")[0] });

    // The passwords page lists the database and the entry, without the password.
    const page = win.createTab("corvus://passwords");
    await delay(1400);
    const pageText = String(await page.view.webContents.executeJavaScript(`document.getElementById("keepass")?.innerText ?? ""`));
    check("corvus://passwords shows the unlocked KeePass database", pageText.includes("Smoke vault") && pageText.includes("Smoke site") && !pageText.includes(KP_PASSWORD), {
      hasDb: pageText.includes("Smoke vault"),
    });
    await capture("passwords-keepass", page.view.webContents);

    const entryId = suggestion?.id ?? "";
    if (process.env.CORVUS_SMOKE_NO_AGENT !== "1" && entryId) {
      const target: AgentTarget = { label: " (KeePass)", totp: KP_TOTP, secrets: [KP_TOTP.secret, KP_PASSWORD], setOptIn: (on) => void kp.setOptIn(entryId, { totp: on }) };
      await agentTotpSmoke(ctx, base, target, { url, win, check, capture });

      // Agent sign-in by reference (MCP path): blocked without the opt-in, filled with it.
      ctx.settings.update({ passwords: { agentAccess: true } });
      let asked = 0;
      ctx.agentCredentials.setTestApprover(async () => {
        asked += 1;
        return true;
      });
      const tab = await ctx.controller.openTab(`${base}/login`);
      await delay(300);
      const blocked = await ctx.controller.fillLogin!(tab.id, { username: "kp-user" });
      kp.setOptIn(entryId, { signIn: true });
      const allowed = await ctx.controller.fillLogin!(tab.id, { username: "kp-user" });
      const found = ctx.windows.findTab(tab.id);
      const pageValues = found ? await found.tab.view.webContents.executeJavaScript(`document.getElementById("u").value + "/" + document.getElementById("p").value`) : "";
      const snap = JSON.stringify(await ctx.controller.snapshot(tab.id));
      check(
        "agent sign-in with a KeePass login: gated by the opt-in, filled by reference",
        blocked.status === "handoff" &&
          allowed.status === "filled" &&
          asked === 1 &&
          pageValues === `kp-user/${KP_PASSWORD}` &&
          !allowed.message.includes(KP_PASSWORD) &&
          !snap.includes(KP_PASSWORD),
        { blocked: blocked.status, allowed: allowed.status, asked },
      );

      // Script access is locked on that tab after the fill, and comes back on a new document.
      const evalBefore = ctx.settings.get().mcp.allowEvaluate;
      ctx.settings.update({ mcp: { allowEvaluate: true } });
      try {
        const lockedOut = await ctx.controller.evaluate!(tab.id, `document.getElementById("p").value`).then(
          (v) => ({ refused: false, leaked: v === KP_PASSWORD }),
          (err: unknown) => ({ refused: String((err as Error).message).includes("blocked here until the page navigates"), leaked: false }),
        );
        const lockText = await ctx.controller.secretFillLock!(tab.id);
        await ctx.controller.navigate(tab.id, `${base}/after-login`);
        const afterNav = await ctx.controller.evaluate!(tab.id, "1 + 1").catch((err: unknown) => String((err as Error).message));
        check(
          "after an agent fill_login, evaluate on that tab is refused until it navigates",
          lockedOut.refused && !lockedOut.leaked && Boolean(lockText) && afterNav === 2,
          { refused: lockedOut.refused, afterNav },
        );
      } finally {
        ctx.settings.update({ mcp: { allowEvaluate: evalBefore } });
      }
      await ctx.controller.closeTab(tab.id);

      // WebScope: the login an agent submits is hidden from AI and shown in full to people.
      const wsBefore = ctx.settings.get().webscope.enabled;
      ctx.webscope.setEnabled(true);
      try {
        const wsTab = await ctx.controller.openTab(`${base}/login-post`);
        await delay(300);
        const wsFill = await ctx.controller.fillLogin!(wsTab.id, { username: "kp-user" });
        const wsFound = ctx.windows.findTab(wsTab.id);
        await wsFound?.tab.view.webContents.executeJavaScript(`document.querySelector("form").requestSubmit(); true`);
        const engine = ctx.webscope.activeEngine();
        const loginRow = () => engine?.queryHistory({ method: "POST" }).find((r) => r.path.startsWith("/after-login"));
        await poll(() => Boolean(loginRow()), 60);
        const row = loginRow();
        const full = row ? engine!.getEntry(row.id) : undefined;
        const ai = row ? engine!.getEntryForAi(row.id) : undefined;
        const aiSearch = engine?.queryHistory({ search: KP_PASSWORD }, 200, { forAi: true }) ?? [];
        const peopleSearch = engine?.queryHistory({ search: KP_PASSWORD }) ?? [];
        check(
          "WebScope hides an agent-submitted login from AI and shows it in full to people",
          wsFill.status === "filled" &&
            row?.aiHidden === true &&
            Boolean(full?.request.body?.includes(KP_PASSWORD)) &&
            ai?.request.body === AI_REDACTED_BODY &&
            !JSON.stringify(ai ?? {}).includes(KP_PASSWORD) &&
            aiSearch.length === 0 &&
            peopleSearch.length > 0,
          { fill: wsFill.status, captured: Boolean(row), aiHidden: row?.aiHidden, aiSearch: aiSearch.length, peopleSearch: peopleSearch.length },
        );
        await ctx.controller.closeTab(wsTab.id);

        // The WebScope page marks the row for people.
        const wsPage = win.createTab("corvus://webscope");
        let badge = false;
        for (let i = 0; i < 30 && !badge; i++) {
          await delay(150);
          badge = await wsPage.view.webContents.executeJavaScript(`Boolean(document.querySelector(".ws-ai-hidden"))`).catch(() => false);
        }
        check("WebScope shows a Hidden from AI badge on the row", badge === true, badge);
        await capture("webscope-hidden-from-ai", wsPage.view.webContents);
        win.closeTab(wsPage.id);
      } finally {
        ctx.webscope.setEnabled(wsBefore);
      }

      ctx.agentCredentials.setTestApprover(null);
      kp.setOptIn(entryId, { signIn: false, totp: false });
    }

    // Export the built-in vault to a new .kdbx and read it back; an existing file is never overwritten.
    const exportFile = path.join(dir, "export.kdbx");
    const exported = await exportVaultToKdbx(win.profile, exportFile, "export-master-1");
    const reopened = exported?.ok ? await openKdbx(new Uint8Array(fs.readFileSync(exportFile)), "export-master-1", null) : null;
    const alice = reopened?.entries.find((e) => e.username === "alice");
    const again = await exportVaultToKdbx(win.profile, exportFile, "export-master-1");
    check(
      "export writes the vault and its 2FA to a new .kdbx and refuses to overwrite",
      Boolean(alice && alice.password === "rotated-pw" && alice.totp?.secret === TOTP.secret) && again?.ok === false,
      { exported: exported?.ok, again: again?.ok },
    );

    // Locking removes the KeePass login from autofill; the database file was never written.
    kp.lock(dbId);
    const afterLock = ctx.autofill.suggestions(win).some((m) => m.source === "keepass");
    const hashAfter = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
    check("locking hides KeePass logins and the database file is unchanged", !afterLock && hashAfter === hashBefore, { afterLock });

    // A new entry from the passwords page goes into the file, after a .bak copy of it.
    await kp.unlock(dbId, KP_MASTER, null, false);
    const editor = win.createTab("corvus://passwords/#keepass", { activate: true });
    const ew = editor.view.webContents;
    try {
      const pollPage = async (expr: string): Promise<boolean> => {
        for (let i = 0; i < 60; i++) {
          if ((await ew.executeJavaScript(`Boolean(${expr})`).catch(() => false)) === true) return true;
          await delay(100);
        }
        return false;
      };
      await pollPage("[...document.querySelectorAll('#keepass button')].some((b) => b.innerText.includes('New entry'))");
      await ew.executeJavaScript("[...document.querySelectorAll('#keepass button')].find((b) => b.innerText.includes('New entry'))?.click()");
      await pollPage("document.querySelector('.modal-card input.input')");
      await ew.executeJavaScript(`(() => {
        const set = (el, v) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, v); el.dispatchEvent(new Event("input", { bubbles: true })); };
        const inputs = [...document.querySelectorAll(".modal-card input.input")];
        set(inputs.find((i) => i.autofocus) ?? inputs[0], "Smoke new entry");
      })()`);
      await ew.executeJavaScript("[...document.querySelectorAll('.modal-card button')].find((b) => b.innerText.includes('Save to the database'))?.click()");
      const listed = await pollPage("(document.getElementById('keepass')?.innerText ?? '').includes('Smoke new entry') && !document.querySelector('.modal-card')");
      const backup = fs.existsSync(`${file}.bak`) && crypto.createHash("sha256").update(fs.readFileSync(`${file}.bak`)).digest("hex") === hashBefore;
      const saved = kp.entries().some((e) => e.title === "Smoke new entry");
      check("KeePass: a new entry from the passwords page is saved to the file, after a .bak copy of it", listed && backup && saved, { listed, backup, saved });
      await capture("passwords-keepass-new", ew);
    } finally {
      win.closeTab(editor.id);
      kp.lock(dbId);
    }
  } finally {
    ctx.agentCredentials.setTestApprover(null);
    ctx.settings.update({ passwords: { agentAccess: before } });
    for (const source of kp.sources()) kp.removeSource(source.id);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

interface AgentTarget {
  /** Suffix for check names, e.g. " (KeePass)". */
  label: string;
  totp: TotpConfig;
  /** Strings that must never reach the model (2FA secret, password). */
  secrets: string[];
  setOptIn: (on: boolean) => void;
}

/** The agent's fill_totp: handed off without the opt-in, filled with it, never in the transcript. */
async function agentTotpSmoke(ctx: AppContext, base: string, target: AgentTarget, { win, check }: SmokeCtx): Promise<void> {
  const before = ctx.settings.get().passwords.agentAccess;
  const label = target.label;
  const runView = () => ctx.agentRunner.windowExtras(win).agentRun;
  const runAgent = async (task: string): Promise<{ seen: AgentTurnRequest[]; runId: string | undefined; approvals: number }> => {
    const seen: AgentTurnRequest[] = [];
    ctx.agentRunner.setTestProvider(totpAgent(`${base}/2fa`, seen));
    ctx.agentRunner.start(win, task);
    let approvals = 0;
    const until = Date.now() + 20_000;
    while (Date.now() < until) {
      const view = runView();
      if (view?.status === "awaiting-approval") {
        approvals += 1;
        ctx.agentRunner.approve(win, "approve");
      }
      if (view && (view.status === "done" || view.status === "error" || view.status === "stopped")) break;
      await delay(80);
    }
    return { seen, runId: runView()?.id, approvals };
  };
  const agentTabCode = async (): Promise<string> => {
    const tabId = runView()?.tabId;
    const found = tabId ? ctx.windows.findTab(tabId) : undefined;
    if (!found || found.tab.view.webContents.isDestroyed()) return "";
    return String(await found.tab.view.webContents.executeJavaScript(`document.getElementById("otp")?.value ?? ""`).catch(() => ""));
  };
  const leaks = async (runId: string | undefined, seen: AgentTurnRequest[]): Promise<boolean> => {
    const codes = await nearbyCodes(target.totp);
    const stored = runId ? win.profile.agentRuns.get(runId) : undefined;
    const texts = [
      JSON.stringify(stored?.transcript ?? []),
      JSON.stringify((stored?.steps ?? []).map((s) => [s.summary, s.detail])),
      stored?.finalText ?? "",
      JSON.stringify(seen.map((r) => r.messages)),
      JSON.stringify(ctx.agents.view().calls.map((c) => c.summary)),
    ];
    return texts.some((t) => containsCode(t, codes) || target.secrets.some((s) => t.includes(s)));
  };

  try {
    // 1. Global switch on, but this login is not opted in: no prompt, nothing filled, handoff.
    ctx.settings.update({ passwords: { agentAccess: true } });
    target.setOptIn(false);
    const blocked = await runAgent("Finish signing in with the 2FA code");
    const blockedStored = blocked.runId ? win.profile.agentRuns.get(blocked.runId) : undefined;
    const blockedResult = JSON.stringify(blockedStored?.transcript ?? []);
    const blockedField = await agentTabCode();
    check(
      `agent 2FA fill blocked without the per-login opt-in${label}`,
      blocked.approvals === 0 && blockedField === "" && blockedResult.includes("not allowed AI agents to use the 2FA code") && blockedResult.includes("ask_user"),
      { approvals: blocked.approvals, filled: blockedField !== "", status: blockedStored?.status },
    );
    ctx.agentRunner.clear(win);

    // 2. Opted in: one approval, the code lands in the field, and nowhere in what the model sees.
    target.setOptIn(true);
    const allowed = await runAgent("Finish signing in with the 2FA code");
    const allowedField = await agentTabCode();
    const allowedStored = allowed.runId ? win.profile.agentRuns.get(allowed.runId) : undefined;
    check(
      `agent 2FA fill allowed with the opt-in, after one approval${label}`,
      allowed.approvals === 1 && (await nearbyCodes(target.totp)).includes(allowedField) && JSON.stringify(allowedStored?.transcript ?? []).includes("Filled the current 2FA code"),
      { approvals: allowed.approvals, length: allowedField.length, status: allowedStored?.status },
    );
    const masked = runView()?.tabId
      ? await ctx.windows
          .findTab(runView()!.tabId!)
          ?.tab.view.webContents.executeJavaScript(`(() => { const el = document.getElementById("otp"); return el.hasAttribute("data-corvus-secret") && getComputedStyle(el).webkitTextSecurity === "disc"; })()`)
          .catch(() => false)
      : false;
    check(`agent-filled code is marked secret and masked on screen${label}`, masked === true, masked);
    check(`2FA code and secret absent from transcript, run history and timeline${label}`, !(await leaks(allowed.runId, allowed.seen)) && !(await leaks(blocked.runId, blocked.seen)));
    ctx.agentRunner.clear(win);

    // 3. MCP path: controller.fillTotp with the dialog answered by the test hook.
    let asked = 0;
    ctx.agentCredentials.setTestApprover(async () => {
      asked += 1;
      return true;
    });
    const mcpTab = await ctx.controller.openTab(`${base}/2fa`);
    await delay(300);
    const snap = await ctx.controller.snapshot(mcpTab.id);
    const ref = snap.elements.find((e) => e.name === "One-time code")?.ref ?? "e1";
    const mcp = await ctx.controller.fillTotp!(mcpTab.id, ref);
    const after = await ctx.controller.snapshot(mcpTab.id);
    const codes = await nearbyCodes(target.totp);
    check(
      `MCP fill_totp fills after approval and never returns the code${label}`,
      mcp.status === "filled" && asked === 1 && !containsCode(mcp.message, codes) && !containsCode(JSON.stringify(after), codes),
      { status: mcp.status, asked },
    );
    await ctx.controller.closeTab(mcpTab.id);
  } finally {
    ctx.agentCredentials.setTestApprover(null);
    ctx.agentRunner.clear(win);
    ctx.agentRunner.setTestProvider(undefined);
    ctx.settings.update({ passwords: { agentAccess: before } });
    target.setOptIn(false);
  }
}
