/**
 * "View page source" (Ctrl+U): which pages have a source to show and the address of that view.
 * Chromium shows view-source: of web and file pages only (anything else loads a blank page), and
 * Corvus's own pages have nothing worth reading there: they are an app shell whose content comes
 * over the privileged bridge.
 */

const VIEW_SOURCE = "view-source:";
const SOURCE_PROTOCOLS: ReadonlySet<string> = new Set(["http:", "https:", "file:"]);

export function isViewSourceUrl(url: string): boolean {
  return url.slice(0, VIEW_SOURCE.length).toLowerCase() === VIEW_SOURCE;
}

/** The view-source: address of a page, or null for a page that has none (Corvus pages, a source view, about:, data:...). */
export function viewSourceUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    return SOURCE_PROTOCOLS.has(parsed.protocol) ? `${VIEW_SOURCE}${parsed.href}` : null;
  } catch {
    return null;
  }
}
