/**
 * What the person's pick of a saved account fills on a page. Picked for the login (a login field's
 * menu, the omnibox key button's list), an account fills the login form and, when the page also asks
 * for a one-time code and the account has a 2FA, its current code too: a page with username, password
 * and verification code in one form is filled by one pick. Picked for the code (a one-time-code
 * field's menu, a "2FA code for" item), it fills the code, and the login form only where its fields
 * are still empty, so what the person typed stays.
 */

/** Where the account was picked: for the login ("account") or for its 2FA code ("code"). */
export type AccountPick = "account" | "code";

export interface AccountFillPlan {
  /** The login form: fill "all" its fields, only the "empty" ones, or "none" (the page has none). */
  login: "all" | "empty" | "none";
  /** Fill the account's current 2FA code into the page's one-time-code field. */
  code: boolean;
}

/** `page` is what the page has now: a login form (`login`) and a one-time-code field (`otp`). */
export function planAccountFill(pick: AccountPick, account: { hasTotp: boolean }, page: { login: boolean; otp: boolean }): AccountFillPlan {
  return {
    login: !page.login ? "none" : pick === "code" ? "empty" : "all",
    code: account.hasTotp && page.otp,
  };
}
