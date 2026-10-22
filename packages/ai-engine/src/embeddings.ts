/**
 * Text embeddings from a local / OpenAI-compatible model server, for the desktop's local semantic
 * search re-rank. Same two wire protocols as the chat provider (local.ts):
 *   - "ollama"  -> POST {base}/api/embed            { model, input: string[] } -> { embeddings: number[][] }
 *   - "openai"  -> POST {root}/v1/embeddings        { model, input: string[] } -> { data: [{ embedding }] }
 *
 * This is OPTIONAL everywhere: the caller falls back to keyword-only ranking when no endpoint is
 * configured or the server is unreachable. No API key is required (the local server usually needs none).
 */
import type { LocalModelApi } from "@corvus/shared";
import { type FetchLike, fetchWithTimeout } from "./http.js";
import { normalizeBaseUrl } from "./providers/local.js";

export const DEFAULT_EMBEDDING_MODEL = "nomic-embed-text";
const DEFAULT_TIMEOUT_MS = 30_000;

export interface EmbeddingConfig {
  api: LocalModelApi;
  /** Server root; defaults to the local.ts default for the chosen api when empty. */
  baseUrl?: string;
  model: string;
  /** Bearer token for OpenAI-compatible servers that require one. */
  apiKey?: string;
  timeoutMs?: number;
  /** Injected in tests. */
  fetch?: FetchLike;
}

export class EmbeddingError extends Error {
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "EmbeddingError";
    this.status = status;
  }
}

function headers(cfg: EmbeddingConfig): Record<string, string> {
  const h: Record<string, string> = { "content-type": "application/json" };
  if (cfg.apiKey) h.authorization = `Bearer ${cfg.apiKey}`;
  return h;
}

function openaiRoot(base: string): string {
  return /\/v1$/.test(base) ? base : `${base}/v1`;
}

async function httpError(res: Response, api: LocalModelApi): Promise<EmbeddingError> {
  let detail = "";
  try {
    detail = (await res.text()).slice(0, 300);
  } catch {
    // body unreadable
  }
  return new EmbeddingError(`Embedding server (${api}) returned HTTP ${res.status}${detail ? `: ${detail}` : ""}`, res.status);
}

function toVectors(value: unknown, api: LocalModelApi): number[][] {
  const v = value as { embeddings?: unknown; data?: Array<{ embedding?: unknown }> };
  const rows =
    api === "openai"
      ? (v.data ?? []).map((d) => d.embedding)
      : // Ollama /api/embed returns { embeddings }, the older /api/embeddings returns { embedding }.
        (Array.isArray(v.embeddings) ? v.embeddings : v.embeddings !== undefined ? [v.embeddings] : []);
  const out: number[][] = [];
  for (const row of rows as unknown[]) {
    if (!Array.isArray(row)) continue;
    const nums = row.map((n) => Number(n));
    if (nums.every((n) => Number.isFinite(n))) out.push(nums);
  }
  return out;
}

/**
 * Embed a batch of texts into vectors (same order as the input). Returns [] for an empty input.
 * Throws EmbeddingError on an unreachable/erroring server — the caller degrades to keyword-only.
 */
export async function embedTexts(cfg: EmbeddingConfig, texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const f = cfg.fetch ?? fetch;
  const timeout = cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (cfg.api === "openai") {
    const root = openaiRoot(normalizeBaseUrl(cfg.baseUrl, "openai"));
    const res = await fetchWithTimeout(
      f,
      `${root}/embeddings`,
      { method: "POST", headers: headers(cfg), body: JSON.stringify({ model: cfg.model, input: texts }) },
      timeout,
    );
    if (!res.ok) throw await httpError(res, "openai");
    return toVectors(await res.json(), "openai");
  }
  const base = normalizeBaseUrl(cfg.baseUrl, "ollama");
  const res = await fetchWithTimeout(
    f,
    `${base}/api/embed`,
    { method: "POST", headers: headers(cfg), body: JSON.stringify({ model: cfg.model, input: texts }) },
    timeout,
  );
  if (!res.ok) throw await httpError(res, "ollama");
  return toVectors(await res.json(), "ollama");
}

/** Reachability + model probe for the Settings "Test connection" button (never throws). */
export async function testEmbeddingConnection(cfg: EmbeddingConfig): Promise<{ ok: boolean; dimensions?: number; error?: string }> {
  try {
    const [vec] = await embedTexts(cfg, ["corvus embedding probe"]);
    if (!vec || vec.length === 0) return { ok: false, error: "Server returned no embedding." };
    return { ok: true, dimensions: vec.length };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
