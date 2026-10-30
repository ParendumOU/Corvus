import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { dialog, nativeTheme, type WebContents } from "electron";
import { BACKUP_SNOOZE_MS } from "../shared/backup-reminder";
import { BackupStore } from "./backup-store";
import type { AppContext } from "./context";
import { openKdbx } from "./keepass-format";
import type { BrowserWindowCtl } from "./window";

interface Helpers {
  win: BrowserWindowCtl;
  check: (name: string, ok: boolean, detail?: unknown) => void;
  capture: (name: string, wc: WebContents) => Promise<void>;
}

const DAY = 86_400_000;
const MESSAGE = "Back up your passwords and 2FA codes: if this computer fails, a copy is the only way to get them back.";

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

interface HeaderAudit {
  /** Every button of the header shares the height and, row by row, the top of the others. */
  aligned: boolean;
  /** Something is shown under Back up now. */
  caption: boolean;
  /** Back up now's tooltip. */
  title: string;
  boxes: Array<{ label: string; top: number; height: number }>;
}

/** The Passwords page header's buttons, as laid out now. */
const HEADER_AUDIT = `(() => {
  const buttons = [...document.querySelectorAll(".page-toolbar .btn")].filter((b) => b.getBoundingClientRect().width > 0);
  const boxes = buttons.map((b) => { const r = b.getBoundingClientRect(); return { label: b.textContent.trim(), top: Math.round(r.top), height: Math.round(r.height) }; });
  const sameHeight = boxes.every((b) => Math.abs(b.height - boxes[0].height) <= 1);
  const rowsAligned = boxes.every((a) => boxes.every((b) => Math.abs(a.top + a.height / 2 - (b.top + b.height / 2)) > a.height || Math.abs(a.top - b.top) <= 1));
  const backup = buttons.find((b) => /Back up now|Hacer copia ahora/.test(b.textContent));
  const loose = [...document.querySelectorAll(".page-toolbar *")].some((el) => !el.closest(".btn") && !el.matches("input") && el.children.length === 0 && el.textContent.trim() && el.getBoundingClientRect().width > 0);
  return { aligned: buttons.length >= 3 && sameHeight && rowsAligned, caption: loose, title: backup ? backup.title : "", boxes };
})()`;

/**
 * The Passwords page header: Back up now, Import from Google Authenticator and Add in one row of
 * buttons of the same height, nothing under Back up now, and when the last backup was in its tooltip.
 * English and Spanish, wide and 480 px wide, light and dark.
 */
async function headerSmoke(ctx: AppContext, win: BrowserWindowCtl, wc: WebContents, { check, capture }: Omit<Helpers, "win">): Promise<void> {
  const tab = win.activeTab();
  if (!tab || tab.view.webContents !== wc) return;
  const bounds = tab.view.getBounds();
  const audits: Record<string, HeaderAudit | null> = {};
  try {
    for (const language of ["en", "es"] as const) {
      ctx.settings.update({ appearance: { language } });
      wc.reload();
      await until(() => js<boolean>(wc, `document.querySelectorAll(".page-toolbar .btn").length >= 3`).then(Boolean));
      await sleep(600);
      for (const width of ["wide", "480"] as const) {
        if (width === "480") tab.view.setBounds({ ...bounds, width: 480 });
        await sleep(500);
        audits[`${language}-${width}`] = await js<HeaderAudit>(wc, HEADER_AUDIT);
        for (const theme of ["light", "dark"] as const) {
          nativeTheme.themeSource = theme;
          await sleep(400);
          await capture(`passwords-header-${language}-${width}-${theme}`, wc);
        }
        tab.view.setBounds(bounds);
      }
    }
  } finally {
    nativeTheme.themeSource = "system";
    tab.view.setBounds(bounds);
    ctx.settings.update({ appearance: { language: "en" } });
    wc.reload();
  }
  const titles = { en: "Last backup: today", es: "Última copia: hoy" };
  const good = Object.entries(audits).every(([key, a]) => a !== null && a.aligned && !a.caption && a.title === titles[key.slice(0, 2) as "en" | "es"]);
  check("Passwords header: the buttons line up, nothing under Back up now, the last backup is its tooltip (EN/ES, wide/480 px)", good, audits);
}

/**
 * The backup reminder and Back up now: the bar shows when a backup is due, Later and Don't remind me
 * are kept, a big change makes it due at once, and a backup from the Passwords page (the KeePass
 * export, with 2FA) is recorded and stops it. Never in a private window.
 */
