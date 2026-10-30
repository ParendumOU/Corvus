export const INTERNAL_SCHEME = "corvus";

/** Internal pages served from the corvus:// protocol. "chrome" is the browser UI itself. */
/** "assist", "agent-overlay", "reader" and "field-menu" render only in their own trusted views, never with tab IPC rights. */
export const INTERNAL_PAGES = ["chrome", "newtab", "search", "settings", "bookmarks", "history", "extensions", "downloads", "assist", "agent-overlay", "webscope", "watches", "schedules", "reader", "reading", "passwords", "pdf", "find", "crash", "cert-error", "devices", "agent-runs", "flows", "welcome", "annotations", "site-profiles", "field-menu"] as const;
export type InternalPage = (typeof INTERNAL_PAGES)[number];

export const NEW_TAB_URL = "corvus://newtab/";

export function internalPageOf(url: string): InternalPage | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== `${INTERNAL_SCHEME}:`) return null;
    const host = parsed.hostname as InternalPage;
    return (INTERNAL_PAGES as readonly string[]).includes(host) ? host : null;
  } catch {
    return null;
  }
}

export function isInternalUrl(url: string): boolean {
  return url.startsWith(`${INTERNAL_SCHEME}:`);
}

export function isNewTabUrl(url: string): boolean {
  return internalPageOf(url) === "newtab";
}

/** Internal pages an MCP agent may open or inspect. Settings and extensions are off limits. */
const AGENT_INTERNAL_PAGES: ReadonlySet<InternalPage> = new Set(["newtab", "search", "history", "bookmarks"]);

/** Whether an AI agent may navigate to (or read) the given URL. */
export function isAgentAllowedUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  switch (parsed.protocol) {
    case "http:":
    case "https:":
      return true;
    case "about:":
      return parsed.href === "about:blank";
    case `${INTERNAL_SCHEME}:`: {
      const page = internalPageOf(url);
      return page !== null && AGENT_INTERNAL_PAGES.has(page);
    }
    default:
      return false;
  }
}

/** URLs that are recorded in browsing history. */
export function isHistoryWorthy(url: string): boolean {
  return url.startsWith("http://") || url.startsWith("https://");
}
