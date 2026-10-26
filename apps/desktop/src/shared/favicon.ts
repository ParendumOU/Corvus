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
export function faviconSrcToShow(src: string | undefined, failed: readonly string[], pageUrl = "", siteIcon = true): string | undefined {
  if (!src) return undefined;
  const origin = siteIcon ? originOf(pageUrl) : null;
  return [src, origin ? `${origin}/favicon.ico` : undefined].find((c): c is string => c !== undefined && !failed.includes(c));
}

/** The site a page is on (scheme, host and port), for icons kept per site; null for other schemes. */
export function faviconOrigin(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:" ? u.origin : null;
  } catch {
    return null;
  }
}

/** The image type of an icon file from its first bytes, or null when it is not an image. */
export function sniffImageType(bytes: Uint8Array): string | null {
  const at = (i: number): number => bytes[i] ?? -1;
  if (at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47) return "image/png";
  if (at(0) === 0x00 && at(1) === 0x00 && (at(2) === 0x01 || at(2) === 0x02) && at(3) === 0x00) return "image/x-icon";
  if (at(0) === 0x47 && at(1) === 0x49 && at(2) === 0x46) return "image/gif";
  if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return "image/jpeg";
  if (at(0) === 0x52 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x46 && at(8) === 0x57 && at(9) === 0x45 && at(10) === 0x42 && at(11) === 0x50) return "image/webp";
  const head = new TextDecoder().decode(bytes.subarray(0, 256)).trimStart().toLowerCase();
  if (head.startsWith("<svg") || (head.startsWith("<?xml") && head.includes("<svg"))) return "image/svg+xml";
  return null;
}

/**
 * The address Corvus's own UI loads a site's icon from (main/favicon-cache.ts). Pages in a profile
 * get their profile's icons; the browser UI, which runs outside the profiles, names one.
 */
export function cachedFaviconUrl(pageUrl: string, profileId?: string): string {
  return `corvus://favicon/?url=${encodeURIComponent(pageUrl)}${profileId ? `&profile=${encodeURIComponent(profileId)}` : ""}`;
}
