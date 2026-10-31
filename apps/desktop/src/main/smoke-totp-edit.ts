import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { clipboard, nativeTheme, type WebContents } from "electron";
import { PAGE_SIZE, twoFactorItems } from "../shared/password-tabs";
import { base32Encode, totpCode, type TotpConfig } from "../shared/totp";
import type { AppContext } from "./context";
import { createKdbx, openKdbx } from "./keepass-format";
import type { BrowserWindowCtl, TabRuntime } from "./window";

interface Helpers {
  win: BrowserWindowCtl;
  check: (name: string, ok: boolean, detail?: unknown) => void;
  capture: (name: string, wc: WebContents) => Promise<void>;
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
const truthy = (wc: WebContents, expr: string): Promise<boolean> => js<boolean>(wc, `Boolean(${expr})`).then((v) => v === true);

/** A made-up secret per seed: no real account's. */
const secret = (seed: number): string => base32Encode(Uint8Array.from({ length: 20 }, (_, i) => (seed * 37 + i * 11 + 3) & 0xff));
const config = (seed: number): TotpConfig => ({ secret: secret(seed), algorithm: "SHA1", digits: 6, period: 30 });

/** Codes valid around now (previous, current, next window), to tolerate a window rollover. */
async function nearbyCodes(totp: TotpConfig): Promise<string[]> {
  const now = Date.now();
  return [...new Set(await Promise.all([-30_000, 0, 30_000].map(async (offset) => (await totpCode(totp, now + offset)).code)))];
}

/** Sets a React-controlled input the way typing does. */
const typeInto = (wc: WebContents, selector: string, value: string): Promise<unknown> =>
  js(wc, `(() => { const el = document.querySelector(${JSON.stringify(selector)}); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`);

const click = (wc: WebContents, selector: string): Promise<unknown> => js(wc, `(() => { const el = document.querySelector(${JSON.stringify(selector)}); el?.click(); return Boolean(el); })()`);

const row = (id: string): string => `.tf-row[data-id=${JSON.stringify(id)}]`;
const filterOf = (wc: WebContents, selector: string): Promise<string> => js<string>(wc, `getComputedStyle(document.querySelector(${JSON.stringify(selector)})).filter`).then((f) => f ?? "");
const pagerText = (wc: WebContents): Promise<string> => js<string>(wc, `document.querySelector(".tf-list .pager .muted")?.textContent ?? ""`).then((t) => t ?? "");
const dialogTitle = (wc: WebContents): Promise<string> => js<string>(wc, `document.querySelector(".modal-card .modal-title")?.textContent ?? ""`).then((t) => t ?? "");
const noDialog = (wc: WebContents): Promise<boolean> => truthy(wc, `!document.querySelector(".modal-card")`);

/**
 * A secret field of an edit form: blurred by default (computed filter), readable while focused or
 * pointed at, blurred again after, and its Copy button copies the value without unblurring it.
 */
async function secretFieldWorks(wc: WebContents, input: string, value: string): Promise<Record<string, unknown>> {
  const blurred = (f: string): boolean => f.includes("blur");
  wc.sendInputEvent({ type: "mouseMove", x: 2, y: 2 });
  await sleep(400);
  const atRest = await filterOf(wc, input);
  await js(wc, `document.querySelector(${JSON.stringify(input)}).focus()`);
  await sleep(350);
  const focused = await filterOf(wc, input);
  await js(wc, `document.activeElement.blur()`);
  await sleep(350);
  const left = await filterOf(wc, input);
  const box = await js<{ x: number; y: number }>(wc, `(() => { const r = document.querySelector(${JSON.stringify(input)}).getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
  if (box) wc.sendInputEvent({ type: "mouseMove", x: box.x, y: box.y });
  await sleep(350);
  const hovered = await filterOf(wc, input);
  wc.sendInputEvent({ type: "mouseMove", x: 2, y: 2 });
  await sleep(350);
  clipboard.clear();
  const copyButton = `document.querySelector(${JSON.stringify(input)}).parentElement.querySelector(".pw-secret-copy")`;
  const clicked = await js<boolean>(wc, `(() => { const b = ${copyButton}; if (!b || b.disabled) return false; b.click(); return true; })()`);
  const feedback = (await until(() => truthy(wc, `${copyButton}.title === "Copied"`), 1000)) ? "Copied" : await js<string>(wc, `${copyButton}.title`);
  const copied = await until(async () => String(await clipboard.readText()) === value, 3000);
  const afterCopy = await filterOf(wc, input);
  const held = String(await clipboard.readText()).length;
  return {
    ok: blurred(atRest) && focused === "none" && blurred(left) && hovered === "none" && clicked === true && copied && blurred(afterCopy) && feedback === "Copied",
    atRest,
    focused,
    left,
    hovered,
    clicked,
    copied,
    clipboard: held,
    want: value.length,
    feedback,
    afterCopy,
  };
}

/**
 * Edit and Delete in the 2FA codes tab of corvus://passwords (CORVUS_SMOKE_ONLY=2faedit): Edit opens
 * the login's form over the list (after the confirm, as in the Passwords tab), changes the site, the
 * username and the 2FA secret, and the list keeps its page; Delete takes two distinct confirmations
 * (one alone deletes nothing, nor does a quick second click), and "Remove the 2FA only" keeps the
 * password; KeePass entries are edited and deleted (into the Recycle Bin) the same way; the Passwords
 * tab's delete has the same two steps; secret fields stay blurred until focused or pointed at. EN and
 * ES screenshots, and the rows fit narrow windows.
 */
export async function runTotpEditSmoke(ctx: AppContext, { win, check, capture }: Helpers): Promise<void> {
  const vault = win.profile.credentials;
  const kp = win.profile.keepass;
  const language = ctx.settings.get().appearance.language;
  const seeded: string[] = [];
  const add = (origin: string, username: string, password: string, seed: number): string => {
    const id = vault.add({ origin, username, password, totp: config(seed) }).id;
    seeded.push(id);
    return id;
  };
  // Enough logins with a 2FA that the ones under test are on the list's second page.
  for (let n = 0; n < 27; n++) add(`https://app${n}.example.test`, `user${n}@example.com`, `pw-${n}`, 300 + n);
  const editId = add("https://tfa-edit.example.test", "edit-old@example.com", "edit-pw-1", 1);
  const onlyId = add("https://tfa-only.example.test", "only@example.com", "", 2);
  const bothId = add("https://tfa-both.example.test", "both@example.com", "both-pw", 3);
  const pwId = add("https://tfa-pw.example.test", "pw@example.com", "pw-pw", 4);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "corvus-2fa-edit-"));
  const file = path.join(dir, "Edit vault.kdbx");
  let tab: TabRuntime | null = null;
  // The tab the Passwords page opens on is remembered: give it back as it was for the checks after these.
  let rememberedTab: string | null = null;
  try {
    fs.writeFileSync(
      file,
      await createKdbx(
        [
          { title: "KP Edit", username: "kp-old@example.com", password: "kp-pw-1", url: "https://kp-old.example.test", totp: config(5) },
          { title: "KP Delete", username: "kp-del@example.com", password: "kp-pw-2", url: "https://kp-del.example.test", totp: config(6) },
        ],
        "kp-edit-master",
        { memoryKiB: 4096, iterations: 1 },
      ),
    );
    kp.addSources([file], "file");
    const dbId = kp.databases().find((d) => d.path === file)?.id ?? "";
    check("2FA edit: the KeePass database for the edit checks unlocks", (await kp.unlock(dbId, "kp-edit-master", null, false)).ok);
    const kpId = (title: string): string => kp.entries().find((e) => e.title === title)?.id ?? "";
    const kpEditId = kpId("KP Edit");
    const kpDeleteId = kpId("KP Delete");

    tab = win.createTab("corvus://passwords/#2fa", { activate: true });
    const wc = tab.view.webContents;
    await until(() => truthy(wc, `document.querySelector(".tf-row .tf-code:not(.muted)")`), 15_000);
    wc.focus();
    rememberedTab = await js<string | null>(wc, `localStorage.getItem("corvus.passwords.tab")`);
    // Dialogs fade in: let them settle before a screenshot.
    const shot = async (name: string): Promise<void> => {
      await sleep(700);
      await capture(name, wc);
    };

    /** Shows the list page that holds a row, with the pager. */
    const showPageOf = async (id: string): Promise<boolean> => {
      const at = twoFactorItems(vault.list(""), kp.entries("")).findIndex((i) => i.id === id);
      const want = `${Math.floor(at / PAGE_SIZE) * PAGE_SIZE + 1}-`;
      for (let i = 0; i < 10 && !(await pagerText(wc)).startsWith(want); i++) {
        const from = Number((await pagerText(wc)).split("-")[0]);
        await click(wc, from > at + 1 ? ".tf-list .pager button:first-child" : ".tf-list .pager button:last-child");
        await sleep(250);
      }
      return until(() => truthy(wc, `document.querySelector(${JSON.stringify(row(id))})`), 3000);
    };

    // ---------------------------------------------------------------- the row buttons
    const onPage2 = await showPageOf(editId);
    const page = await pagerText(wc);
    const buttons = await js<string[]>(wc, `[...document.querySelector(${JSON.stringify(row(editId))}).querySelectorAll("button")].map((b) => b.getAttribute("aria-label") ?? b.innerText.trim())`);
    check("2FA codes tab: each row has Copy, then Show login, Edit and Delete", onPage2 && page.startsWith("26-") && JSON.stringify(buttons) === JSON.stringify(["Copy 2FA code", "Show login", "Edit", "Delete"]), { page, buttons });
    await js(wc, `document.querySelector(${JSON.stringify(row(editId))}).scrollIntoView({ block: "center" })`);
    await shot("2fa-edit-rows-en");

    // ---------------------------------------------------------------- Edit (vault)
    await js(wc, "window.confirm = () => false; true");
    await click(wc, `${row(editId)} .tf-edit`);
    await sleep(400);
    check("2FA codes tab: Edit asks first, and shows nothing when the person says no", await noDialog(wc));
    await js(wc, "window.confirm = () => true; true");
    await click(wc, `${row(editId)} .tf-edit`);
    const formShown = await until(() => truthy(wc, `document.querySelector(".modal-card .pw-origin")?.value === "https://tfa-edit.example.test"`));
    const secretField = await secretFieldWorks(wc, ".modal-card input.pw-password", "edit-pw-1");
    check("2FA codes tab: Edit opens the login's form over the list, its password blurred until focused or pointed at, Copy copies it unseen", formShown && secretField.ok === true, secretField);
    const totpField = await secretFieldWorks(wc, ".modal-card input.pw-totp-input", String(await js<string>(wc, `document.querySelector(".modal-card input.pw-totp-input").value`)));
    check("2FA codes tab: the 2FA secret in the form is blurred too, with its own Copy", totpField.ok === true && totpField.copied === true, { ...totpField, value: "<hidden>" });
    await shot("2fa-edit-form-en");

    // Cancel keeps everything, and the place in the list.
    await click(wc, ".modal-card .modal-foot .btn:not(.primary)");
    const cancelled = (await until(() => noDialog(wc))) && (await pagerText(wc)) === page && vault.get(editId)?.username === "edit-old@example.com";
    check("2FA codes tab: Cancel closes the form and the list stays on its page", cancelled, { page: await pagerText(wc) });

    await click(wc, `${row(editId)} .tf-edit`);
    await until(() => truthy(wc, `document.querySelector(".modal-card .pw-origin")`));
    await typeInto(wc, ".modal-card .pw-origin", "https://login.tfa-new.example.test");
    await typeInto(wc, ".modal-card .pw-username", "edit-new@example.com");
    await typeInto(wc, ".modal-card input.pw-totp-input", `otpauth://totp/New:edit-new@example.com?secret=${secret(11)}&issuer=New`);
    await click(wc, ".modal-card .modal-foot .btn.primary");
    await until(() => noDialog(wc));
    const edited = vault.get(editId);
    const newCode = await until(async () => {
      const shown = (await js<string>(wc, `document.querySelector(${JSON.stringify(`${row(editId)} .tf-code`)})?.textContent ?? ""`))?.replace(/\s/g, "") ?? "";
      return (await nearbyCodes(config(11))).includes(shown);
    }, 5000);
    const site = await js<string>(wc, `document.querySelector(${JSON.stringify(`${row(editId)} .tf-host`)})?.textContent ?? ""`);
    check(
      "2FA codes tab: Edit changes the site, the username and the 2FA secret; the row shows the new code and the list keeps its page",
      edited?.origin === "https://login.tfa-new.example.test" && edited.username === "edit-new@example.com" && edited.password === "edit-pw-1" && edited.totp?.secret === secret(11) && newCode && site === "login.tfa-new.example.test" && (await pagerText(wc)) === page,
      { origin: edited?.origin, username: edited?.username, newCode, site, page: await pagerText(wc) },
    );

    // ---------------------------------------------------------------- Delete (vault), two steps
    const openDelete = async (id: string): Promise<boolean> => {
      await showPageOf(id);
      await click(wc, `${row(id)} .tf-delete`);
      return until(() => truthy(wc, `document.querySelector(".modal-card .dl-next")`), 3000);
    };
    const step1 = await openDelete(onlyId);
    const named = await js<string>(wc, `document.querySelector(".modal-card .dl-login")?.innerText ?? ""`);
    const noChoice = await truthy(wc, `!document.querySelector(".modal-card .dl-choices")`);
    check("Delete, step 1 names the login (site and username) and has nothing to choose for a 2FA-only login", step1 && /tfa-only\.example\.test/.test(named ?? "") && /only@example\.com/.test(named ?? "") && noChoice, { named });
    await shot("2fa-delete-step1-en");
    await click(wc, ".modal-card .modal-foot .btn:not(.dl-next)");
    const keptAfterCancel = (await until(() => noDialog(wc))) && Boolean(vault.get(onlyId));

    await openDelete(onlyId);
    await click(wc, ".modal-card .dl-next");
    await until(() => truthy(wc, `document.querySelector(".modal-card .dl-confirm")`), 3000);
    const title2 = await dialogTitle(wc);
    const armedAtOnce = await truthy(wc, `!document.querySelector(".modal-card .dl-confirm").disabled`);
    // A quick second click (a double click on step 1) reaches a button that is still off.
    await click(wc, ".modal-card .dl-confirm");
    await sleep(200);
    const keptAfterQuickClick = Boolean(vault.get(onlyId));
    const focusOnCancel = await truthy(wc, `document.activeElement?.matches(".modal-card .modal-foot .btn:not(.dl-confirm)")`);
    await until(() => truthy(wc, `!document.querySelector(".modal-card .dl-confirm").disabled`), 3000);
    await shot("2fa-delete-step2-en");
    await click(wc, ".modal-card .modal-foot .btn:not(.dl-confirm)");
    const keptAfterStep2Cancel = (await until(() => noDialog(wc))) && Boolean(vault.get(onlyId));
    check(
      "Delete needs both confirmations: cancelling either step, or a quick second click, deletes nothing",
      keptAfterCancel && title2 === "Delete the login for good?" && !armedAtOnce && keptAfterQuickClick && focusOnCancel && keptAfterStep2Cancel,
      { keptAfterCancel, title2, armedAtOnce, keptAfterQuickClick, focusOnCancel, keptAfterStep2Cancel },
    );

    await openDelete(onlyId);
    await click(wc, ".modal-card .dl-next");
    await until(() => truthy(wc, `document.querySelector(".modal-card .dl-confirm") && !document.querySelector(".modal-card .dl-confirm").disabled`), 3000);
    await click(wc, ".modal-card .dl-confirm");
    const gone = (await until(() => noDialog(wc))) && (await until(() => !vault.get(onlyId) && truthy(wc, `!document.querySelector(${JSON.stringify(row(onlyId))})`), 5000));
    check("Delete for good, after both confirmations, deletes the 2FA-only login and its row", gone, { inVault: Boolean(vault.get(onlyId)) });

    // Remove the 2FA only: the login keeps its password.
    await openDelete(bothId);
    const choices = await js<{ values: string[]; checked: string }>(wc, `(() => { const r = [...document.querySelectorAll(".modal-card .dl-choices input")]; return { values: r.map((i) => i.value), checked: r.find((i) => i.checked)?.value ?? "" }; })()`);
    await shot("2fa-delete-choice-en");
    await click(wc, ".modal-card .dl-next");
    await until(() => truthy(wc, `document.querySelector(".modal-card .dl-confirm") && !document.querySelector(".modal-card .dl-confirm").disabled`), 3000);
    const totpTitle = await dialogTitle(wc);
    await click(wc, ".modal-card .dl-confirm");
    await until(() => noDialog(wc));
    const both = await until(() => vault.get(bothId)?.totp === undefined, 3000);
    check(
      "Remove the 2FA only (the first choice in the 2FA codes tab) keeps the password",
      JSON.stringify(choices?.values) === JSON.stringify(["totp", "login"]) && choices?.checked === "totp" && totpTitle === "Remove the 2FA for good?" && both && vault.get(bothId)?.password === "both-pw",
      { choices, totpTitle, password: vault.get(bothId)?.password === "both-pw" },
    );

    // ---------------------------------------------------------------- KeePass: edit and delete
    await showPageOf(kpEditId);
    await click(wc, `${row(kpEditId)} .tf-edit`);
    const kpForm = await until(() => truthy(wc, `document.querySelector(".modal-card .kp-field-title")?.value === "KP Edit" && document.querySelector(".modal-card .kp-field-url")?.value === "https://kp-old.example.test"`));
    await typeInto(wc, ".modal-card .kp-field-username", "kp-new@example.com");
    await typeInto(wc, ".modal-card .kp-field-url", "https://kp-new.example.test");
    await typeInto(wc, ".modal-card input.kp-totp-input", secret(12));
    const kpSecret = await secretFieldWorks(wc, ".modal-card input.kp-totp-input", secret(12));
    await shot("2fa-edit-keepass-form-en");
    await click(wc, ".modal-card .modal-foot .btn.primary");
    await until(() => noDialog(wc), 8000);
    const kpEdited = await until(() => kp.get(kpEditId)?.totp?.secret === secret(12), 5000);
    const kpRecord = kp.get(kpEditId);
    const kpCode = await until(async () => {
      const shown = (await js<string>(wc, `document.querySelector(${JSON.stringify(`${row(kpEditId)} .tf-code`)})?.textContent ?? ""`))?.replace(/\s/g, "") ?? "";
      return (await nearbyCodes(config(12))).includes(shown);
    }, 5000);
    check(
      "2FA codes tab: Edit on a KeePass entry changes its address, username and 2FA in the file (after a .bak copy); the row shows the new code",
      kpForm && kpEdited && kpRecord?.username === "kp-new@example.com" && kpRecord.site === "https://kp-new.example.test" && kpRecord.password === "kp-pw-1" && kpCode && fs.existsSync(`${file}.bak`) && kpSecret.ok === true,
      { kpForm, kpEdited, username: kpRecord?.username, site: kpRecord?.site, kpCode, kpSecret },
    );

    await openDelete(kpDeleteId);
    await js(wc, `document.querySelector('.modal-card .dl-choices input[value="login"]').click()`);
    await click(wc, ".modal-card .dl-next");
    await until(() => truthy(wc, `document.querySelector(".modal-card .dl-confirm") && !document.querySelector(".modal-card .dl-confirm").disabled`), 3000);
    const kpTitle = await dialogTitle(wc);
    await shot("2fa-delete-keepass-step2-en");
    await click(wc, ".modal-card .dl-confirm");
    await until(() => noDialog(wc), 8000);
    const kpGone = await until(() => !kp.get(kpDeleteId), 5000);
    const reopened = await openKdbx(fs.readFileSync(file), "kp-edit-master", null);
    check(
      "Delete on a KeePass entry, after both confirmations, moves it out of the database's entries (to its Recycle Bin)",
      kpTitle === "Delete the KeePass entry?" && kpGone && reopened.entries.map((e) => e.title).join() === "KP Edit",
      { kpTitle, kpGone, left: reopened.entries.map((e) => e.title) },
    );

    // ---------------------------------------------------------------- the Passwords tab: same two steps
    await js(wc, `document.getElementById("pw-tab-passwords").click()`);
    await typeInto(wc, ".page-toolbar .input", "tfa-pw.example.test");
    await until(() => truthy(wc, `document.querySelectorAll(".pw-list .pt-row").length === 1`), 5000);
    await js(wc, `document.querySelector(".pw-list .pt-row .pt-delete").click()`);
    await until(() => truthy(wc, `document.querySelector(".modal-card .dl-next")`), 3000);
    const pwChoice = await js<string>(wc, `[...document.querySelectorAll(".modal-card .dl-choices input")].find((i) => i.checked)?.value ?? ""`);
    await click(wc, ".modal-card .dl-next");
    await until(() => truthy(wc, `document.querySelector(".modal-card .dl-confirm")`), 3000);
    await click(wc, ".modal-card .modal-foot .btn:not(.dl-confirm)");
    const pwKept = (await until(() => noDialog(wc))) && Boolean(vault.get(pwId));
    await js(wc, `document.querySelector(".pw-list .pt-row .pt-delete").click()`);
    await until(() => truthy(wc, `document.querySelector(".modal-card .dl-next")`), 3000);
    await click(wc, ".modal-card .dl-next");
    await until(() => truthy(wc, `document.querySelector(".modal-card .dl-confirm") && !document.querySelector(".modal-card .dl-confirm").disabled`), 3000);
    await click(wc, ".modal-card .dl-confirm");
    const pwGone = (await until(() => noDialog(wc))) && (await until(() => !vault.get(pwId), 3000));
    check("Passwords tab: Delete takes the same two confirmations (the whole login first), and cancelling the second deletes nothing", pwChoice === "login" && pwKept && pwGone, { pwChoice, pwKept, pwGone });

    // ---------------------------------------------------------------- Spanish, and narrow windows
    await typeInto(wc, ".page-toolbar .input", "");
    await js(wc, `document.getElementById("pw-tab-2fa").click()`);
    ctx.settings.update({ appearance: { language: "es" } });
    wc.reload();
    await until(() => truthy(wc, `document.documentElement.lang === "es" && document.querySelector(".tf-row .tf-code:not(.muted)")`), 15_000);
    await js(wc, "window.confirm = () => true; true");
    await showPageOf(editId);
    const esButtons = await js<string[]>(wc, `[...document.querySelector(${JSON.stringify(row(editId))}).querySelectorAll("button")].map((b) => b.getAttribute("aria-label") ?? b.innerText.trim())`);
    await js(wc, `document.querySelector(${JSON.stringify(row(editId))}).scrollIntoView({ block: "center" })`);
    await shot("2fa-edit-rows-es");
    await click(wc, `${row(editId)} .tf-edit`);
    await until(() => truthy(wc, `document.querySelector(".modal-card .pw-origin")`));
    await js(wc, `document.querySelector(".modal-card input.pw-password").parentElement.querySelector(".pw-secret-copy").click()`);
    await sleep(200);
    const esCopied = await js<string>(wc, `document.querySelector(".modal-card input.pw-password").parentElement.querySelector(".pw-secret-copy").title`);
    await shot("2fa-edit-form-es");
    await click(wc, ".modal-card .modal-foot .btn:not(.primary)");
    await until(() => noDialog(wc));
    await openDelete(editId);
    const esStep1 = await dialogTitle(wc);
    await shot("2fa-delete-choice-es");
    await click(wc, ".modal-card .dl-next");
    await until(() => truthy(wc, `document.querySelector(".modal-card .dl-confirm") && !document.querySelector(".modal-card .dl-confirm").disabled`), 3000);
    const esStep2 = await dialogTitle(wc);
    const esButton = await js<string>(wc, `document.querySelector(".modal-card .dl-confirm").innerText`);
    await shot("2fa-delete-step2-es");
    await click(wc, ".modal-card .modal-foot .btn:not(.dl-confirm)");
    await until(() => noDialog(wc));
    check(
      "2FA codes tab in Spanish: Editar, Eliminar, the two delete steps and Copiado",
      JSON.stringify(esButtons) === JSON.stringify(["Copiar código 2FA", "Ver contraseña", "Editar", "Eliminar"]) && esStep1 === "¿Eliminar esta cuenta guardada?" && esStep2 === "¿Quitar el 2FA para siempre?" && esButton === "Quitar el 2FA para siempre" && esCopied === "Copiado" && Boolean(vault.get(editId)?.totp),
      { esButtons, esStep1, esStep2, esButton, esCopied },
    );

    // The rows stay inside the list at every width, in both languages (labels give way first, then two lines).
    const bounds = tab.view.getBounds();
    const fits: Record<string, unknown> = {};
    for (const lang of ["es", "en"] as const) {
      if (lang === "en") {
        ctx.settings.update({ appearance: { language: "en" } });
        wc.reload();
        await until(() => truthy(wc, `document.documentElement.lang === "en" && document.querySelector(".tf-row .tf-code:not(.muted)")`), 15_000);
      }
      for (const width of [480, 820, 1000, 1400]) {
        tab.view.setBounds({ ...bounds, width });
        await sleep(500);
        const audit = await js<{ page: boolean; rows: number; labels: boolean; bad: string[] }>(
          wc,
          `(() => {
            const bad = [];
            const rows = [...document.querySelectorAll(".tf-row")];
            for (const r of rows) {
              const box = r.getBoundingClientRect();
              const kids = [...r.children].map((c) => c.getBoundingClientRect()).filter((k) => k.width > 0);
              if (kids.some((k) => k.right > box.right + 1 || k.left < box.left - 1)) bad.push(r.dataset.id + " out");
              for (let i = 0; i < kids.length; i++) for (let j = i + 1; j < kids.length; j++) {
                const a = kids[i], b = kids[j];
                if (a.width && b.width && a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1) bad.push(r.dataset.id + " overlap " + i + "/" + j);
              }
            }
            const labels = [...document.querySelectorAll(".pt-actions .pt-label")].some((l) => l.offsetWidth > 0);
            return { page: document.documentElement.scrollWidth <= window.innerWidth + 1, rows: rows.length, labels, bad: bad.slice(0, 5) };
          })()`,
        );
        // Edit and Delete show their words when the list is wide (1400 px), only their icons below.
        fits[`${lang}-${width}`] = audit && { ...audit, labelsRight: audit.labels === (width === 1400) };
        if (width === 480 || width === 820) {
          for (const theme of ["light", "dark"] as const) {
            nativeTheme.themeSource = theme;
            await sleep(300);
            await capture(`2fa-edit-rows-${lang}-${width}-${theme}`, wc);
          }
          nativeTheme.themeSource = "system";
        }
      }
    }
    tab.view.setBounds(bounds);
    const allFit = Object.values(fits).every((a) => {
      const v = a as { page: boolean; rows: number; labelsRight: boolean; bad: string[] } | null;
      return Boolean(v && v.page && v.rows > 0 && v.labelsRight && v.bad.length === 0);
    });
    check("2FA codes tab: rows with Edit and Delete fit 480 to 1400 px wide, English and Spanish, nothing overlapping, words only when wide", allFit, fits);
  } finally {
    ctx.settings.update({ appearance: { language } });
    if (tab) {
      await js(tab.view.webContents, rememberedTab === null ? `localStorage.removeItem("corvus.passwords.tab")` : `localStorage.setItem("corvus.passwords.tab", ${JSON.stringify(rememberedTab)})`);
      win.closeTab(tab.id);
    }
    for (const id of seeded) if (vault.get(id)) vault.remove(id);
    for (const source of kp.sources()) if (source.path === file) kp.removeSource(source.id);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
