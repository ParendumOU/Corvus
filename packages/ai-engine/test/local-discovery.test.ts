import { describe, expect, it } from "vitest";
import { LOCAL_SERVER_CANDIDATES, discoverLocalServers, listLocalModels } from "../src/providers/local.js";

/** A fake network: Ollama answers on 11434, LM Studio is not running, llama.cpp answers with an error. */
const fakeFetch = async (input: string | URL | Request): Promise<Response> => {
  const url = String(input);
  if (url === "http://localhost:11434/api/tags") return Response.json({ models: [{ name: "llama3.1:8b" }, { model: "qwen2.5:7b" }] });
  if (url.startsWith("http://localhost:1234/")) throw new TypeError("fetch failed: ECONNREFUSED");
  if (url === "http://localhost:8080/v1/models") return new Response("nope", { status: 500 });
  if (url === "http://box:1234/v1/models") return Response.json({ data: [{ id: "phi-4" }, {}] });
  return new Response("", { status: 404 });
};

describe("local model servers", () => {
  it("lists the models of an Ollama or an OpenAI-compatible server", async () => {
    expect(await listLocalModels({ api: "ollama", baseUrl: "http://localhost:11434", fetch: fakeFetch })).toEqual(["llama3.1:8b", "qwen2.5:7b"]);
    expect(await listLocalModels({ api: "openai", baseUrl: "http://box:1234/v1", fetch: fakeFetch })).toEqual(["phi-4"]);
    await expect(listLocalModels({ api: "openai", baseUrl: "http://localhost:8080/v1", fetch: fakeFetch })).rejects.toThrow();
  });

  it("finds the servers running on their default ports, and only those", async () => {
    expect(LOCAL_SERVER_CANDIDATES.map((c) => c.name)).toEqual(["Ollama", "LM Studio", "llama.cpp"]);
    expect(await discoverLocalServers({ fetch: fakeFetch })).toEqual([
      { name: "Ollama", api: "ollama", baseUrl: "http://localhost:11434", models: ["llama3.1:8b", "qwen2.5:7b"] },
    ]);
  });

  it("gives up on a server that does not answer in time", async () => {
    const hanging = (_input: string | URL | Request, init?: RequestInit): Promise<Response> =>
      new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
    const started = Date.now();
    expect(await discoverLocalServers({ fetch: hanging })).toEqual([]);
    expect(Date.now() - started).toBeLessThan(5000);
  });
});
