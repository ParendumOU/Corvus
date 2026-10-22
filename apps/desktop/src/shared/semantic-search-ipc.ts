/**
 * IPC contracts for local semantic/keyword search over the user's own history, bookmarks and
 * reading library ("find that page about X"). Surfaced two ways:
 *   - the Command Bar (Ctrl/Cmd+K) "Find in my history" section, via a ChromeRpc method
 *   - the corvus://find page, via an InternalRpc method
 * Both return the same hit shape. Merged into ChromeRpc / InternalRpc in ./ipc.ts (append-only there).
 */
import type { IndexDocKind } from "./semantic-search";

export interface SemanticHit {
  id: string;
  kind: IndexDocKind;
  url: string;
  title: string;
  /** Display snippet (window around the match), may be empty. */
  snippet: string;
  /** Last visit / save time, epoch ms. */
  ts: number;
  /** Final blended score (keyword, or keyword+semantic). */
  score: number;
  /** True when embeddings contributed to this hit's rank. */
  semantic: boolean;
}

export interface SemanticSearchResponse {
  hits: SemanticHit[];
  /** How many docs are indexed in this profile. */
  indexed: number;
  /** Whether an embedding endpoint re-ranked the results (false = keyword-only, e.g. offline). */
  usedEmbeddings: boolean;
  /** Set when the user has embeddings turned on but the endpoint was unreachable this query. */
  embeddingError?: string;
}

export interface SemanticSearchStatus {
  indexed: number;
  /** User turned embedding re-rank on in Settings. */
  embeddingsEnabled: boolean;
  embeddingModel: string;
}

/** Command Bar surface (chrome UI). */
export interface SemanticSearchChromeRpc {
  "search.local"(query: string): SemanticSearchResponse;
}

/** corvus://find page surface. */
export interface SemanticSearchInternalRpc {
  "localSearch.query"(query: string, limit: number): SemanticSearchResponse;
  "localSearch.status"(): SemanticSearchStatus;
  "localSearch.open"(url: string, disposition: "current" | "new-tab"): void;
}
