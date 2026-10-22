import type { InternalPage } from "../shared/internal-urls";
import type { SemanticSearchChromeRpc, SemanticSearchInternalRpc } from "../shared/semantic-search-ipc";
import type { AppContext } from "./context";
import type { ProfileRuntime } from "./profiles";
import type { BrowserWindowCtl } from "./window";

class IpcError extends Error {}

const MAX_QUERY = 512;
const MAX_RESULT_LIMIT = 50;

function query(value: unknown): string {
  if (typeof value !== "string" || value.length > MAX_QUERY) throw new IpcError("Invalid query");
  return value;
}

function resultLimit(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return 8;
  return Math.max(1, Math.min(MAX_RESULT_LIMIT, Math.floor(n)));
}

type ChromeHandlers<T> = {
  [K in keyof T]: T[K] extends (...args: infer A) => infer R ? (w: BrowserWindowCtl, ...args: A) => R | Promise<Awaited<R>> : never;
};

/** Command Bar "Find in my history" (spread into ChromeRpc handlers). */
export function semanticChromeHandlers(ctx: AppContext): ChromeHandlers<SemanticSearchChromeRpc> {
  return {
    "search.local": (w, q) => ctx.semanticSearch.query(w.profile, query(q), 6),
  };
}

interface InternalContext {
  profile: ProfileRuntime;
  window: BrowserWindowCtl | undefined;
}

type InternalHandlers<T> = {
  [K in keyof T]: T[K] extends (...args: infer A) => infer R ? (c: InternalContext, ...args: A) => R | Promise<Awaited<R>> : never;
};

export const SEMANTIC_INTERNAL_PERMISSIONS: Record<keyof SemanticSearchInternalRpc, readonly InternalPage[]> = {
  "localSearch.query": ["find"],
  "localSearch.status": ["find"],
  "localSearch.open": ["find"],
};

export function semanticInternalHandlers(ctx: AppContext): InternalHandlers<SemanticSearchInternalRpc> {
  return {
    "localSearch.query": (c, q, limit) => ctx.semanticSearch.query(c.profile, query(q), resultLimit(limit)),
    "localSearch.status": (c) => ctx.semanticSearch.status(c.profile),
    "localSearch.open": (c, url, disposition) => {
      if (c.window) c.window.openUrl(query(url), disposition === "new-tab" ? "new-tab" : "current");
    },
  };
}
