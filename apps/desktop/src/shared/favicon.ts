/**
 * Favicon rules shared by the main process (which icon a tab keeps, what is saved with the session)
 * and the renderer (which icon a <Favicon> shows). Pure, so they are unit tested.
 */

/** Longest favicon URL written to saved state (session file); bigger data: icons are not persisted. */
export const MAX_SAVED_FAVICON_URL = 8192;

const FAVICON_SCHEME = /^(https?|data):/i;

/** A favicon URL the chrome UI can load as an <img>: web or inline (data:) images only. */
export function isFaviconUrl(value: unknown, maxLength = Number.POSITIVE_INFINITY): value is string {
  return typeof value === "string" && value.length <= maxLength && FAVICON_SCHEME.test(value);
}

/** The icon a tab shows, from the candidates a page reports (Electron's page-favicon-updated). */
export function pickFavicon(candidates: readonly string[]): string | undefined {
  return candidates.find((c) => isFaviconUrl(c));
}

function originOf(url: string): string | null {
  const m = /^(https?:\/\/[^/?#]+)/i.exec(url);
  return m?.[1] ? m[1].toLowerCase() : null;
}

/**
 * Whether a tab keeps its icon when it navigates from `previous` to `next`: within one site it does,
 * until the new page reports its own. A page that never reports one again (served from the
 * back/forward cache, single-page sites) would otherwise be left with the letter placeholder.
 */
export function keepsFavicon(previous: string, next: string): boolean {
  const origin = originOf(next);
  return origin !== null && origin === originOf(previous);
}

/**
 * The src a <Favicon> renders: the page's icon, then the site's /favicon.ico, skipping the URLs
 * that already failed to load. The failure is tied to the URL, not to the component: a tab strip
 * entry stays mounted while its page swaps icons, and a later working icon must not inherit an
 * earlier icon's load error.
 */
export function faviconSrcToShow(src: string | undefined, failed: readonly string[], pageUrl = ""): string | undefined {
  if (!src) return undefined;
  const origin = originOf(pageUrl);
  return [src, origin ? `${origin}/favicon.ico` : undefined].find((c): c is string => c !== undefined && !failed.includes(c));
}
