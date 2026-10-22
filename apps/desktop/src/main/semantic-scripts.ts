/** Isolated-world script that captures a page's readable text for the local search index. */

/** Dedicated isolated world (distinct from agent 1717 / assist 1719 / reader 1721 / autofill 1723). */
export const SEMANTIC_WORLD_ID = 1725;

/** Characters of raw page text to pull before the caller caps it to the stored snippet length. */
export const CAPTURE_MAX_CHARS = 4000;

/**
 * Returns `{ title, text }` from the live page. Prefers the main article/content region, falls back
 * to the body. Runs read-only in an isolated world, so page scripts cannot see or alter it.
 */
export function capturePageTextScript(max = CAPTURE_MAX_CHARS): string {
  return `(() => {
    try {
      const pick = document.querySelector('main, article, [role="main"]') || document.body;
      const raw = (pick && pick.innerText) || document.body && document.body.innerText || "";
      const text = raw.replace(/\\s+/g, " ").trim().slice(0, ${max});
      return { title: (document.title || "").slice(0, 400), text };
    } catch (e) {
      return { title: "", text: "" };
    }
  })()`;
}

export interface CapturedPage {
  title: string;
  text: string;
}
