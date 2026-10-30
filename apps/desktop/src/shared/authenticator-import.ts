/**
 * Moving 2FA accounts from an authenticator app (Google Authenticator's export QR codes, or plain
 * setup QR codes) into the built-in vault: what each photo held, the accounts merged across photos
 * and exports, and the plan the preview shows (which login each account goes to). Pure and
 * unit-tested; the main process keeps the secrets and the renderer only ever sees `ImportRow`s.
 */
import { originKeyOf } from "./credentials";
import { isMigrationUri, parseMigrationUri, type MigrationSkipReason } from "./authenticator-migration";
import { issuerSite } from "./authenticator-sites";
import { siteOf } from "./tab-organizer";
import { parseOtpauthUri, type TotpConfig } from "./totp";

/** What one photo held. */
export type PhotoStatus =
  /** One QR code of an export. `exportNo` (1-based) tells several exports apart; `again` = already read. */
  | { kind: "batch"; exportNo: number; index: number; size: number; accounts: number; again: boolean }
  /** A site's own setup QR code (otpauth://totp). */
  | { kind: "setup"; issuer: string; account: string; again: boolean }
  | { kind: "none" }
  | { kind: "unreadable" }
  | { kind: "too-large" }
  | { kind: "not-2fa" }
  | { kind: "damaged" };

export interface PhotoReport {
  name: string;
  status: PhotoStatus;
}

/** An account read from the photos. Its secret never leaves the main process. */
export interface ImportAccount {
  id: string;
  issuer: string;
  account: string;
  config: TotpConfig;
}

export interface SkippedAccount {
  issuer: string;
  account: string;
  reason: MigrationSkipReason;
}

/** QR codes of an export that no photo held (1-based numbers). */
export interface MissingCodes {
  exportNo: number;
  size: number;
  missing: number[];
}

/**
 * Collects the decoded QR codes of every photo: each export QR code counts once however many photos
 * show it, and an account found twice (two exports, or an export and a setup code) is kept once.
 */
export class AuthenticatorCollector {
  readonly accounts: ImportAccount[] = [];
  readonly skipped: SkippedAccount[] = [];
  private readonly exports = new Map<number, { exportNo: number; size: number; found: Set<number> }>();
  private readonly seen = new Set<string>();

  /** Reads the text of one QR code and says what it was. */
  add(text: string): PhotoStatus {
    const trimmed = text.trim();
    if (isMigrationUri(trimmed)) {
      let batch;
      try {
        batch = parseMigrationUri(trimmed);
      } catch {
        return { kind: "damaged" };
      }
      let entry = this.exports.get(batch.batchId);
      if (!entry) {
        entry = { exportNo: this.exports.size + 1, size: batch.batchSize, found: new Set() };
        this.exports.set(batch.batchId, entry);
      }
      entry.size = Math.max(entry.size, batch.batchSize);
      const again = entry.found.has(batch.batchIndex);
      if (!again) {
        entry.found.add(batch.batchIndex);
        for (const a of batch.accounts) this.addAccount(a.issuer, a.account, a.config);
        this.skipped.push(...batch.skipped);
      }
      const accounts = batch.accounts.length + batch.skipped.length;
      return { kind: "batch", exportNo: entry.exportNo, index: batch.batchIndex + 1, size: batch.batchSize, accounts, again };
    }
    if (/^otpauth:\/\/totp\//i.test(trimmed)) {
      try {
        const { config, issuer, account } = parseOtpauthUri(trimmed);
        return { kind: "setup", issuer, account, again: !this.addAccount(issuer, account, config) };
      } catch {
        return { kind: "damaged" };
      }
    }
    return { kind: "not-2fa" };
  }

  /** How many exports the photos came from. */
  get exportCount(): number {
    return this.exports.size;
  }

  missing(): MissingCodes[] {
    return [...this.exports.values()]
      .map((e) => ({ exportNo: e.exportNo, size: e.size, missing: Array.from({ length: e.size }, (_, i) => i).filter((i) => !e.found.has(i)).map((i) => i + 1) }))
      .filter((m) => m.missing.length > 0);
  }

  private addAccount(issuer: string, account: string, config: TotpConfig): boolean {
    const key = [config.secret, config.algorithm, config.digits, config.period, issuer.toLowerCase(), account.toLowerCase()].join("\n");
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    this.accounts.push({ id: `a${this.accounts.length + 1}`, issuer, account, config });
    return true;
  }
}

// ------------------------------------------------------------------ plan

/** A vault login as the plan sees it. */
export interface PlanLogin {
  id: string;
  origin: string;
  username: string;
  totp?: TotpConfig;
  updatedAt: number;
}

/**
 * attach: the matched login gets this 2FA. replace: it already has a different one (off by default).
 * same: it already has this one. create: a new login that holds only the 2FA. needs-site: no site
 * known yet, the person types it.
 */
export type ImportAction = "attach" | "replace" | "same" | "create" | "needs-site";

/** One preview row: no secret, only labels and where the account goes. */
export interface ImportRow {
  id: string;
  issuer: string;
  account: string;
  /** Origin the account goes to, "" while unknown. */
  site: string;
  /** What the person typed for the site, or the suggestion from the issuer. */
  siteInput: string;
  action: ImportAction;
  login: { id: string; username: string; origin: string } | null;
  /** Rows with the same target would write the same login: only one of them can be imported. */
  target: string;
  /** Checked when the row is first shown. */
  selected: boolean;
}

