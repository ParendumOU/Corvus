/**
 * IPC contracts for the password manager: the corvus://passwords management page (InternalRpc) and
 * the autofill controls in the browser chrome (ChromeRpc). Passwords only ever leave the main process
 * on an explicit reveal/fill call; the page shows masked summaries until the user asks.
 */
import type { AddressRole } from "./address-fields";
import type { AddressFields, AutofillAddress } from "./addresses";
import type { CardCaptureRole, CardFields, CardSummary } from "./cards";
import type { AuthenticatorImportResult, AuthenticatorPick, AuthenticatorPreview, PhotoReport } from "./authenticator-import";
import type { CredentialMatch, CredentialSummary, PasswordOptions } from "./credentials";
import type { PasswordCheckupView } from "./password-health";
import type { ClassFlags, GeneratorNote, PasswordClass, PasswordFieldClick } from "./password-rules";
import type { UiLanguage } from "./settings";
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
  /** When the saved logins were last backed up (a KeePass export), null when never. */
  "credentials.backupState"(): { lastBackupAt: number | null };
  /** The global "Let AI agents use logins you opt in" setting (off by default). */
  "credentials.agentAccess"(): boolean;
  /** Ids (vault or KeePass) of logins that sign in automatically after a confirmation. */
  "credentials.autoSignInIds"(): string[];
  "credentials.setAutoSignIn"(id: string, on: boolean): string[];
  /** Hosts where the save-password prompt is never offered ("Never for this site"), oldest first. */
  "credentials.neverSaved"(): string[];
  /** Offers to save passwords on a host again; the list as it is now. */
  "credentials.removeNeverSaved"(host: string): string[];
  /** Breached, reused and weak saved passwords, as last checked this session (no network). */
  "credentials.checkup"(): PasswordCheckupView;
  /** Checks every saved password against known data breaches now (k-anonymity: 5 hash characters leave). */
  "credentials.runCheckup"(): PasswordCheckupView;
  /** Saved addresses, most recently used first. */
  "addresses.list"(): AutofillAddress[];
  /** Adds an address, or changes the one with `id`; null when it holds nothing worth keeping or is gone. */
  "addresses.save"(input: { id?: string; fields: AddressFields }): AutofillAddress | null;
  "addresses.remove"(id: string): boolean;
  /** Saved payment cards, most recently used first, without their numbers (only brand and last digits). */
  "cards.list"(): CardSummary[];
  /** Adds a card, or changes the one with `id` (an empty number keeps the saved one). Never a CVV. */
  "cards.save"(input: { id?: string; fields: CardFields }): CardSummary;
  "cards.remove"(id: string): boolean;
  /** The full number of a saved card, for the page to show once the person confirmed. */
  "cards.reveal"(id: string): string;
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
  /** A sent address form is waiting for the choice to save it as a new address or update a saved one: what the prompt shows. */
  addressSave: { id: number; kind: "new" | "update"; line: string } | null;
  /** The address prompt was never shown for that form: it opens by itself, once. */
  addressPrompt: boolean;
  /** A sent card form (number, name and expiry, never a CVV) is waiting for the choice to save it as a new card or update a saved one: what the prompt shows. */
  cardSave: { id: number; kind: "new" | "update"; line: string } | null;
  /** The card prompt was never shown for that form: it opens by itself, once. */
  cardPrompt: boolean;
  /** The save prompt was never shown for the pending save: it opens by itself, once. */
  savePrompt: boolean;
}

export const EMPTY_AUTOFILL: AutofillBarState = { available: false, matchCount: 0, otpAvailable: false, canSave: false, saveId: 0, savePrompt: false, addressSave: null, addressPrompt: false, cardSave: null, cardPrompt: false };

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

/** The current 2FA code of one of the page's accounts (by its id), for the key panel. */
export interface AutofillCode {
  id: string;
  code: string;
  /** Epoch milliseconds at which the next code takes over. */
  expiresAt: number;
}

