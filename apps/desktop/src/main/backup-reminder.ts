/**
 * The backup reminder: at most once per launch, a bar under the toolbar of the first window asks the
 * person to back up their logins and 2FA codes when that is due (shared/backup-reminder.ts). Back up
 * now opens the Passwords page on the export; Later asks again in a week; Don't remind me turns the
 * setting off. Never in a private window or over an AI agent's tab, and it shows no secret.
 */
import { backupDue } from "../shared/backup-reminder";
import type { AppContext } from "./context";
import { tr } from "./menu-i18n";
import type { BrowserWindowCtl } from "./window";

/** The Passwords page with its backup form open. */
export const BACKUP_PAGE_URL = "corvus://passwords/#backup";

export class BackupReminder {
  private asked = false;

  constructor(private readonly ctx: AppContext) {}

  /** Smoke tests start a new "launch". */
  resetLaunch(): void {
    this.asked = false;
  }

  /** Whether the reminder is due for this window's profile now. */
  due(win: BrowserWindowCtl, now = Date.now()): boolean {
    const enabled = this.ctx.settings.get().passwords.backupReminder;
    return backupDue(win.profile.backup.state(), { enabled, hasLogins: win.profile.credentials.all().length > 0, now });
  }

  /**
   * Shows the reminder in this window when it is due and has not been shown in this launch. Resolves
   * when the person answers (or at once when nothing is shown).
   */
  async remind(win: BrowserWindowCtl | undefined): Promise<void> {
    if (!win || this.asked || win.isPrivate || win.activeTab()?.agentControlled || !this.due(win)) return;
    this.asked = true;
    const answer = await this.ctx.dialogs.ask(
      {
        tone: "info",
        title: tr("Back up your passwords"),
        message: tr("Back up your passwords and 2FA codes: if this computer fails, a copy is the only way to get them back."),
        buttons: [tr("Back up now"), tr("Later"), tr("Don't remind me")],
        defaultId: 0,
        cancelId: 1,
        bar: true,
      },
      win,
    );
    if (answer.button === 0) win.openSingleton(BACKUP_PAGE_URL);
    else if (answer.button === 2) this.ctx.settings.update({ passwords: { backupReminder: false } });
    else win.profile.backup.snooze();
  }
}