export async function runBackupSmoke(ctx: AppContext, { win, check, capture }: Helpers): Promise<void> {
  const profile = win.profile;
  const chrome = win.chrome.webContents;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "corvus-backup-smoke-"));
  const added = profile.credentials.all().length === 0
    ? [
        profile.credentials.add({ origin: "https://backup.example.com", username: "backup-smoke@example.com", password: "pw-backup" }).id,
        profile.credentials.add({ origin: "https://backup.example.com", username: "backup-smoke@example.com", password: "", totp: { secret: "JBSWY3DPEHPK3PXPJBSWY3DP", algorithm: "SHA1", digits: 6, period: 30 } }).id,
      ]
    : [];
  const bar = (): Promise<boolean> => js<boolean>(chrome, `[...document.querySelectorAll("[data-dialog-bar]")].some((b) => b.textContent.includes(${JSON.stringify(MESSAGE)}))`).then(Boolean);
  const press = (label: string): Promise<unknown> =>
    js(chrome, `(() => { const b = [...document.querySelectorAll("[data-dialog-bar]")].find((x) => x.textContent.includes(${JSON.stringify(MESSAGE)})); const btn = b && [...b.querySelectorAll("button")].find((x) => x.textContent === ${JSON.stringify(label)}); btn?.click(); return Boolean(btn); })()`);
  const gone = (): Promise<boolean> => until(async () => !(await bar()), 5000);
  const remind = (): Promise<void> => {
    ctx.backupReminder.resetLaunch();
    return ctx.backupReminder.remind(win);
  };
  const showSaveDialog = dialog.showSaveDialog;
  try {
    ctx.settings.update({ passwords: { backupReminder: true } });
    // Never over a tab an AI agent drives: the person's own tab is in front.
    const agentTab = win.activeTab();
    if (agentTab?.agentControlled) {
      ctx.backupReminder.resetLaunch();
      await ctx.backupReminder.remind(win);
      check("backup reminder: never over a tab an AI agent drives", !(await bar()));
    }
    win.createTab("corvus://newtab/");
    // A backup 40 days old, and changes since.
    profile.backup.recordBackup(Date.now() - 40 * DAY);
    profile.backup.noteChange();

    let answered = remind();
    const shown = await until(bar);
    for (const theme of ["light", "dark"] as const) {
      nativeTheme.themeSource = theme;
      await sleep(400);
      await capture(`backup-reminder-bar-${theme}`, chrome);
    }
    nativeTheme.themeSource = "system";
    await press("Later");
    await answered;
    await gone();
    const snoozed = profile.backup.state().snoozedUntil;
    const kept = new BackupStore(profile.dataDir).state().snoozedUntil;
    check("backup reminder: the bar shows when a backup is old and the vault changed, and Later waits a week", shown && snoozed > Date.now() + BACKUP_SNOOZE_MS - 60_000 && kept === snoozed, { shown, snoozed, kept });

    await remind();
    check("backup reminder: nothing is asked while Later holds", !(await bar()) && !ctx.backupReminder.due(win));

    // An import of 10 or more logins: due at once.
    profile.backup.noteBigChange();
    answered = remind();
    const big = await until(bar);
    await press("Don't remind me");
    await answered;
    await gone();
    await remind();
    check("backup reminder: a big change asks at once, and Don't remind me turns it off", big && ctx.settings.get().passwords.backupReminder === false && !(await bar()), { big });

    ctx.settings.update({ passwords: { backupReminder: true } });
    const pw = ctx.windows.openPrivate(profile.profile.id, []);
    await sleep(500);
    ctx.backupReminder.resetLaunch();
    await ctx.backupReminder.remind(pw);
    const inPrivate = await js<boolean>(pw.chrome.webContents, `document.querySelectorAll("[data-dialog-bar]").length > 0`);
    pw.close();
    check("backup reminder: never in a private window", inPrivate === false);

    // Back up now opens the Passwords page on the backup form.
    answered = remind();
    await until(bar);
    await press("Back up now");
    await answered;
    await gone();
    const page = win.activeTab();
    const wc = page?.view.webContents;
    const opened = Boolean(wc) && (await until(() => js<boolean>(wc!, `Boolean(document.querySelector(".pw-backup-card .kp-export input"))`).then(Boolean)));
    const captionOf = (): Promise<string | null> => (wc ? js<string>(wc, `document.querySelector(".pw-backup-when")?.textContent ?? ""`) : Promise.resolve(null));
    await until(async () => (await captionOf()) === "Last backup: 40 days ago", 5000);
    const caption = await captionOf();
    check("Back up now opens the Passwords page on the backup form", opened && page?.url.startsWith("corvus://passwords") === true && caption === "Last backup: 40 days ago", { url: page?.url, caption });
    if (!wc) return;
    for (const theme of ["light", "dark"] as const) {
      nativeTheme.themeSource = theme;
      await sleep(400);
      await capture(`backup-form-${theme}`, wc);
    }
    nativeTheme.themeSource = "system";

    // The export from the form, to a file the save dialog answers with: recorded, and nothing is due.
    const file = path.join(dir, "Corvus passwords.kdbx");
    dialog.showSaveDialog = (async () => ({ canceled: false, filePath: file })) as typeof dialog.showSaveDialog;
    await js(wc, `(() => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
      for (const input of document.querySelectorAll(".pw-backup-card .kp-export input")) { set.call(input, "smoke-backup-1"); input.dispatchEvent(new Event("input", { bubbles: true })); }
      return true;
    })()`);
    await sleep(200);
    await js(wc, `document.querySelector(".pw-backup-card .kp-export .btn.primary").click()`);
    const exported = await until(() => js<boolean>(wc, `/Exported \\d+ logins/.test(document.querySelector(".pw-backup-card")?.textContent ?? "") && document.querySelector(".pw-backup-when")?.textContent === "Last backup: today"`).then(Boolean), 30_000);
    const db = fs.existsSync(file) ? await openKdbx(new Uint8Array(fs.readFileSync(file)), "smoke-backup-1", null) : null;
    const withTotp = profile.credentials.all().filter((c) => c.totp).length;
    check(
      "Back up now writes every login and its 2FA, and the page says when",
      exported && db?.entries.length === profile.credentials.all().length && db.entries.filter((e) => e.totp).length === withTotp,
      { exported, entries: db?.entries.length, withTotp },
    );
    await capture("backup-done", wc);
    await headerSmoke(ctx, win, wc, { check, capture });
    profile.backup.noteBigChange();
    profile.backup.recordBackup();
    await remind();
    check("backup reminder: a backup stops it", !(await bar()) && !ctx.backupReminder.due(win) && profile.backup.state().lastBackupAt !== null);
  } finally {
    dialog.showSaveDialog = showSaveDialog;
    nativeTheme.themeSource = "system";
    ctx.backupReminder.resetLaunch();
    for (const id of added) profile.credentials.remove(id);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
