/**
 * The account dropdown under a login or one-time-code field, like Chrome's autofill dropdown: Corvus
 * draws it in a small view of its own over the page, and the page keeps the keyboard (typing, pasting,
 * Ctrl+A go to the field). The main process owns its state and pushes it to the view; the view only
 * draws it and reports the person's mouse. Pure helpers, shared by both and unit-tested.
 */
import { accountDetails, LABEL_SEPARATOR, middleEllipsis, type CredentialMatch } from "./credentials";
import type { AutofillFieldKind, DropdownAction, FieldDropdownState } from "./credentials-ipc";

/** Space between the field and the dropdown. */
export const DROPDOWN_GAP = 2;
/** Width of the dropdown itself (narrower when the page is). */
export const DROPDOWN_WIDTH = 360;
/** Longest username or site a row shows in full; longer ones are cut in the middle. */
export const DROPDOWN_LABEL_MAX = 40;

export type DropdownEntry = { type: "account"; account: CredentialMatch } | { type: "others" } | { type: "manage" };

/** What the dropdown lists, top to bottom: the first accounts, the folded section and its accounts when open, "Manage passwords". */
export function dropdownEntries(state: Pick<FieldDropdownState, "first" | "others" | "othersOpen">): DropdownEntry[] {
  const account = (m: CredentialMatch): DropdownEntry => ({ type: "account", account: m });
  return [
    ...state.first.map(account),
    ...(state.others.length > 0 ? [{ type: "others" } as const] : []),
    ...(state.othersOpen ? state.others.map(account) : []),
    { type: "manage" },
  ];
}

/** The next entry down (1) or up (-1), wrapping around; the first or the last when none is highlighted. */
export function moveHighlight(current: number | null, delta: 1 | -1, count: number): number | null {
  if (count <= 0) return null;
  if (current === null || current < 0 || current >= count) return delta > 0 ? 0 : count - 1;
  return (current + delta + count) % count;
}

/** A box in the window, in pixels. */
export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Where the dropdown's view goes in the window (the view is exactly the dropdown's box, so the page
 * around it keeps its clicks): right under the field, or over it when there is no room below and
 * there is above; inside the page's area, cut to it when taller or wider.
 */
export function dropdownBounds(field: Box, size: { width: number; height: number }, area: Box): Box {
  const below = field.y + field.height + DROPDOWN_GAP;
  const above = field.y - size.height - DROPDOWN_GAP;
  const y = Math.max(area.y, below + size.height <= area.y + area.height || above < area.y ? below : above);
  const x = Math.max(area.x, Math.min(field.x, area.x + area.width - size.width));
  return { x, y, width: Math.min(size.width, area.width), height: Math.min(size.height, Math.max(0, area.y + area.height - y)) };
}

/**
 * Whether the open dropdown stays as the window lays out its views again: only while the page it
 * opened over is the active tab's, shown, where it was. A tab switch, a split view, the sidebar or
 * the Assist panel close it, even when the keyboard stays where it was.
 */
export function dropdownStays(page: { active: boolean; visible: boolean; bounds: Box }, openedOver: Box): boolean {
  const b = page.bounds;
  return page.active && page.visible && b.x === openedOver.x && b.y === openedOver.y && b.width === openedOver.width && b.height === openedOver.height;
}

/** The accounts the dropdown lists under a field: all of the page's under a login field, those with a 2FA under a code field. */
export function dropdownAccounts(kind: AutofillFieldKind, matches: CredentialMatch[]): CredentialMatch[] {
  return kind === "login" ? matches : matches.filter((m) => m.hasTotp);
}

/** Whether a page with these fields and saved accounts can show the dropdown (its window then loads the dropdown's view ahead). */
export function dropdownMayOpen(fields: { login: boolean; otp: boolean }, matches: CredentialMatch[]): boolean {
  return (fields.login && dropdownAccounts("login", matches).length > 0) || (fields.otp && dropdownAccounts("otp", matches).length > 0);
}

/** The words a row needs, in the UI's language: t("…") in the dropdown, tr("…") in the main process. */
export interface DropdownWords {
  noUsername: string;
  twoFaOnly: string;
  codeFor: string;
}

/** The two lines of an account's row: the username, and its site and KeePass database (the row tags "2FA only" apart). */
export function dropdownLines(m: CredentialMatch, words: Pick<DropdownWords, "noUsername">): { user: string; details: string } {
  const user = middleEllipsis(m.username || words.noUsername, DROPDOWN_LABEL_MAX);
  return { user, details: accountDetails(m, "").map((d) => middleEllipsis(d, DROPDOWN_LABEL_MAX)).join(LABEL_SEPARATOR) };
}

/** The row tags an account without a password "2FA only", under a login field (under a code field every row is about the code). */
export function dropdownTwoFaOnly(m: CredentialMatch, kind: AutofillFieldKind): boolean {
  return kind === "login" && !m.hasPassword;
}

/** An account's row in one line, as its tooltip and screen readers say it ("2FA code for" the username under a code field). */
export function dropdownLabel(m: CredentialMatch, kind: AutofillFieldKind, words: DropdownWords): string {
  const { user, details } = dropdownLines(m, words);
  return [kind === "otp" ? `${words.codeFor} ${user}` : user, details, dropdownTwoFaOnly(m, kind) ? words.twoFaOnly : ""].filter(Boolean).join(LABEL_SEPARATOR);
}

/** Checks an action from the dropdown view (it is a renderer: never trusted). */
export function parseDropdownAction(raw: unknown): DropdownAction | null {
  if (typeof raw !== "object" || raw === null) return null;
  const v = raw as Record<string, unknown>;
  const int = (n: unknown, max: number): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0 && n <= max;
  if (!int(v.token, Number.MAX_SAFE_INTEGER)) return null;
  if (v.type === "size" && int(v.width, 10_000) && int(v.height, 10_000)) return { type: "size", token: v.token, width: v.width, height: v.height };
  if ((v.type === "hover" || v.type === "activate") && int(v.index, 10_000)) return { type: v.type, token: v.token, index: v.index };
  return null;
}
