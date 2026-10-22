/**
 * Isolated-world scripts for reader mode. They run in their own world (shared DOM, separate JS
 * globals) so page scripts cannot tamper with them. Kept as plain strings so the bundler cannot
 * rewrite them. The probe mirrors @mozilla/readability's isProbablyReaderable; extraction itself
 * runs in the main process on the grabbed HTML (Readability + linkedom + sanitizer).
 */

/** Isolated world for reader mode (separate from Assist's world and the agent world). */
export const READER_WORLD_ID = 1721;

/** Upper bound on the HTML shipped to the main process for extraction. */
export const GRAB_MAX_CHARS = 3_000_000;

export interface ReaderProbe {
  readerable: boolean;
  title: string;
  lang: string;
}

/** Firefox-style "is this page worth a reader view?" without parsing the whole document. */
export function readerProbeScript(): string {
  return `(() => {
  const MIN_LEN = 140, MIN_SCORE = 20;
  const UNLIKELY = /-ad-|ai2html|banner|breadcrumbs|combx|comment|community|cover-wrap|disqus|extra|footer|gdpr|header|legends|menu|related|remark|replies|rss|shoutbox|sidebar|skyscraper|social|sponsor|supplemental|ad-break|agegate|pagination|pager|popup|yom-remote/i;
  const MAYBE = /and|article|body|column|content|main|shadow/i;
  const visible = (node) => {
    try {
      if (node.style && node.style.display === "none") return false;
      if (node.hasAttribute("hidden")) return false;
      if (node.getAttribute("aria-hidden") === "true" && !(node.className && node.className.includes && node.className.includes("fallback-image"))) return false;
    } catch (e) { return true; }
    return true;
  };
  const nodes = Array.prototype.slice.call(document.querySelectorAll("p, pre, article"));
  document.querySelectorAll("div > br").forEach((br) => { const p = br.parentNode; if (p && nodes.indexOf(p) === -1) nodes.push(p); });
  let score = 0;
  const readerable = nodes.some((node) => {
    if (!visible(node)) return false;
    const match = ((node.className || "") + " " + (node.id || ""));
    if (UNLIKELY.test(match) && !MAYBE.test(match)) return false;
    if (node.matches && node.matches("li p")) return false;
    const len = (node.textContent || "").trim().length;
    if (len < MIN_LEN) return false;
    score += Math.sqrt(len - MIN_LEN);
    return score > MIN_SCORE;
  });
  return { readerable, title: document.title || "", lang: (document.documentElement && document.documentElement.lang) || "" };
})()`;
}

export interface GrabbedPage {
  html: string;
  url: string;
  base: string;
}

/** Captures the page's HTML (capped) and its base URL for main-process extraction. */
export function grabPageHtmlScript(): string {
  return `(() => {
  const MAX = ${GRAB_MAX_CHARS};
  let html = "";
  try { html = document.documentElement ? document.documentElement.outerHTML : ""; } catch (e) { html = ""; }
  if (html.length > MAX) html = html.slice(0, MAX);
  return { html, url: location.href, base: document.baseURI || location.href };
})()`;
}
