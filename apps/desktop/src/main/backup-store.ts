/**
 * Per-profile record of the backups of the saved logins (backup.json): when the last one was made,
 * whether the vault changed since, and the reminder's "Later". Timestamps and flags only. Local to
 * this device and never synced: a backup made here says nothing about another device's.
 */
import path from "node:path";
import { BACKUP_SNOOZE_MS, EMPTY_BACKUP_STATE, type BackupState } from "../shared/backup-reminder";
import { JsonFile } from "./json-file";

interface BackupFile extends BackupState {
  v: 1;
}

const time = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null);

function revive(raw: unknown): BackupFile {
  const v = (raw ?? {}) as Partial<BackupFile>;
  return {
    v: 1,
    lastBackupAt: time(v.lastBackupAt),
    changedSinceBackup: v.changedSinceBackup === true,
    bigChange: v.bigChange === true,
    snoozedUntil: time(v.snoozedUntil) ?? 0,
  };
}

export class BackupStore {
  private readonly file: JsonFile<BackupFile>;

  constructor(dir: string) {
    this.file = JsonFile.load(path.join(dir, "backup.json"), () => ({ v: 1, ...EMPTY_BACKUP_STATE }), revive, 0);
  }

  state(): BackupState {
    const { v: _v, ...state } = this.file.get();
    return state;
  }

  private patch(patch: Partial<BackupState>): void {
    const current = this.file.get();
    if (Object.entries(patch).every(([k, value]) => current[k as keyof BackupState] === value)) return;
    this.file.set({ ...current, ...patch });
  }

  /** A backup was written: nothing is due until the vault changes and the backup gets old. */
  recordBackup(now = Date.now()): void {
    this.patch({ lastBackupAt: now, changedSinceBackup: false, bigChange: false, snoozedUntil: 0 });
  }

  noteChange(): void {
    this.patch({ changedSinceBackup: true });
  }

  /** An import of many logins: the reminder is due at once. */
  noteBigChange(): void {
    this.patch({ changedSinceBackup: true, bigChange: true });
  }

  /** "Later": ask again in a week (a big change after it asks at once). */
  snooze(now = Date.now()): void {
    this.patch({ snoozedUntil: now + BACKUP_SNOOZE_MS, bigChange: false });
  }

  flush(): void {
    this.file.flush();
  }
}
