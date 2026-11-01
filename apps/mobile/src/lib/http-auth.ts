/**
 * Sites that ask for a username and password (HTTP Basic or Digest: a router's or a device's panel,
 * an intranet), on Android: what the sign-in dialog shows, and the username a tab last sent to a
 * site, filled in again when the site refuses it. Pure so it is unit tested.
 */

/** What the sign-in dialog shows. */
export interface SignInPrompt {
  /** The site that asks, as people read it ("router.example:8080"). */
  site: string;
  /** The site's own name for what is behind the sign-in ("" when it gives none). */
  realm: string;
  /** False when the tab's page is the same site over plain http: the username and password travel readable. */
  private: boolean;
}

/** The longest realm shown: it comes from the site, which can make it as long as it likes. */
const REALM_MAX = 200;

/** How long after a sign-in the same site asking again means it refused the username and password. */
export const REFUSED_WITHIN_MS = 60_000;

export function signInPrompt(host: string, realm: string, pageUrl: string): SignInPrompt {
  const name = realm.replace(/\s+/g, ' ').trim();
  let plain = false;
  try {
    const page = new URL(pageUrl);
    plain = page.protocol === 'http:' && page.host.toLowerCase() === host.toLowerCase();
  } catch {
    // No page yet: nothing says the connection is plain.
  }
  return { site: host, realm: name.length > REALM_MAX ? `${name.slice(0, REALM_MAX - 3)}...` : name, private: !plain };
}

/** The usernames tabs sent to sites, by tab, site and realm, to fill in again when a site asks once more. */
export class SignInMemory {
  private readonly sent = new Map<string, { username: string; at: number }>();

  private static key(tabId: string, host: string, realm: string): string {
    return `${tabId}\n${host.toLowerCase()}\n${realm}`;
  }

  remember(tabId: string, host: string, realm: string, username: string, now: number): void {
    this.sent.set(SignInMemory.key(tabId, host, realm), { username, at: now });
  }

  /** The username sent last ("" when none) and whether the site is asking again right after it (it refused them). */
  recall(tabId: string, host: string, realm: string, now: number): { username: string; refused: boolean } {
    const last = this.sent.get(SignInMemory.key(tabId, host, realm));
    if (!last) return { username: '', refused: false };
    return { username: last.username, refused: now - last.at < REFUSED_WITHIN_MS };
  }

  /** Forgets the sign-ins of the tabs that closed (every tab not in `open`). */
  keepTabs(open: ReadonlySet<string>): void {
    for (const key of [...this.sent.keys()]) if (!open.has(key.slice(0, key.indexOf('\n')))) this.sent.delete(key);
  }
}