export interface AutofillChromeRpc {
  "autofill.suggestions"(): CredentialMatch[];
  "autofill.fill"(id: string): void;
  /** Fills the current 2FA code of a login into the page's one-time-code field (user click only). */
  "autofill.fillTotp"(id: string): void;
  /** Current codes of the page's accounts with a 2FA, only while the page has a one-time-code field. */
  "autofill.codes"(): AutofillCode[];
  /** Copies the current 2FA code of a page's account to the clipboard (user click only); false when it has none. */
  "autofill.copyTotp"(id: string): boolean;
  /** The active tab's pending save, with its password, for the prompt opening now; the prompt counts as shown. */
  "autofill.savePending"(): PendingSaveView | null;
  "autofill.saveAccept"(edit: SaveEdit): void;
  "autofill.saveDismiss"(id: number): void;
  /** "Never for this site": drops the pending save and never offers to save on its host again. */
  "autofill.saveNever"(id: number): void;
  /** The address prompt is opening for the pending address with this id: it no longer opens by itself. */
  "autofill.addressSaveShown"(id: number): void;
  /** Saves the pending address: a new one, or the fields it holds over the saved one it updates. */
  "autofill.addressSaveAccept"(id: number): void;
  "autofill.addressSaveDismiss"(id: number): void;
  /** The same for a sent card form (number, name and expiry; never a CVV). */
  "autofill.cardSaveShown"(id: number): void;
  "autofill.cardSaveAccept"(id: number): void;
  "autofill.cardSaveDismiss"(id: number): void;
  "autofill.openManager"(): void;
}

/** One-way channel: the tab preload reports a submitted login so the main process can offer to save it. */
export const AUTOFILL_CAPTURE_CHANNEL = "corvus:autofill-captured";

/**
 * One-way channel: the tab preload reports the username typed on a two-step sign-in's first step, as
 * it is sent or left changed (the next step may ask only for the password; the save prompt names it).
 */
export const AUTOFILL_IDENTIFIER_CHANNEL = "corvus:autofill-identifier";

export interface CapturedIdentifier {
  origin: string;
  username: string;
}

/**
 * One-way channel: the tab preload reports a click in a login field or a one-time-code field (which
 * kind, its box in CSS pixels of the page's viewport and, for a password field, its part in its form
 * and what it takes, never its value) so the main process can list the saved accounts under it, and
 * suggest a strong password or copy the one typed.
 */
export const AUTOFILL_FIELD_CHANNEL = "corvus:autofill-field";

/** A username or password field ("login"), a field for a 2FA code ("otp"), a field of an address form ("address") or of a card form ("card"). */
export type AutofillFieldKind = "login" | "otp" | "address" | "card";

export interface FieldClick {
  kind: AutofillFieldKind;
  x: number;
  y: number;
  width: number;
  height: number;
  /** A password field's facts (absent for other fields). */
  password?: PasswordFieldClick;
}

export interface CapturedSubmit {
  origin: string;
  username: string;
  password: string;
}

// ------------------------------------------------------------------ account dropdown under a field (see field-dropdown.ts)

/** Main -> dropdown view: the state to draw, or null when it closed. */
export const FIELD_MENU_EVENT = "corvus:field-menu-event";
/** Dropdown view -> main: its size, or the entry the mouse is over or pressed. */
export const FIELD_MENU_ACTION = "corvus:field-menu-action";
/** Main -> tab preload: whether the dropdown is open under one of the page's fields. */
export const AUTOFILL_DROPDOWN_CHANNEL = "corvus:autofill-dropdown";
/**
 * Tab preload -> main, only while the dropdown is open: the person typed or pasted in the field, the
 * keyboard moved to another part of the page, or the page scrolled. The dropdown closes.
 */
export const AUTOFILL_DROPDOWN_DONE_CHANNEL = "corvus:autofill-dropdown-done";

