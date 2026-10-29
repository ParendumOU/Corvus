/**
 * Certificate errors: a site whose HTTPS certificate Chromium cannot trust. Corvus shows its own
 * "Your connection is not private" page for them (corvus://cert-error), like Chrome, instead of the
 * blank page Electron leaves, and the address bar says "Not secure".
 */

/** What is wrong with the certificate, as the interstitial explains it. */
export type CertErrorKind =
  | "authority"
  | "expired"
  | "not-yet-valid"
  | "date"
  | "name"
  | "revoked"
  | "weak"
  | "invalid"
  | "transparency"
  | "pinned"
  | "interception"
  | "other";

const KINDS: Readonly<Record<string, CertErrorKind>> = {
  ERR_CERT_AUTHORITY_INVALID: "authority",
  ERR_CERT_SYMANTEC_LEGACY: "authority",
  ERR_CERT_DATE_INVALID: "date",
  ERR_CERT_COMMON_NAME_INVALID: "name",
  ERR_CERT_NAME_CONSTRAINT_VIOLATION: "name",
  ERR_CERT_NON_UNIQUE_NAME: "name",
  ERR_CERT_REVOKED: "revoked",
  ERR_CERT_WEAK_SIGNATURE_ALGORITHM: "weak",
  ERR_CERT_WEAK_KEY: "weak",
  ERR_CERT_INVALID: "invalid",
  ERR_CERT_CONTAINS_ERRORS: "invalid",
  ERR_CERTIFICATE_TRANSPARENCY_REQUIRED: "transparency",
  ERR_SSL_PINNED_KEY_NOT_IN_CERT_CHAIN: "pinned",
  ERR_CERT_KNOWN_INTERCEPTION_BLOCKED: "interception",
};

/** Errors Chrome never lets a person click through (no "Proceed"), whatever the site. */
const FATAL: ReadonlySet<string> = new Set([
  "ERR_CERT_REVOKED",
  "ERR_CERT_INVALID",
  "ERR_CERT_CONTAINS_ERRORS",
  "ERR_SSL_PINNED_KEY_NOT_IN_CERT_CHAIN",
  "ERR_CERT_KNOWN_INTERCEPTION_BLOCKED",
]);

/** Chromium's error name, from certificate-error ("net::ERR_CERT_…") or did-fail-load ("ERR_CERT_…"). */
export function certErrorCode(error: string): string {
  return error.trim().replace(/^net::/, "").toUpperCase();
}

/** Whether a failed load (Chromium net error number) failed on the site's certificate. */
export function isCertNetError(code: number): boolean {
  // 200-299 are certificate errors; a key pin mismatch is one too (net::IsCertificateError).
  return (code <= -200 && code > -300) || code === -150;
}

/** The certificate's validity window, in seconds since the epoch (Electron's Certificate). */
export interface CertValidity {
  start: number;
  expiry: number;
}

/** What is wrong, telling an expired certificate from one not valid yet when the dates are known. */
export function certErrorKind(code: string, validity?: CertValidity, now = Date.now()): CertErrorKind {
  const kind = KINDS[code] ?? "other";
  if (kind !== "date" || !validity) return kind;
  const seconds = now / 1000;
  if (seconds > validity.expiry) return "expired";
  if (seconds < validity.start) return "not-yet-valid";
  return kind;
}

/** Why the interstitial offers no "Proceed": the site uses HSTS, or the error is never overridable. */
export type CertBlockReason = "hsts" | "fatal";

/** Null when the person (or an agent in full auto) may go on to the site anyway. */
export function certBlockReason(code: string, hsts: boolean): CertBlockReason | null {
  if (FATAL.has(code)) return "fatal";
  return hsts ? "hsts" : null;
}

/** The host a certificate exception is for: lower case, no port (Chrome keys them by host too). */
export function certHost(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

/** IP literals never have HSTS (RFC 6797 8.1.1), so there is nothing to ask the network stack. */
export function isIpHost(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.startsWith("[");
}

/** What an AI agent gets back at a certificate error it may not go past by itself. */
export function certAgentError(code: string, host: string, block: CertBlockReason | null): string {
  if (block === "hsts") return `certificate error: ${code} for ${host}; the site uses HSTS, so nobody can proceed to it now.`;
  if (block === "fatal") return `certificate error: ${code} for ${host}; this certificate cannot be accepted, so nobody can proceed to it.`;
  return `certificate error: ${code} for ${host}; the person must choose to proceed. Ask them to decide in that tab (Proceed or Back to safety), then continue.`;
}

/**
 * The certificates a person chose to accept anyway ("Proceed to <host> (unsafe)"): for one session
 * (a profile, a private window or a container), one host and that exact certificate, in memory only,
 * so they end with the session as in Chrome. S is the session object (WeakMap key).
 */
export class CertExceptions<S extends object> {
  private readonly bySession = new WeakMap<S, Map<string, Map<string, string>>>();

  allow(session: S, host: string, fingerprint: string, code: string): void {
    let hosts = this.bySession.get(session);
    if (!hosts) this.bySession.set(session, (hosts = new Map()));
    let certs = hosts.get(host);
    if (!certs) hosts.set(host, (certs = new Map()));
    certs.set(fingerprint, code);
  }

  allows(session: S, host: string, fingerprint: string): boolean {
    return Boolean(fingerprint) && this.bySession.get(session)?.get(host)?.has(fingerprint) === true;
  }

  /** The error a host was let through with in this session, or null: its pages say "Not secure". */
  errorFor(session: S, host: string): string | null {
    const certs = this.bySession.get(session)?.get(host);
    return certs && certs.size > 0 ? ([...certs.values()].at(-1) ?? null) : null;
  }

  /** "Turn on warnings again": the host's certificates are no longer accepted in this session. */
  revoke(session: S, host: string): boolean {
    return this.bySession.get(session)?.delete(host) === true;
  }
}
