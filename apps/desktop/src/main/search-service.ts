import crypto from "node:crypto";
import path from "node:path";
import { app, type WebContents } from "electron";
import type { LocalTestResult } from "@corvus/ai-engine";
import type { AiEngineConfig, LocalModelApi, SearchCategory, SearchEngine, SearchEvent, SearchOptions } from "@corvus/shared";
import type { ConnectionTestResult, EngineInfo, InternalEvent } from "../shared/ipc";
import { INTERNAL_EVENT } from "../shared/ipc";
import type { Settings } from "../shared/settings";
import { loadOptionalModule } from "./module-loader";
import type { SettingsStore } from "./settings-store";

/** Used when @corvus/ai-engine is missing or cannot be configured. Emits no results, one error. */
class UnavailableEngine implements SearchEngine {
  constructor(private readonly reason: string) {}
  async *search(): AsyncIterable<SearchEvent> {
    yield { type: "error", message: this.reason, recoverable: false };
  }
}

interface AiEngineModule {
  createSearchEngine?: (config: AiEngineConfig, deps?: unknown) => SearchEngine;
  fetchFavicon?: (domain: string) => Promise<string | null>;
  testLocalConnection?: (opts: { model: string; baseUrl?: string; api?: LocalModelApi }, signal?: AbortSignal) => Promise<LocalTestResult>;
}

/** Smoke-test seams: engine deps for createSearchEngine (fake retriever/provider) and a favicon stub. */
export interface SearchTestDeps {
  engine: unknown;
  favicon?: (domain: string) => Promise<string | null>;
}

const FAVICON_CACHE_MAX = 500;

function aiSettingsChanged(a: Settings, b: Settings): boolean {
  return JSON.stringify(a.ai) !== JSON.stringify(b.ai);
}

export class SearchService {
  private engine: Promise<SearchEngine> | null = null;
  private info: EngineInfo;
  private readonly running = new Map<string, AbortController>();
  private readonly faviconCache = new Map<string, Promise<string | null>>();
  private testDeps: SearchTestDeps | null = null;

  /** Stable SearchEngine facade (handed to the MCP server) that always uses the current engine. */
  readonly proxy: SearchEngine = {
    search: (query, opts) => this.stream(query, opts),
  };

  constructor(private readonly settings: SettingsStore) {
    this.info = this.describe(false, "Not loaded yet");
    settings.onChange((next, prev) => {
      if (next === prev || aiSettingsChanged(next, prev)) this.engine = null;
    });
  }

  private describe(available: boolean, reason: string | null): EngineInfo {
    const ai = this.settings.get().ai;
    return { available, provider: ai.provider, model: ai.model, retriever: ai.retriever, reason };
  }

  private config(): AiEngineConfig {
    const ai = this.settings.get().ai;
    return {
      provider: ai.provider,
      apiKey: this.settings.getSecret("anthropicApiKey"),
      model: ai.model,
      claudeCliPath: ai.claudeCliPath || undefined,
      localBaseUrl: ai.localBaseUrl || undefined,
      localApi: ai.localApi,
      retriever: ai.retriever,
      searxngUrl: ai.searxngUrl,
      braveApiKey: this.settings.getSecret("braveApiKey"),
      cacheDir: path.join(app.getPath("userData"), "search-cache"),
      uiLocale: app.getLocale(),
      maxOutputTokens: ai.maxOutputTokens,
    };
  }

  private async create(): Promise<SearchEngine> {
    const mod = await this.module();
    if (!mod?.createSearchEngine) {
      const reason = "The AI search engine (@corvus/ai-engine) is not installed or not built.";
      this.info = this.describe(false, reason);
      return new UnavailableEngine(reason);
    }
    try {
      const engine = this.testDeps ? mod.createSearchEngine(this.config(), this.testDeps.engine) : mod.createSearchEngine(this.config());
      this.info = this.describe(true, null);
      return engine;
    } catch (err) {
      const reason = `The AI search engine could not start: ${(err as Error).message}`;
      this.info = this.describe(false, reason);
      return new UnavailableEngine(reason);
    }
  }

  private module(): Promise<AiEngineModule | null> {
    return loadOptionalModule<AiEngineModule>("@corvus/ai-engine", "ai-engine");
  }

  /** Smoke test only: swap in fake engine deps (null restores the real engine). */
  setTestDeps(deps: SearchTestDeps | null): void {
    this.testDeps = deps;
    this.engine = null;
    this.faviconCache.clear();
  }

