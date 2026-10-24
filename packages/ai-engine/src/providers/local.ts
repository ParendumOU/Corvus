/**
 * Local-model provider: talks HTTP to a model server running on the user's own machine, so Corvus
 * works offline, with no API key and no data leaving the device.
 *
 * One abstraction, two wire protocols:
 *  - "ollama"  -> POST {base}/api/chat   (newline-delimited JSON stream; default http://localhost:11434)
 *  - "openai"  -> POST {base}/v1/chat/completions  (SSE stream; llama.cpp server, LM Studio, vLLM, …)
 *
 * `createLocalProvider` implements `AnswerProvider` (the single grounded-answer call used by AI search
 * and every Assist/reader task). The agent tool-use loop is served by `createLocalAgentProvider`
 * (agent.ts), which reuses `streamLocalChat` here. Tool support is a per-model capability: when the
 * model cannot do native tool calls the agent provider degrades to a text protocol instead of failing.
 */
import type { AIProviderKind, LocalModelApi } from "@corvus/shared";
import { type FetchLike, fetchWithTimeout } from "../http.js";
import type { AnswerProvider, AnswerRequest, ProviderEvent } from "./types.js";

export const DEFAULT_LOCAL_BASE_URL = "http://localhost:11434";
export const DEFAULT_LOCAL_API: LocalModelApi = "ollama";
/** Local models run grounded, format-bound tasks; low temperature keeps them on-format. */
export const DEFAULT_LOCAL_TEMPERATURE = 0.2;
const DEFAULT_TIMEOUT_MS = 180_000;
const PROBE_TIMEOUT_MS = 8_000;

export interface LocalProviderOptions {
  model: string;
  /** Server root, e.g. http://localhost:11434 (ollama) or http://localhost:1234/v1 (LM Studio). */
  baseUrl?: string;
  api?: LocalModelApi;
  /** Bearer token for OpenAI-compatible servers that require one. Ollama ignores it. */
  apiKey?: string;
  temperature?: number;
  /** Hard limit for one streamed completion, in ms. Default 180000. */
  timeoutMs?: number;
  /** Injected in tests. */
  fetch?: FetchLike;
}

/** A role-tagged message in the normalized chat shape both wire protocols are built from. */
export interface LocalChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /** Assistant tool calls (native-tools agent turns). */
  toolCalls?: Array<{ id: string; name: string; arguments: unknown }>;
  /** Links a "tool" message back to the call it answers (OpenAI needs this). */
  toolCallId?: string;
  /** Base64 images for a vision model (Ollama only). */
  images?: string[];
}

/** A tool offered to the model. `parameters` is a JSON Schema object. */
export interface LocalToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface LocalChatRequest {
  messages: LocalChatMessage[];
  tools?: LocalToolSpec[];
  maxTokens: number;
  temperature?: number;
  signal?: AbortSignal;
}

export type LocalChatEvent =
  | { type: "text"; text: string }
  | { type: "tool_call"; id: string; name: string; arguments: unknown }
  | { type: "usage"; inputTokens: number; outputTokens: number; model: string };

export class LocalModelError extends Error {
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "LocalModelError";
    this.status = status;
  }
}

/** True for the response that means "this model/server does not do native tool calls". */
export function isToolsUnsupported(err: unknown): boolean {
  if (!(err instanceof LocalModelError)) return false;
  if (/tool/i.test(err.message)) return true;
  // llama.cpp / some servers answer 404 or 501 to a tools request on a non-tool model.
  return err.status === 404 || err.status === 501;
}

export const LOCAL_PROVIDER_KIND: AIProviderKind = "local";

function resolveApi(api?: LocalModelApi): LocalModelApi {
  return api === "openai" ? "openai" : "ollama";
}

/** Trims a base URL and fills in the default when empty. */
export function normalizeBaseUrl(url: string | undefined, api: LocalModelApi): string {
  const trimmed = (url ?? "").trim().replace(/\/+$/, "");
  if (trimmed) return trimmed;
  return api === "openai" ? "http://localhost:8080" : DEFAULT_LOCAL_BASE_URL;
}

/** OpenAI-compatible root with exactly one `/v1` suffix. */
function openaiRoot(base: string): string {
  return /\/v1$/.test(base) ? base : `${base}/v1`;
}

function headers(opts: LocalProviderOptions): Record<string, string> {
  const h: Record<string, string> = { "content-type": "application/json" };
  if (opts.apiKey) h.authorization = `Bearer ${opts.apiKey}`;
  return h;
}

