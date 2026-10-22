import { describe, expect, it } from "vitest";
import { DEFAULT_EMBEDDING_MODEL, EmbeddingError, embedTexts, testEmbeddingConnection } from "../src/embeddings.js";

interface Call {
  url: string;
  body: unknown;
}

function jsonFetch(byUrl: (url: string) => { json?: unknown; status?: number; text?: string }) {
  const calls: Call[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: init.body ? JSON.parse(String(init.body)) : undefined });
    const spec = byUrl(url);
    const status = spec.status ?? 200;
    if (spec.text !== undefined) return new Response(spec.text, { status });
    return new Response(JSON.stringify(spec.json ?? {}), { status });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

describe("embedTexts", () => {
  it("returns [] for empty input without calling the server", async () => {
    const { fn, calls } = jsonFetch(() => ({ json: {} }));
    expect(await embedTexts({ api: "ollama", model: "m", fetch: fn }, [])).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it("posts to ollama /api/embed and parses { embeddings }", async () => {
    const { fn, calls } = jsonFetch(() => ({ json: { embeddings: [[1, 2, 3], [4, 5, 6]] } }));
    const vecs = await embedTexts({ api: "ollama", baseUrl: "http://host:11434", model: "nomic", fetch: fn }, ["a", "b"]);
    expect(vecs).toEqual([[1, 2, 3], [4, 5, 6]]);
    expect(calls[0]!.url).toBe("http://host:11434/api/embed");
    expect(calls[0]!.body).toEqual({ model: "nomic", input: ["a", "b"] });
  });

  it("posts to openai /v1/embeddings and parses { data:[{embedding}] }", async () => {
    const { fn, calls } = jsonFetch(() => ({ json: { data: [{ embedding: [0.1, 0.2] }, { embedding: [0.3, 0.4] }] } }));
    const vecs = await embedTexts({ api: "openai", baseUrl: "http://host:8080", model: "text-embed", fetch: fn }, ["a", "b"]);
    expect(vecs).toEqual([[0.1, 0.2], [0.3, 0.4]]);
    expect(calls[0]!.url).toBe("http://host:8080/v1/embeddings");
  });

  it("respects an existing /v1 suffix on the openai base", async () => {
    const { fn, calls } = jsonFetch(() => ({ json: { data: [{ embedding: [1] }] } }));
    await embedTexts({ api: "openai", baseUrl: "http://host:1234/v1", model: "m", fetch: fn }, ["x"]);
    expect(calls[0]!.url).toBe("http://host:1234/v1/embeddings");
  });

  it("throws EmbeddingError on a non-200", async () => {
    const { fn } = jsonFetch(() => ({ status: 500, text: "boom" }));
    await expect(embedTexts({ api: "ollama", model: "m", fetch: fn }, ["x"])).rejects.toBeInstanceOf(EmbeddingError);
  });
});

describe("testEmbeddingConnection", () => {
  it("reports dimensions on success", async () => {
    const { fn } = jsonFetch(() => ({ json: { embeddings: [[1, 2, 3, 4]] } }));
    expect(await testEmbeddingConnection({ api: "ollama", model: DEFAULT_EMBEDDING_MODEL, fetch: fn })).toEqual({ ok: true, dimensions: 4 });
  });

  it("folds errors into { ok:false } without throwing", async () => {
    const { fn } = jsonFetch(() => ({ status: 404, text: "no model" }));
    const r = await testEmbeddingConnection({ api: "ollama", model: "m", fetch: fn });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("404");
  });
});
