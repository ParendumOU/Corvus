/**
 * IPC contract for KeePass databases on corvus://passwords. Corvus reads .kdbx files and never writes
 * to them; passwords stay in the main process and leave it only on an explicit reveal or copy.
 */
import type { TotpCode } from "./totp";

export type KeePassSourceKind = "file" | "folder";

export interface KeePassSourceView {
  id: string;
  kind: KeePassSourceKind;
  path: string;
  /** Databases this source currently contributes (1 for a file, the .kdbx count for a folder). */
  databases: number;
}

export type KeePassDbStatus = "locked" | "unlocking" | "unlocked" | "missing";

export interface KeePassDbView {
  id: string;
  sourceId: string;
  /** File name without the .kdbx extension. */
  name: string;
  path: string;
  status: KeePassDbStatus;
  /** Last unlock or reload problem, shown next to the database. */
  error: string | null;
  entryCount: number;
  /** The master password is kept (encrypted with the OS keychain) so it unlocks on start. */
  remembered: boolean;
}

export interface KeePassState {
  sources: KeePassSourceView[];
  databases: KeePassDbView[];
  /** False without an OS keychain: "Keep unlocked" is then unavailable (never stored in plain text). */
  canRemember: boolean;
  autoLockMinutes: number;
}

export interface KeePassEntrySummary {
  id: string;
  dbId: string;
  dbName: string;
  title: string;
  username: string;
  /** Host of the first usable URL, or "". */
  site: string;
  group: string;
  hasTotp: boolean;
  agentTotp: boolean;
  agentSignIn: boolean;
}

export type KeePassUnlockResult = { ok: true } | { ok: false; error: string };

/** Export of the built-in vault to a new .kdbx; null when the save dialog was cancelled. */
export type KeePassExportResult = { ok: true; path: string; count: number } | { ok: false; error: string } | null;

export interface KeePassRpc {
  "keepass.state"(): KeePassState;
  /** Opens a file picker for one or more .kdbx files. */
  "keepass.addFiles"(): KeePassState;
  /** Opens a folder picker; the folder is scanned for *.kdbx. */
  "keepass.addFolder"(): KeePassState;
  "keepass.removeSource"(id: string): KeePassState;
  /** Opens a file picker for a key file and returns its path, or null. */
  "keepass.pickKeyFile"(): string | null;
  "keepass.unlock"(dbId: string, password: string, keyFilePath: string | null, keepUnlocked: boolean): KeePassUnlockResult;
  /** Locks one database (null: all) and forgets a kept master password. */
  "keepass.lock"(dbId: string | null): KeePassState;
  "keepass.entries"(query: string): KeePassEntrySummary[];
  /** The password of one entry, only on an explicit (confirmed) reveal. */
  "keepass.reveal"(id: string): string;
  "keepass.copyPassword"(id: string): void;
  "keepass.totpCode"(id: string): TotpCode | null;
  "keepass.copyTotp"(id: string): void;
  /** Agent opt-ins live in Corvus (the database is never written). */
  "keepass.setAgentOptIn"(id: string, optIn: { signIn?: boolean; totp?: boolean }): KeePassEntrySummary | null;
  /** Writes the built-in saved logins (with 2FA) to a new .kdbx protected by `password`. */
  "keepass.export"(password: string): KeePassExportResult;
}
