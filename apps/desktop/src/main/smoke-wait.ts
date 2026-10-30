import type { WebContents } from "electron";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** How long one look at the page may take before it counts as not answering. */
const PROBE_TIMEOUT_MS = 3000;

export interface PageWait {
  ok: boolean;
  /** How long the page took (or how long it was given). */
  ms: number;
  /** On failure, how far the page got: its address, whether it still loads, its document state, the last error. */
  detail: Record<string, unknown>;
}

/**
 * Waits until a page has loaded and `expr` (evaluated in the page) is true, or `timeoutMs` passes.
 * A Corvus page draws its content only after its first calls to the main process answer, and in a
 * full validation the smoke shares the machine with type checks and unit tests: a fixed pause is
 * not enough, so this looks again until the content is there.
 */
export async function waitForPage(wc: WebContents, expr: string, timeoutMs = 20_000): Promise<PageWait> {
  const started = Date.now();
  let detail: Record<string, unknown> = {};
  for (;;) {
    const ms = Date.now() - started;
    if (wc.isDestroyed()) return { ok: false, ms, detail: { ...detail, error: "the page was closed" } };
    if (wc.isLoading()) {
      detail = { loading: true, url: wc.getURL() };
    } else {
      const probe = (await Promise.race([
        wc
          .executeJavaScript(`({ ok: Boolean(${expr}), readyState: document.readyState, url: location.href, bridge: typeof window.corvusInternal })`)
          .catch((err: unknown) => ({ ok: false, error: err instanceof Error ? err.message : String(err) })),
        sleep(PROBE_TIMEOUT_MS).then(() => ({ ok: false, error: `the page did not answer within ${PROBE_TIMEOUT_MS} ms` })),
      ])) as { ok: boolean } & Record<string, unknown>;
      if (probe.ok === true) return { ok: true, ms: Date.now() - started, detail: {} };
      detail = probe;
    }
    if (ms >= timeoutMs) return { ok: false, ms, detail: { ...detail, waitedMs: ms } };
    await sleep(100);
  }
}

/** The same for a Corvus page: its bridge is there and `selector` shows. */
export function waitForInternalPage(wc: WebContents, selector: string, timeoutMs?: number): Promise<PageWait> {
  return waitForPage(wc, `window.corvusInternal && document.querySelector(${JSON.stringify(selector)})`, timeoutMs);
}
