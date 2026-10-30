/**
 * IPC contracts for the password manager: the corvus://passwords management page (InternalRpc) and
 * the autofill controls in the browser chrome (ChromeRpc). Passwords only ever leave the main process
 * on an explicit reveal/fill call; the page shows masked summaries until the user asks.
 */
import type { AuthenticatorImportResult, AuthenticatorPick, AuthenticatorPreview, PhotoReport } from "./authenticator-import";
import type { CredentialMatch, CredentialSummary, PasswordOptions } from "./credentials";
import type { PasswordCheckupView } from "./password-health";
import type { TotpCode } from "./totp";

export interface RevealedCredential {
  origin: string;
  username: string;
  password: string;
  notes: string;
  /** The 2FA generator as an otpauth:// link, or "" when the login has none. */
  totp: string;
  agentTotp: boolean;
  agentSignIn: boolean;
}

/**
 * Editable fields of a login. `totp` is what the person typed or imported: an otpauth:// link or a
 * base32 secret; "" removes the 2FA generator on update. The main process parses and validates it.
 */
export interface CredentialForm {
  origin: string;
  username: string;
  password: string;
  notes?: string;
  totp?: string;
  agentTotp?: boolean;
  agentSignIn?: boolean;
}

/** Result of importing a 2FA QR code image. */
export type TotpQrImport = { ok: true; uri: string; label: string } | { ok: false; error: string } | null;

export interface CredentialsRpc {
  "credentials.list"(query: string): CredentialSummary[];
  /** Full secret for one login, returned only on an explicit (confirmed) reveal. */
  "credentials.reveal"(id: string): RevealedCredential;
  "credentials.add"(input: CredentialForm): CredentialSummary;
  "credentials.update"(id: string, patch: Partial<CredentialForm>): CredentialSummary;
  "credentials.remove"(id: string): void;
  "credentials.generate"(opts: PasswordOptions): string;
  /** False when no OS keychain is available, so the page can warn that the vault is memory-only. */
  "credentials.persisted"(): boolean;
  /** The current 2FA code of a login (never its secret), or null when it has none. */
  "credentials.totpCode"(id: string): TotpCode | null;
  /** Copies the current 2FA code of a login to the clipboard. */
  "credentials.copyTotp"(id: string): void;
  /** Picks an image file and decodes a 2FA setup QR code from it, locally. Null when cancelled. */
  "credentials.importTotpQr"(): TotpQrImport;
  /** Chooses photos of authenticator QR codes (or a folder of them) for a new import, or adds them to one. Null when cancelled. */
  "credentials.authenticatorPick"(importId: string | null, kind: "files" | "folder"): AuthenticatorPick | null;
  /** Reads one photo of an import, locally: what its QR code held. */
  "credentials.authenticatorRead"(importId: string, index: number): PhotoReport;
  /** The accounts found so far and where each would go, with the sites typed per row id (no secrets). */
  "credentials.authenticatorPreview"(importId: string, sites: Record<string, string>): AuthenticatorPreview;
  /** Imports the selected rows into the vault and ends the import. */
  "credentials.authenticatorImport"(importId: string, sites: Record<string, string>, selected: string[]): AuthenticatorImportResult;
  /** Ends an import without importing; its accounts are forgotten. */
  "credentials.authenticatorDiscard"(importId: string): void;
  /** The global "Let AI agents use logins you opt in" setting (off by default). */
  "credentials.agentAccess"(): boolean;
  /** Ids (vault or KeePass) of logins that sign in automatically after a confirmation. */
  "credentials.autoSignInIds"(): string[];
  "credentials.setAutoSignIn"(id: string, on: boolean): string[];
  /** Breached, reused and weak saved passwords, as last checked this session (no network). */
  "credentials.checkup"(): PasswordCheckupView;
  /** Checks every saved password against known data breaches now (k-anonymity: 5 hash characters leave). */
  "credentials.runCheckup"(): PasswordCheckupView;
}

/** Autofill indicator shown in the omnibox for the active tab. */
export interface AutofillBarState {
  /** A login form or a one-time-code field was detected and at least one saved login can fill it. */
  available: boolean;
  matchCount: number;
  /** A one-time-code field was detected and a matching login has a 2FA generator. */
  otpAvailable: boolean;
  /** Submitted credentials are waiting for the user's choice to save/update. */
  canSave: boolean;
  /** Identifies the pending save (0 when none): the save prompt belongs to one submitted login. */
  saveId: number;
  /** The save prompt was never shown for the pending save: it opens by itself, once. */
  savePrompt: boolean;
}

export const EMPTY_AUTOFILL: AutofillBarState = { available: false, matchCount: 0, otpAvailable: false, canSave: false, saveId: 0, savePrompt: false };

/**
 * The pending save as the save prompt shows it. It carries the submitted password, so it is never part
 * of the window state: the prompt fetches it as it opens and drops it as it closes.
 */
export interface PendingSaveView {
  id: number;
  host: string;
  username: string;
  password: string;
  /** Usernames already saved for the site (no passwords): saving under one of them updates that login. */
  savedUsernames: string[];
}

/** What the person saves from the prompt: the submitted login, possibly edited. */
export interface SaveEdit {
  /** The pending save the prompt was opened for: a save that is no longer pending is not stored. */
  id: number;
  username: string;
  password: string;
}

export interface AutofillChromeRpc {
  "autofill.suggestions"(): CredentialMatch[];
  "autofill.fill"(id: string): void;
  /** Fills the current 2FA code of a login into the page's one-time-code field (user click only). */
  "autofill.fillTotp"(id: string): void;
  /** The active tab's pending save, with its password, for the prompt opening now; the prompt counts as shown. */
  "autofill.savePending"(): PendingSaveView | null;
  "autofill.saveAccept"(edit: SaveEdit): void;
  "autofill.saveDismiss"(id: number): void;
  "autofill.openManager"(): void;
}

/** One-way channel: the tab preload reports a submitted login so the main process can offer to save it. */
export const AUTOFILL_CAPTURE_CHANNEL = "corvus:autofill-captured";

/**
 * One-way channel: the tab preload reports a click in a login field (its box in CSS pixels of the
 * page's viewport, nothing else) so the main process can list the saved logins under it.
 */
export const AUTOFILL_FIELD_CHANNEL = "corvus:autofill-field";

export interface LoginFieldBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CapturedSubmit {
  origin: string;
  username: string;
  password: string;
}
