/**
 * IPC contracts for the password manager: the corvus://passwords management page (InternalRpc) and
 * the autofill controls in the browser chrome (ChromeRpc). Passwords only ever leave the main process
 * on an explicit reveal/fill call; the page shows masked summaries until the user asks.
 */
import type { CredentialMatch, CredentialSummary, PasswordOptions } from "./credentials";

export interface RevealedCredential {
  origin: string;
  username: string;
  password: string;
  notes: string;
}

export interface CredentialsRpc {
  "credentials.list"(query: string): CredentialSummary[];
  /** Full secret for one login, returned only on an explicit (confirmed) reveal. */
  "credentials.reveal"(id: string): RevealedCredential;
  "credentials.add"(input: { origin: string; username: string; password: string; notes?: string }): CredentialSummary;
  "credentials.update"(id: string, patch: { origin?: string; username?: string; password?: string; notes?: string }): CredentialSummary;
  "credentials.remove"(id: string): void;
  "credentials.generate"(opts: PasswordOptions): string;
  /** False when no OS keychain is available, so the page can warn that the vault is memory-only. */
  "credentials.persisted"(): boolean;
}

/** Autofill indicator shown in the omnibox for the active tab. */
export interface AutofillBarState {
  /** A login form was detected and at least one saved login matches the page. */
  available: boolean;
  matchCount: number;
  /** Submitted credentials are waiting for the user's choice to save/update. */
  canSave: boolean;
  /** Host of the pending save, shown in the prompt. */
  saveHost: string;
  /** The pending save would update an existing login rather than create one. */
  saveUpdates: boolean;
}

export const EMPTY_AUTOFILL: AutofillBarState = { available: false, matchCount: 0, canSave: false, saveHost: "", saveUpdates: false };

export interface AutofillChromeRpc {
  "autofill.suggestions"(): CredentialMatch[];
  "autofill.fill"(id: string): void;
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