export interface FieldDropdownState {
  /** Changes every time the dropdown opens, so a size reported for an earlier one is ignored. */
  token: number;
  kind: AutofillFieldKind;
  language: UiLanguage;
  /** The page's registrable domain, which names the section of the other hosts' accounts. */
  domain: string;
  /** Accounts listed first (the page's own host), and those of the domain's other hosts. */
  first: CredentialMatch[];
  others: CredentialMatch[];
  othersOpen: boolean;
  /**
   * Accounts of sites of the page's name under another suffix ("example.com" on "example.es"), in a
   * folded section of their own that names those sites; picking one asks the person first.
   */
  similar: CredentialMatch[];
  similarSites: string;
  similarOpen: boolean;
  /** Width the dropdown may take (the page's width, less its margins). */
  maxWidth: number;
  /** The highlighted entry (see dropdownEntries), moved by the arrow keys and the mouse. */
  highlight: number | null;
  /** "Copy password" for the password field under it, which holds something: "copied" once copied. Null when not offered. */
  copy: "offer" | "copied" | null;
  /** The strong password suggested for the field, null when none is. */
  generator: GeneratorState | null;
  /** Under an address field: the saved addresses (empty otherwise). */
  addresses: AddressOption[];
  /** Under a card field: the saved cards (empty otherwise). */
  cards: AddressOption[];
}

/** A saved address as its dropdown row shows it. */
export interface AddressOption {
  id: string;
  /** Its label or name. */
  title: string;
  /** The first street line and the city. */
  detail: string;
}

/** The suggested password and its generator (opened from the suggestion row), as the dropdown shows them. */
export interface GeneratorState {
  /** The generator's panel takes the dropdown's place. */
  open: boolean;
  password: string;
  /** What it was made with: the person's choices, adapted to the field. */
  options: PasswordOptions;
  /** The lengths the field takes. */
  minLength: number;
  maxLength: number;
  /** Classes the field forbids or asks for: their boxes are not the person's to change. */
  fixed: ClassFlags;
  /** How it adapted to the field. */
  notes: GeneratorNote[];
  /** Its Copy button says "Copied" for a moment. */
  copied: boolean;
}

/** What the dropdown view's preload exposes to it (window.corvusFieldMenu). */
export interface FieldMenuBridge {
  onState(listener: (state: FieldDropdownState | null) => void): () => void;
  send(action: DropdownAction): void;
}

export type DropdownAction =
  | { type: "size"; token: number; width: number; height: number }
  | { type: "hover"; token: number; index: number }
  | { type: "activate"; token: number; index: number }
  /** A press in the view (which then has the keyboard): `keyboard` when it was in the generator's length, which keeps it. */
  | { type: "press"; token: number; keyboard: boolean }
  /** Escape while the view has the keyboard. */
  | { type: "escape"; token: number }
  /** The generator: a new length, a class on or off, a new password, its Copy and Use buttons. */
  | { type: "length"; token: number; length: number }
  | { type: "toggle"; token: number; option: PasswordClass }
  | { type: "regenerate" | "copy" | "use"; token: number };

/** One-way channel: the tab preload reports a sent address form (each field's role and value) so the main process can offer to save it. */
export const AUTOFILL_ADDRESS_CAPTURE_CHANNEL = "corvus:autofill-address-captured";

/** A sent address form, as the tab preload reports it. */
export interface CapturedAddress {
  origin: string;
  fields: { role: AddressRole; value: string }[];
}

/** One-way channel: the tab preload reports a sent card form (number, name and expiry; never the security code) so the main process can offer to save it. */
export const AUTOFILL_CARD_CAPTURE_CHANNEL = "corvus:autofill-card-captured";

/** A sent card form, as the tab preload reports it. */
export interface CapturedCard {
  origin: string;
  fields: { role: CardCaptureRole; value: string }[];
}