  async favicons(domains: string[]): Promise<Record<string, string | null>> {
    const fetchFavicon = this.testDeps?.favicon ?? (await this.module())?.fetchFavicon;
    const out: Record<string, string | null> = {};
    await Promise.all(
      [...new Set(domains.map((d) => d.toLowerCase()))].map(async (domain) => {
        let pending = this.faviconCache.get(domain);
        if (!pending) {
          pending = fetchFavicon ? fetchFavicon(domain).catch(() => null) : Promise.resolve(null);
          this.faviconCache.set(domain, pending);
          if (this.faviconCache.size > FAVICON_CACHE_MAX) {
            const oldest = this.faviconCache.keys().next().value;
            if (oldest !== undefined) this.faviconCache.delete(oldest);
          }
        }
        out[domain] = await pending;
      }),
    );
    return out;
  }

  private current(): Promise<SearchEngine> {
    if (!this.engine) this.engine = this.create();
    return this.engine;
  }

  async engineInfo(): Promise<EngineInfo> {
    await this.current();
    return this.info;
  }

  /** Probes the configured provider for the Settings "Test connection" button. */
  async testConnection(): Promise<ConnectionTestResult> {
    const ai = this.settings.get().ai;
    if (ai.provider === "anthropic-api") {
      const hasKey = Boolean(this.settings.getSecret("anthropicApiKey"));
      return { ok: hasKey, detail: hasKey ? "Anthropic API key is set." : "No Anthropic API key set in Settings." };
    }
    if (ai.provider === "claude-code-cli") {
      return { ok: true, detail: "Uses your local Claude Code CLI login. Run a search to confirm the CLI works." };
    }
    const mod = await this.module();
    if (!mod?.testLocalConnection) return { ok: false, detail: "The AI engine is not available." };
    try {
      const r = await mod.testLocalConnection({ model: ai.model, baseUrl: ai.localBaseUrl || undefined, api: ai.localApi });
      if (!r.ok) return { ok: false, detail: `Could not reach ${r.baseUrl}${r.error ? ` — ${r.error}` : ""}.` };
      const modelNote = r.modelPresent ? `model "${ai.model}" is available` : `model "${ai.model}" was not found — pull or load it first`;
      const toolNote = r.supportsTools ? "native tools supported" : "no native tools (agent runs in text mode)";
      return {
        ok: r.modelPresent,
        detail: `Connected to ${r.baseUrl}. ${modelNote}; ${toolNote}.`,
        models: r.models,
        modelPresent: r.modelPresent,
        supportsTools: r.supportsTools,
      };
    } catch (err) {
      return { ok: false, detail: `Connection test failed: ${(err as Error).message}` };
    }
  }

  async *stream(query: string, opts: SearchOptions = {}): AsyncIterable<SearchEvent> {
    const engine = await this.current();
    const lang = opts.lang ?? (this.settings.get().ai.answerLanguage || undefined);
    yield* engine.search(query, { ...opts, ...(lang ? { lang } : {}) });
  }

  /** Run a search for an internal page, streaming events back to its webContents. */
  start(target: WebContents, query: string, depth: "quick" | "deep", category: SearchCategory = "general"): string {
    const searchId = crypto.randomUUID();
    const controller = new AbortController();
    this.running.set(searchId, controller);
    const abort = (): void => controller.abort();
    const onNavigation = (details: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>): void => {
      if (details.isMainFrame && !details.isSameDocument) abort();
    };
    target.once("destroyed", abort);
    target.on("did-start-navigation", onNavigation);

    const send = (event: SearchEvent): void => {
      if (target.isDestroyed() || controller.signal.aborted) return;
      const message: InternalEvent = { type: "search", message: { searchId, event } };
      target.send(INTERNAL_EVENT, message);
    };

    void (async () => {
      try {
        for await (const event of this.stream(query, { depth, category, signal: controller.signal })) {
          if (controller.signal.aborted) break;
          send(event);
        }
      } catch (err) {
        if (!controller.signal.aborted) send({ type: "error", message: (err as Error).message, recoverable: true });
      } finally {
        if (!target.isDestroyed() && !controller.signal.aborted) {
          const message: InternalEvent = { type: "search", message: { searchId, done: true } };
          target.send(INTERNAL_EVENT, message);
        }
        this.running.delete(searchId);
        if (!target.isDestroyed()) {
          target.off("destroyed", abort);
          target.off("did-start-navigation", onNavigation);
        }
      }
    })();
    return searchId;
  }

  cancel(searchId: string): void {
    this.running.get(searchId)?.abort();
    this.running.delete(searchId);
  }
}
