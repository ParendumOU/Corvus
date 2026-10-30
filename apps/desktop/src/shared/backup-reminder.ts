/**
 * When to remind the person to back up their logins and 2FA codes (a KeePass export of the vault).
 * Pure, so the rules are unit-tested: the main process keeps the state per profile and shows the
 * reminder at most once per launch.
 */

const DAY_MS = 86_400_000;

/** A backup older than this, with changes since, is due again. */
export const BACKUP_MAX_AGE_MS = 30 * DAY_MS;
/** "Later" asks again after this. */
export const BACKUP_SNOOZE_MS = 7 * DAY_MS;
/** An import or 2FA change of this many logins makes a backup due at once. */
export const BIG_CHANGE_LOGINS = 10;

/** What the profile remembers about its backups (timestamps only, never a secret or a path). */
export interface BackupState {
  /** When the last backup was written, null when never. */
  lastBackupAt: number | null;
  /** The vault changed after the last backup. */
  changedSinceBackup: boolean;
  /** A big change since the last backup (an import of 10 or more logins): due at once. */
  bigChange: boolean;
  /** "Later" was chosen: not before this time (a big change still asks). */
  snoozedUntil: number;
}

export const EMPTY_BACKUP_STATE: BackupState = { lastBackupAt: null, changedSinceBackup: false, bigChange: false, snoozedUntil: 0 };

/**
 * Whether the reminder is due: only with the reminder on and saved logins. Then at once after a big
 * change; else not while "Later" holds; else when never backed up, or when the vault changed since a
 * backup older than 30 days.
 */
export function backupDue(state: BackupState, opts: { enabled: boolean; hasLogins: boolean; now: number }): boolean {
  if (!opts.enabled || !opts.hasLogins) return false;
  if (state.bigChange) return true;
  if (opts.now < state.snoozedUntil) return false;
  if (state.lastBackupAt === null) return true;
  return state.changedSinceBackup && opts.now - state.lastBackupAt > BACKUP_MAX_AGE_MS;
}

/** Logins an import added or changed: a backup is due at once from BIG_CHANGE_LOGINS on. */
export const isBigChange = (logins: number): boolean => logins >= BIG_CHANGE_LOGINS;

/** Whole days since a time (0 on the same day or for a time in the future). */
export const daysSince = (at: number, now: number): number => Math.max(0, Math.floor((now - at) / DAY_MS));