function toNumber(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function tryParse(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function toToolSpec(t: LocalToolSpec): unknown {
  return { type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } };
}

async function httpError(res: Response, api: LocalModelApi): Promise<LocalModelError> {
  let detail = "";
  try {
    detail = (await res.text()).slice(0, 400);
  } catch {
    // body already consumed or unreadable
  }
  const parsed = tryParse(detail);
  const message = parsed?.error?.message ?? (typeof parsed?.error === "string" ? parsed.error : "") ?? detail;
  return new LocalModelError(`Local model server (${api}) returned HTTP ${res.status}${message ? `: ${message}` : ""}`, res.status);
}

/** Yields complete lines from a streamed response body (works for NDJSON and SSE). */
async function* readLines(res: Response): AsyncIterable<string> {
  if (!res.body) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, "");
        buf = buf.slice(nl + 1);
        if (line) yield line;
      }
    }
    const rest = (buf + decoder.decode()).trim();
    if (rest) yield rest;
  } finally {
    void reader.cancel().catch(() => undefined);
  }
}

function toOllamaMessage(m: LocalChatMessage): unknown {
  const out: Record<string, unknown> = { role: m.role, content: m.content };
  if (m.images?.length) out.images = m.images;
  if (m.toolCalls?.length) {
    out.tool_calls = m.toolCalls.map((c) => ({ function: { name: c.name, arguments: c.arguments ?? {} } }));
  }
  return out;
}

async function* streamOllama(opts: LocalProviderOptions, req: LocalChatRequest): AsyncIterable<LocalChatEvent> {
  const base = normalizeBaseUrl(opts.baseUrl, "ollama");
  const body = {
    model: opts.model,
    messages: req.messages.map(toOllamaMessage),
    stream: true,
    options: { temperature: req.temperature ?? opts.temperature ?? DEFAULT_LOCAL_TEMPERATURE, num_predict: req.maxTokens },
    ...(req.tools?.length ? { tools: req.tools.map(toToolSpec) } : {}),
  };
  const res = await fetchWithTimeout(
    opts.fetch ?? fetch,
    `${base}/api/chat`,
    { method: "POST", headers: headers(opts), body: JSON.stringify(body) },
    opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    req.signal,
  );
  if (!res.ok) throw await httpError(res, "ollama");
  for await (const line of readLines(res)) {
    const msg = tryParse(line);
    if (!msg) continue;
    if (msg.error) throw new LocalModelError(`Local model server (ollama): ${String(msg.error)}`);
    const message = msg.message;
    if (message?.content) yield { type: "text", text: String(message.content) };
    if (Array.isArray(message?.tool_calls)) {
      for (const [i, tc] of message.tool_calls.entries()) {
        const fn = tc?.function;
        if (fn?.name) yield { type: "tool_call", id: String(tc.id ?? `call_${i}_${Date.now().toString(36)}`), name: String(fn.name), arguments: fn.arguments ?? {} };
      }
    }
    if (msg.done) {
      yield { type: "usage", inputTokens: toNumber(msg.prompt_eval_count), outputTokens: toNumber(msg.eval_count), model: String(msg.model ?? opts.model) };
    }
  }
}

function toOpenAIMessage(m: LocalChatMessage): unknown {
  if (m.role === "tool") return { role: "tool", tool_call_id: m.toolCallId ?? "", content: m.content };
  if (m.role === "assistant" && m.toolCalls?.length) {
    return {
      role: "assistant",
      content: m.content,
      tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: typeof c.arguments === "string" ? c.arguments : JSON.stringify(c.arguments ?? {}) } })),
    };
  }
  return { role: m.role, content: m.content };
}

async function* streamOpenAI(opts: LocalProviderOptions, req: LocalChatRequest): AsyncIterable<LocalChatEvent> {
  const root = openaiRoot(normalizeBaseUrl(opts.baseUrl, "openai"));
  const body = {
    model: opts.model,
    messages: req.messages.map(toOpenAIMessage),
    stream: true,
    stream_options: { include_usage: true },
    max_tokens: req.maxTokens,
    temperature: req.temperature ?? opts.temperature ?? DEFAULT_LOCAL_TEMPERATURE,
    ...(req.tools?.length ? { tools: req.tools.map(toToolSpec), tool_choice: "auto" } : {}),
  };
  const res = await fetchWithTimeout(
    opts.fetch ?? fetch,
    `${root}/chat/completions`,
    { method: "POST", headers: headers(opts), body: JSON.stringify(body) },
    opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    req.signal,
  );
  if (!res.ok) throw await httpError(res, "openai");

  const toolAcc = new Map<number, { id: string; name: string; args: string }>();
  let model = opts.model;
  let usage: { inputTokens: number; outputTokens: number } | null = null;
  for await (const line of readLines(res)) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (data === "[DONE]") break;
    const msg = tryParse(data);
    if (!msg) continue;
    if (msg.error) throw new LocalModelError(`Local model server (openai): ${msg.error?.message ?? String(msg.error)}`);
    if (msg.model) model = String(msg.model);
    const delta = msg.choices?.[0]?.delta;
    if (delta?.content) yield { type: "text", text: String(delta.content) };
    if (Array.isArray(delta?.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const idx = toNumber(tc.index);
        const acc = toolAcc.get(idx) ?? { id: "", name: "", args: "" };
        if (tc.id) acc.id = String(tc.id);
        if (tc.function?.name) acc.name = String(tc.function.name);
        if (typeof tc.function?.arguments === "string") acc.args += tc.function.arguments;
        toolAcc.set(idx, acc);
      }
    }
    if (msg.usage) usage = { inputTokens: toNumber(msg.usage.prompt_tokens), outputTokens: toNumber(msg.usage.completion_tokens) };
  }
  for (const acc of toolAcc.values()) {
    if (acc.name) yield { type: "tool_call", id: acc.id || `call_${Date.now().toString(36)}`, name: acc.name, arguments: tryParse(acc.args) ?? {} };
  }
  yield { type: "usage", inputTokens: usage?.inputTokens ?? 0, outputTokens: usage?.outputTokens ?? 0, model };
}

