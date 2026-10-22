/**
 * After Corvus fills a saved password or 2FA code into a tab (agent fill_login / fill_totp, autofill,
 * auto sign-in), that tab is locked against tools that run script in the page or return raw page
 * content (evaluate, raw HTML or text reads, run_workflow), for every agent and every access level.
 * The filled value sits in the page DOM, so those tools could read it back. The lock lifts when the
 * tab's main frame navigates to a new document (did-navigate), which drops the filled form.
 *
 * Tools that only read the masked snapshot (page_snapshot, screenshot) or act (click, type) stay
 * available, so an agent can still press "Sign in" after a fill.
 *
 * WebScope uses the same guard to mark captured requests "hidden from AI": requests sent from a
 * locked tab, and requests that carry a value Corvus filled in the last few minutes (kept in memory
 * only, never written anywhere), so AI clients get them redacted while people see them in full.
 */

/** How long filled values are remembered to recognise them in captured traffic. */
const RECENT_MS = 10 * 60_000;
/** Shorter values would match unrelated traffic too often. */
const MIN_VALUE_LENGTH = 4;
const MAX_RECENT = 50;

/** The forms a filled value takes on the wire: raw, URL-encoded, form-encoded and JSON-escaped. */
function encodings(value: string): string[] {
  const url = encodeURIComponent(value);
  return [...new Set([value, url, url.replace(/%20/g, "+"), JSON.stringify(value).slice(1, -1)])];
}

export interface RequestLike {
  url: string;
  headers: Array<{ name: string; value: string }>;
  body?: string;
  bodyBase64?: boolean;
}

export const SECRET_FILL_LOCK_MESSAGE =
  "Corvus filled a saved password or 2FA code into this tab, so tools that run scripts in the page or read raw page content are blocked here until the page navigates to a new document. Use page_snapshot, click and type (the filled values stay hidden), navigate to another page, or ask the user.";

export class SecretFillGuard {
  /** Locked tab ids and when they were locked. */
  private readonly locked = new Map<string, number>();
  /** Values filled recently (memory only), with when they were filled. */
  private recent: Array<{ forms: string[]; at: number }> = [];

  /**
   * Lock a tab: a secret is about to be (or was just) filled into it. `values` are the secrets being
   * filled, remembered briefly so WebScope can recognise them in captured requests.
   */
  mark(tabId: string, values: string[] = []): void {
    this.locked.set(tabId, Date.now());
    this.prune();
    for (const value of values) {
      if (value.length < MIN_VALUE_LENGTH) continue;
      this.recent.push({ forms: encodings(value), at: Date.now() });
    }
    if (this.recent.length > MAX_RECENT) this.recent = this.recent.slice(-MAX_RECENT);
  }

  private prune(now = Date.now()): void {
    this.recent = this.recent.filter((r) => now - r.at < RECENT_MS);
  }

  /** True when the text contains a value filled in the last few minutes, in any wire form. */
  containsFilledValue(text: string): boolean {
    this.prune();
    return this.recent.some((r) => r.forms.some((form) => text.includes(form)));
  }

  /** WebScope: hide this request from AI (sent from a locked tab, or carrying a filled value)? */
  isSensitiveRequest(tabId: string | null, request: RequestLike): boolean {
    if (tabId && this.locked.has(tabId)) return true;
    if (this.recent.length === 0) return false;
    const parts = [request.url, ...request.headers.map((h) => h.value)];
    if (request.body !== undefined && !request.bodyBase64) parts.push(request.body);
    return this.containsFilledValue(parts.join("\n"));
  }

  /** Lift the lock (new document in the main frame, nothing filled after all, or the tab closed). */
  clear(tabId: string): boolean {
    return this.locked.delete(tabId);
  }

  isLocked(tabId: string): boolean {
    return this.locked.has(tabId);
  }

  /** The refusal message for a locked tab, or null when script access is allowed. */
  check(tabId: string): string | null {
    return this.locked.has(tabId) ? SECRET_FILL_LOCK_MESSAGE : null;
  }
}
