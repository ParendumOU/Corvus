/**
 * IPC contracts for the password manager: the corvus://passwords management page (InternalRpc) and
 * the autofill controls in the browser chrome (ChromeRpc). Passwords only ever leave the main process
 * on an explicit reveal/fill call; the page shows masked summaries until the user asks.
 */
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
  /** Host of the pending save, shown in the prompt. */
  saveHost: string;
  /** The pending save would update an existing login rather than create one. */
  saveUpdates: boolean;
}

export const EMPTY_AUTOFILL: AutofillBarState = { available: false, matchCount: 0, otpAvailable: false, canSave: false, saveHost: "", saveUpdates: false };

export interface AutofillChromeRpc {
  "autofill.suggestions"(): CredentialMatch[];
  "autofill.fill"(id: string): void;
  /** Fills the current 2FA code of a login into the page's one-time-code field (user click only). */
  "autofill.fillTotp"(id: string): void;
  "autofill.saveAccept"(): void;
  "autofill.saveDismiss"(): void;
  "autofill.openManager"(): void;
}

/** One-way channel: the tab preload reports a submitted login so the main process can offer to save it. */
export const AUTOFILL_CAPTURE_CHANNEL = "corvus:autofill-captured";

export interface CapturedSubmit {
  origin: string;
  username: string;
  password: string;
}
