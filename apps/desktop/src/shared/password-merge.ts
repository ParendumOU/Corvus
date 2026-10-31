/**
 * The one decision path both password imports share (a browser import and a CSV): for each incoming
 * login (origin + username + password, with an optional change date), decide what Corvus does. Pure
 * and unit-tested: the keyed-hash test and the clock are injected, so no crypto or Date here.
 *
 * It never overwrites a login with an older password and never re-adds a password the person changed
 * in Corvus or a login they deleted (see the rules below). The caller (CredentialVault.importLogins)
 * turns the plan into vault changes.
 */
import type { PasswordHistoryEntry } from "./credentials";

/** One login offered to the import, from a browser (dated) or a CSV (usually undated). */
export interface IncomingLogin {
  origin: string;
  username: string;
  password: string;
  /** ms when the browser last changed this password; 0 or undefined when unknown (a CSV). */
  changedAt?: number;
}

/** A live login the merge compares against (its current password is available here). */
export interface MergeLogin {
  id: string;
  origin: string;
  username: string;
  password: string;
  /** ms of the login's last password change in Corvus. */
  changedAt: number;
  passwordHistory?: PasswordHistoryEntry[];
}

/** Memory of a login the person deleted in Corvus: its last passwords, as keyed hashes. */
export interface DeletedLogin {
  origin: string;
  username: string;
  hashes: PasswordHistoryEntry[];
}

/**
 * What the import does with one incoming login. `new`: add it. `updated`: the browser password is
 * newer, so set it on the login and retire the old one. `older`: keep the login, file the browser's
 * password in its history. `history`: the browser still holds a password the login already retired;
 * leave the login alone. `alreadySaved`: identical to a current password. `deletedLeftOut`: matches a
 * login the person deleted in Corvus. `review`: an undated difference the person must confirm.
 */
export type MergeOutcome = "new" | "updated" | "older" | "history" | "alreadySaved" | "deletedLeftOut" | "review";

export interface MergePlan {
  outcome: MergeOutcome;
  /** The login to act on (update for `updated`, file history for `older`), when there is one. */
  targetId?: string;
}

/** How many incoming logins fell into each outcome, for the result the person reads. */
export interface ImportTally {
  /** New logins added. */
  added: number;
  /** Logins whose password the browser's newer one replaced. */
  updated: number;
  /** Identical to a password already saved. */
  alreadySaved: number;
  /** An old or older password; the login was left as it was. */
  olderLeftAlone: number;
  /** Matched a login the person deleted in Corvus; left out. */
  deletedLeftOut: number;
}

export const emptyTally = (): ImportTally => ({ added: 0, updated: 0, alreadySaved: 0, olderLeftAlone: 0, deletedLeftOut: 0 });

/** An undated difference the person is asked to confirm (site and username only, never a password). */
export interface ImportReviewItem {
  origin: string;
  username: string;
}

export interface MergeContext {
  /** Live logins saved for the incoming origin, any username. */
  loginsForOrigin: readonly MergeLogin[];
  /** Deletion memory for the incoming origin, any username. */
  deletionsForOrigin: readonly DeletedLogin[];
  /** True when `password` matches any of the keyed-hash entries. */
  hashMatches: (entries: readonly PasswordHistoryEntry[], password: string) => boolean;
}

const dated = (at: number | undefined): boolean => typeof at === "number" && Number.isFinite(at) && at > 0;

/** Decides what to do with one incoming login. See MergeOutcome. */
export function planImport(incoming: IncomingLogin, ctx: MergeContext): MergePlan {
  const exact = ctx.loginsForOrigin.find((l) => l.username === incoming.username);
  if (exact) {
    if (exact.password === incoming.password) return { outcome: "alreadySaved", targetId: exact.id };
    if (ctx.hashMatches(exact.passwordHistory ?? [], incoming.password)) return { outcome: "history", targetId: exact.id };
    // A difference: the dates decide which password is the newer one.
    if (dated(incoming.changedAt) && dated(exact.changedAt)) {
      return incoming.changedAt! > exact.changedAt ? { outcome: "updated", targetId: exact.id } : { outcome: "older", targetId: exact.id };
    }
    // No usable date (a CSV, or the browser left the field at 0): never overwrite, ask the person.
    return { outcome: "review", targetId: exact.id };
  }

  // No login for this exact username. A blank-username row never makes a second entry with a password
  // the origin already holds under some username.
  if (incoming.username === "" && ctx.loginsForOrigin.some((l) => l.password === incoming.password)) {
    return { outcome: "alreadySaved" };
  }

  const deleted = ctx.deletionsForOrigin.find((d) => d.username === incoming.username);
  if (deleted && ctx.hashMatches(deleted.hashes, incoming.password)) return { outcome: "deletedLeftOut" };
  return { outcome: "new" };
}
