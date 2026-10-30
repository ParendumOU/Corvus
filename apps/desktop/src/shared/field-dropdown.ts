/**
 * The account dropdown under a login or one-time-code field, like Chrome's autofill dropdown: Corvus
 * draws it in a small view of its own over the page, and the page keeps the keyboard (typing, pasting,
 * Ctrl+A go to the field). The main process owns its state and pushes it to the view; the view only
 * draws it and reports the person's mouse. Pure helpers, shared by both and unit-tested.
 */
import { accountDetails, LABEL_SEPARATOR, middleEllipsis, type CredentialMatch } from "./credentials";
import type { AutofillFieldKind, DropdownAction, FieldDropdownState } from "./credentials-ipc";

/** Room kept around the dropdown inside its view, for its shadow. */
export const DROPDOWN_MARGIN = 8;
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