/** A typed site ("github.com", "https://github.com/login") as an origin, or "" when it is not one. */
export function siteToOrigin(input: string): string {
  const text = input.trim();
  if (!text) return "";
  const origin = originKeyOf(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
  if (!origin) return "";
  const host = new URL(origin).hostname;
  return host.includes(".") || host === "localhost" ? origin : "";
}

const sameTotp = (a: TotpConfig, b: TotpConfig): boolean => a.secret === b.secret && a.algorithm === b.algorithm && a.digits === b.digits && a.period === b.period;

const lower = (s: string): string => s.trim().toLowerCase();

/** The best of several logins for one account: the exact origin first, then the newest. */
function best(logins: PlanLogin[], origin: string): PlanLogin | undefined {
  return [...logins].sort((a, b) => Number(b.origin === origin) - Number(a.origin === origin) || b.updatedAt - a.updatedAt)[0];
}

/**
 * Where each account goes. A login matches when it is on the same site (registrable domain) as the
 * account's site and has the account's name as its username (case-insensitive). When no username
 * matches and the site has exactly one login that no other account claims, that login is used. Else
 * the account becomes a new login. `sites` holds what the person typed per row id.
 */
export function planImport(accounts: readonly ImportAccount[], logins: readonly PlanLogin[], sites: Readonly<Record<string, string>> = {}): ImportRow[] {
  const bySite = new Map<string, PlanLogin[]>();
  for (const login of logins) {
    const key = siteOf(login.origin);
    if (key) bySite.set(key, [...(bySite.get(key) ?? []), login]);
  }
  const placed = accounts.map((a) => {
    const siteInput = sites[a.id] ?? issuerSite(a.issuer);
    const site = siteToOrigin(siteInput);
    const candidates = site ? (bySite.get(siteOf(site)) ?? []) : [];
    const byName = lower(a.account) ? candidates.filter((l) => lower(l.username) === lower(a.account)) : [];
    return { a, siteInput, site, candidates, login: best(byName, site) };
  });
  const claimed = new Set(placed.flatMap((p) => (p.login ? [p.login.id] : [])));
  // Accounts per site that found no login by name: the single-login fallback needs to be unambiguous.
  const unmatched = new Map<string, number>();
  for (const p of placed) if (p.site && !p.login) unmatched.set(siteOf(p.site), (unmatched.get(siteOf(p.site)) ?? 0) + 1);
  for (const p of placed) {
    const only = p.candidates.length === 1 ? p.candidates[0]! : undefined;
    if (p.site && !p.login && only && !claimed.has(only.id) && unmatched.get(siteOf(p.site)) === 1) p.login = only;
  }

  const taken = new Set<string>();
  return placed.map(({ a, siteInput, site, login }) => {
    const action: ImportAction = !site ? "needs-site" : !login ? "create" : !login.totp ? "attach" : sameTotp(login.totp, a.config) ? "same" : "replace";
    const target = login ? `login:${login.id}` : site ? `new:${site} ${lower(a.account)}` : `row:${a.id}`;
    const selected = (action === "attach" || action === "create") && !taken.has(target);
    if (selected) taken.add(target);
    return {
      id: a.id,
      issuer: a.issuer,
      account: a.account,
      site,
      siteInput,
      action,
      login: login ? { id: login.id, username: login.username, origin: login.origin } : null,
      target,
      selected,
    };
  });
}

/** The rows a person's choices import: known ids, importable actions, one row per target. */
export function rowsToImport(rows: readonly ImportRow[], chosen: ReadonlySet<string>): ImportRow[] {
  const taken = new Set<string>();
  return rows.filter((r) => {
    if (!chosen.has(r.id) || r.action === "needs-site" || r.action === "same" || taken.has(r.target)) return false;
    taken.add(r.target);
    return true;
  });
}

// ------------------------------------------------------------------ photos and IPC

/**
 * Long sides to scale a photo to before looking for its QR code, in order. Phone photos of a screen
 * are large, tilted, noisy and blurred, and which size reads a dense export code differs from photo
 * to photo (each try takes milliseconds): 1600 px reads most, larger sizes rescue a code that fills
 * little of the frame, a smaller one rescues blur. Never more than 4096 px.
 */
export function photoScales(longSide: number): number[] {
  if (longSide <= 1600) return [longSide];
  const sizes = [1600, 2400, 3200, 2000, 2800, 1100, Math.min(longSide, 4096)].filter((s) => s <= longSide);
  return [...new Set(sizes)];
}

/** Photos chosen for an import: names only, the paths stay in the main process. */
export interface AuthenticatorPick {
  importId: string;
  /** Every photo of the import so far, in reading order. */
  names: string[];
  /** How many of them this pick added. */
  added: number;
}

/** What the preview shows: no secret anywhere. */
export interface AuthenticatorPreview {
  rows: ImportRow[];
  skipped: SkippedAccount[];
  missing: MissingCodes[];
  exportCount: number;
}

export interface AuthenticatorImportResult {
  /** Logins that got the 2FA (replacements included). */
  attached: number;
  /** New logins that hold only the 2FA. */
  created: number;
}