/** Streams one chat completion from the configured local server, normalized across both APIs. */
export function streamLocalChat(opts: LocalProviderOptions, req: LocalChatRequest): AsyncIterable<LocalChatEvent> {
  return resolveApi(opts.api) === "openai" ? streamOpenAI(opts, req) : streamOllama(opts, req);
}

export interface LocalCapabilities {
  reachable: boolean;
  /** The configured model does native tool calls (agent loop can use real tools). */
  tools: boolean;
  /** The configured model accepts images (Ollama "vision" capability). */
  vision: boolean;
  /** Models the server has available. */
  models: string[];
  /** The configured model is among the server's models. */
  modelPresent: boolean;
  error?: string;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function probeOllama(opts: LocalProviderOptions, signal?: AbortSignal): Promise<LocalCapabilities> {
  const base = normalizeBaseUrl(opts.baseUrl, "ollama");
  const f = opts.fetch ?? fetch;
  const tagsRes = await fetchWithTimeout(f, `${base}/api/tags`, { method: "GET", headers: headers(opts) }, PROBE_TIMEOUT_MS, signal);
  if (!tagsRes.ok) throw await httpError(tagsRes, "ollama");
  const tags = (await tagsRes.json()) as { models?: Array<{ name?: string; model?: string }> };
  const models = (tags.models ?? []).map((m) => m.name ?? m.model ?? "").filter(Boolean);
  const modelPresent = models.some((m) => m === opts.model || m.split(":")[0] === opts.model);
  let tools = false;
  let vision = false;
  try {
    const showRes = await fetchWithTimeout(f, `${base}/api/show`, { method: "POST", headers: headers(opts), body: JSON.stringify({ model: opts.model }) }, PROBE_TIMEOUT_MS, signal);
    if (showRes.ok) {
      const show = (await showRes.json()) as { capabilities?: string[] };
      tools = Array.isArray(show.capabilities) && show.capabilities.includes("tools");
      vision = Array.isArray(show.capabilities) && show.capabilities.includes("vision");
    }
  } catch {
    // Older Ollama has no /api/show capabilities; leave tools false -> agent uses the text protocol.
  }
  return { reachable: true, tools, vision, models, modelPresent };
}

async function probeOpenAI(opts: LocalProviderOptions, signal?: AbortSignal): Promise<LocalCapabilities> {
  const root = openaiRoot(normalizeBaseUrl(opts.baseUrl, "openai"));
  const res = await fetchWithTimeout(opts.fetch ?? fetch, `${root}/models`, { method: "GET", headers: headers(opts) }, PROBE_TIMEOUT_MS, signal);
  if (!res.ok) throw await httpError(res, "openai");
  const data = (await res.json()) as { data?: Array<{ id?: string }> };
  const models = (data.data ?? []).map((m) => m.id ?? "").filter(Boolean);
  const modelPresent = models.includes(opts.model);
  // OpenAI-compatible servers advertise no tool capability; assume yes and let the agent loop fall back on error.
  // Images are only sent through Ollama's message `images` field; other servers get a text note.
  return { reachable: true, tools: true, vision: false, models, modelPresent };
}

/** Checks reachability, available models and native-tool support. Never throws; folds errors into the result. */
export async function detectLocalCapabilities(opts: LocalProviderOptions, signal?: AbortSignal): Promise<LocalCapabilities> {
  try {
    return resolveApi(opts.api) === "openai" ? await probeOpenAI(opts, signal) : await probeOllama(opts, signal);
  } catch (err) {
    return { reachable: false, tools: false, vision: false, models: [], modelPresent: false, error: errorMessage(err) };
  }
}

/** The models a local server has (Ollama's tags, or an OpenAI-compatible server's /models). Throws when unreachable. */
export async function listLocalModels(opts: Omit<LocalProviderOptions, "model">, signal?: AbortSignal, timeoutMs = PROBE_TIMEOUT_MS): Promise<string[]> {
  const api = resolveApi(opts.api);
  const f = opts.fetch ?? fetch;
  const withModel = { ...opts, model: "" };
  if (api === "openai") {
    const res = await fetchWithTimeout(f, `${openaiRoot(normalizeBaseUrl(opts.baseUrl, "openai"))}/models`, { method: "GET", headers: headers(withModel) }, timeoutMs, signal);
    if (!res.ok) throw await httpError(res, "openai");
    const data = (await res.json()) as { data?: Array<{ id?: string }> };
    return (data.data ?? []).map((m) => m.id ?? "").filter(Boolean);
  }
  const res = await fetchWithTimeout(f, `${normalizeBaseUrl(opts.baseUrl, "ollama")}/api/tags`, { method: "GET", headers: headers(withModel) }, timeoutMs, signal);
  if (!res.ok) throw await httpError(res, "ollama");
  const tags = (await res.json()) as { models?: Array<{ name?: string; model?: string }> };
  return (tags.models ?? []).map((m) => m.name ?? m.model ?? "").filter(Boolean);
}

/** A model server found running on this computer. */
export interface LocalServer {
  name: string;
  api: LocalModelApi;
  baseUrl: string;
  models: string[];
}

/** Where the common local model servers listen by default. */
export const LOCAL_SERVER_CANDIDATES: ReadonlyArray<Omit<LocalServer, "models">> = [
  { name: "Ollama", api: "ollama", baseUrl: "http://localhost:11434" },
  { name: "LM Studio", api: "openai", baseUrl: "http://localhost:1234/v1" },
  { name: "llama.cpp", api: "openai", baseUrl: "http://localhost:8080/v1" },
];

const DISCOVERY_TIMEOUT_MS = 1_500;

/**
 * Looks for local model servers on their default ports (all at once, briefly) and returns the
 * ones that answer, with their models. Never throws; servers that do not answer are left out.
 */
export async function discoverLocalServers(
  opts: { fetch?: FetchLike; candidates?: ReadonlyArray<Omit<LocalServer, "models">> } = {},
  signal?: AbortSignal,
): Promise<LocalServer[]> {
  const found = await Promise.all(
    (opts.candidates ?? LOCAL_SERVER_CANDIDATES).map(async (c): Promise<LocalServer | null> => {
      try {
        const models = await listLocalModels({ api: c.api, baseUrl: c.baseUrl, ...(opts.fetch ? { fetch: opts.fetch } : {}) }, signal, DISCOVERY_TIMEOUT_MS);
        return { ...c, models };
      } catch {
        return null;
      }
    }),
  );
  return found.filter((s): s is LocalServer => s !== null);
}

export interface LocalTestResult {
  ok: boolean;
  api: LocalModelApi;
  baseUrl: string;
  models: string[];
  modelPresent: boolean;
  supportsTools: boolean;
  error?: string;
}

/** Backs the Settings "Test connection" button. */
export async function testLocalConnection(opts: LocalProviderOptions, signal?: AbortSignal): Promise<LocalTestResult> {
  const api = resolveApi(opts.api);
  const caps = await detectLocalCapabilities(opts, signal);
  return {
    ok: caps.reachable,
    api,
    baseUrl: normalizeBaseUrl(opts.baseUrl, api),
    models: caps.models,
    modelPresent: caps.modelPresent,
    supportsTools: caps.tools,
    ...(caps.error ? { error: caps.error } : {}),
  };
}

/** One LLM call that streams a grounded answer from a local model (AI search + every Assist task). */
export function createLocalProvider(opts: LocalProviderOptions): AnswerProvider {
  return {
    kind: "local",
    model: opts.model,
    async *answer(req: AnswerRequest): AsyncIterable<ProviderEvent> {
      const messages: LocalChatMessage[] = [
        { role: "system", content: req.prompt.system },
        { role: "user", content: req.prompt.user },
      ];
      let usage: Extract<LocalChatEvent, { type: "usage" }> | undefined;
      for await (const ev of streamLocalChat(opts, { messages, maxTokens: req.maxOutputTokens, ...(req.signal ? { signal: req.signal } : {}) })) {
        if (ev.type === "text") {
          if (ev.text) yield { type: "delta", text: ev.text };
        } else if (ev.type === "usage") {
          usage = ev;
        }
      }
      yield usage
        ? { type: "usage", inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, model: usage.model }
        : { type: "usage", inputTokens: 0, outputTokens: 0, model: opts.model };
    },
  };
}
