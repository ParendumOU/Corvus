import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BACKUP_MAX_AGE_MS, BACKUP_SNOOZE_MS, EMPTY_BACKUP_STATE, backupDue, daysSince, isBigChange, type BackupState } from "../src/shared/backup-reminder";
import { BackupStore } from "../src/main/backup-store";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 30, 12);
const on = { enabled: true, hasLogins: true, now: NOW };
const state = (patch: Partial<BackupState>): BackupState => ({ ...EMPTY_BACKUP_STATE, ...patch });

describe("backupDue", () => {
  it("is due when never backed up, only with saved logins and the reminder on", () => {
    expect(backupDue(EMPTY_BACKUP_STATE, on)).toBe(true);
    expect(backupDue(EMPTY_BACKUP_STATE, { ...on, hasLogins: false })).toBe(false);
    expect(backupDue(EMPTY_BACKUP_STATE, { ...on, enabled: false })).toBe(false);
  });

  it("is due when the vault changed since a backup older than 30 days", () => {
    expect(backupDue(state({ lastBackupAt: NOW - 31 * DAY, changedSinceBackup: true }), on)).toBe(true);
    expect(backupDue(state({ lastBackupAt: NOW - BACKUP_MAX_AGE_MS, changedSinceBackup: true }), on)).toBe(false);
    expect(backupDue(state({ lastBackupAt: NOW - 400 * DAY, changedSinceBackup: false }), on)).toBe(false);
    expect(backupDue(state({ lastBackupAt: NOW - 5 * DAY, changedSinceBackup: true }), on)).toBe(false);
  });

  it("waits a week after Later, except after a big change", () => {
    const snoozed = state({ snoozedUntil: NOW + 3 * DAY });
    expect(backupDue(snoozed, on)).toBe(false);
    expect(backupDue(snoozed, { ...on, now: NOW + 3 * DAY })).toBe(true);
    expect(backupDue({ ...snoozed, bigChange: true }, on)).toBe(true);
    expect(backupDue(state({ lastBackupAt: NOW - DAY, bigChange: true }), on)).toBe(true);
    expect(backupDue(state({ bigChange: true }), { ...on, enabled: false })).toBe(false);
  });

  it("counts 10 logins as a big change, and whole days", () => {
    expect([isBigChange(9), isBigChange(10), isBigChange(116)]).toEqual([false, true, true]);
    expect([daysSince(NOW, NOW), daysSince(NOW - DAY + 1, NOW), daysSince(NOW - 12 * DAY - 5, NOW), daysSince(NOW + DAY, NOW)]).toEqual([0, 0, 12, 0]);
  });
});

describe("BackupStore", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });
  const tmp = (): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "corvus-backup-"));
    dirs.push(dir);
    return dir;
  };

  it("keeps the backup, changes, Later and big changes on disk, and a backup resets them", () => {
    const dir = tmp();
    const store = new BackupStore(dir);
    expect(store.state()).toEqual(EMPTY_BACKUP_STATE);
    store.noteChange();
    store.snooze(NOW);
    store.flush();
    expect(new BackupStore(dir).state()).toEqual({ lastBackupAt: null, changedSinceBackup: true, bigChange: false, snoozedUntil: NOW + BACKUP_SNOOZE_MS });
    store.noteBigChange();
    store.flush();
    expect(new BackupStore(dir).state()).toMatchObject({ bigChange: true });
    store.recordBackup(NOW);
    store.flush();
    expect(new BackupStore(dir).state()).toEqual({ lastBackupAt: NOW, changedSinceBackup: false, bigChange: false, snoozedUntil: 0 });
    expect(JSON.parse(fs.readFileSync(path.join(dir, "backup.json"), "utf8"))).toEqual({ v: 1, lastBackupAt: NOW, changedSinceBackup: false, bigChange: false, snoozedUntil: 0 });
  });

  it("reads a damaged file as never backed up", () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, "backup.json"), JSON.stringify({ v: 1, lastBackupAt: "yesterday", changedSinceBackup: 1, snoozedUntil: -5 }));
    expect(new BackupStore(dir).state()).toEqual(EMPTY_BACKUP_STATE);
  });
});
