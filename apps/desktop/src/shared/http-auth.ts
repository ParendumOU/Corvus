/**
 * Sites that ask for a username and password (HTTP Basic, Digest or NTLM): what the sign-in dialog
 * shows, and which requests may ask at all. Pure so the rules are unit tested.
 */
/** What the sign-in dialog shows when a site asks for a username and password. */
export interface HttpAuthPrompt {
  /** The site that asks, as people read it ("router.example:8080"). */
  site: string;
  /** The site's own name for what is behind the sign-in ("" when it gives none). */
  realm: string;
  /** Sent over https: otherwise the username and password travel readable. */
  private: boolean;
}

/** The longest realm shown: it comes from the site, which can make it as long as it likes. */
const REALM_MAX = 200;

export function httpAuthPrompt(url: string, realm: string | undefined): HttpAuthPrompt {
  let site = "";
  let secure = false;
  try {
    const parsed = new URL(url);
    site = parsed.host;
    secure = parsed.protocol === "https:";
  } catch {
    // Not a URL Chromium would sign in to: the dialog names no site.
  }
  const name = (realm ?? "").replace(/\s+/g, " ").trim();
  return { site, realm: name.length > REALM_MAX ? `${name.slice(0, REALM_MAX - 3)}...` : name, private: secure };
}

/**
 * Whether a sign-in request may ask the person: a page or frame being opened always may; anything
 * else the page loads (a script's request, an image) only from the page's own site, so another site
 * embedded in it cannot put up a password dialog in its name (Chrome blocks those for images).
 */
export function mayAskSignIn(request: { navigation: boolean; origin: string; topOrigin: string }): boolean {
  return Boolean(request.origin) && (request.navigation || request.origin === request.topOrigin);
}

/** The saved logins a sign-in dialog offers: those with a password, one per username, best first. */
export function signInChoices<T extends { username: string; password: string }>(records: readonly T[]): T[] {
  const seen = new Set<string>();
  return records.filter((r) => {
    const key = r.username.trim().toLowerCase();
    if (!r.password || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
