/** Addresses the system hands the app: shares from other apps and web links Corvus is asked to open. */

/** A web page link (http or https with a host), as another app hands it to Corvus as a browser. */
export function webLink(url: string): string | null {
  const text = url.trim();
  return /^https?:\/\/[^\s/?#]+(?:[/?#].*)?$/is.test(text) ? text : null;
}

/**
 * Where an incoming address goes in the app (expo-router's redirectSystemPath): a share from another
 * app (Android share sheet) to the Send screen, a web link (Corvus as the browser) to the Open
 * screen; anything else, such as corvus:// links, as it is.
 */
export function systemPath(path: string): string {
  if (/^[a-z][a-z0-9+.-]*:\/\/expo-sharing\b/i.test(path)) return '/send';
  const link = webLink(path);
  if (link) return `/open?url=${encodeURIComponent(link)}`;
  return path;
}
