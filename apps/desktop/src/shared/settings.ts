import { ACCESS_LEVELS, type AccessLevel, type AIProviderKind, type LocalModelApi, type RetrieverKind } from "@corvus/shared";

export type { AccessLevel } from "@corvus/shared";

export type ThemeSource = "system" | "light" | "dark";
export type StartupMode = "restore" | "newtab";
export type TabLayout = "horizontal" | "vertical";
export type UpdateChannel = "stable" | "beta";

export interface Settings {
  appearance: {
    theme: ThemeSource;
    showBookmarksBar: boolean;
    /** "horizontal" = classic top tab strip, "vertical" = left sidebar. */
    tabLayout: TabLayout;
    /** Width of the vertical tab sidebar in pixels (when expanded). */
    sidebarWidth: number;
    /** Vertical sidebar collapsed to icons only. */
    sidebarCollapsed: boolean;
  };
  ai: {
    provider: AIProviderKind;
    model: string;
    claudeCliPath: string;
    /** Local provider: model server root, e.g. http://localhost:11434 (Ollama). */
    localBaseUrl: string;
    /** Local provider: wire protocol the server speaks. */
    localApi: LocalModelApi;
    retriever: RetrieverKind;
    searxngUrl: string;
    /** BCP-47 tag; empty string = detect from the query, then UI locale. */
    answerLanguage: string;
    maxOutputTokens: number;
  };
  agent: {
    /** Max tool steps one Command Bar agent run may take before it stops. */
    maxSteps: number;
    /** Ask the user to approve actions that submit forms, spend money or log in. */
    askBeforeRisky: boolean;
  };
  mcp: {
    enabled: boolean;
    /** Bind interface: "127.0.0.1" (loopback only) or "0.0.0.0" (all interfaces, remote clients). */
    host: string;
    /** 0 = pick a random free port on first start, then persist it. */
    port: number;
    /** What approved MCP clients may do. "standard" by default; "full" also allows evaluate/uploads/downloads/PDF. */
    accessLevel: AccessLevel;
    /** Legacy switch kept in sync with accessLevel ("full" ⇔ true) for older configs and tools. */
    allowEvaluate: boolean;
    approvedClients: string[];
  };
  downloads: {
    /** Absolute folder; empty string = the OS Downloads folder. */
    directory: string;
    askWhereToSave: boolean;
  };
  webscope: {
    /** Security workbench: captures your own browser traffic for authorized testing. Off by default. */
    enabled: boolean;
    /** Per-body capture cap in bytes. */
    maxBodyBytes: number;
  };
  monitor: {
    /** Background page-change monitoring ("Watch this page"). On by default. */
    enabled: boolean;
    /** Default re-check interval for a new watch, in minutes. */
    defaultIntervalMinutes: number;
    /** Maximum number of active watches per profile. */
    maxWatches: number;
  };
  scheduledAgents: {
    /** Background scheduled AI agent tasks (cron/interval). On by default. */
    enabled: boolean;
    /** Hard cap on tool steps any scheduled run may take. */
    maxSteps: number;
    /** Total token budget (input + output) for one scheduled run. */
    maxTokens: number;
  };
  startup: {
    /** "restore" = continue where you left off, "newtab" = open a new tab page. */
    mode: StartupMode;
  };
  update: {
    /** Check the update feed on startup and surface anything available. */
    autoCheck: boolean;
    /** Release channel. "beta" opts into pre-releases from the same feed. */
    channel: UpdateChannel;
    /** Base URL of a self-hosted electron-builder "generic" feed. Empty = GitHub Releases (DEFAULT_UPDATE_FEED). */
    feedUrl: string;
  };
  reader: {
    /** Base font size in px (15-28). */
    fontSize: number;
    /** Content column width in ch units (36-90). */
    lineWidth: number;
    theme: ReaderTheme;
    font: ReaderFontFamily;
    /** BCP-47 tag or language name the reader's Translate tool targets by default. */
    translateLanguage: string;
  };
  pdf: {
    /** Open PDFs in Corvus's in-app viewer instead of downloading them. On by default. */
    openInViewer: boolean;
  };
  semanticSearch: {
    /** Capture readable page text into a local per-profile index ("find in my history"). On by default. */
    indexPages: boolean;
    /** Re-rank local search with embeddings from the local model endpoint. Off by default (keyword works alone). */
    useEmbeddings: boolean;
    /** Embedding model name on the local endpoint (reuses ai.localBaseUrl / ai.localApi). */
    embeddingModel: string;
  };
  crashReports: {
    /** Save crash and error logs to a local rotating file under the user data folder. Off by default; never uploaded. */
    saveLogs: boolean;
  };
  onboarding: {
    /** The first-run welcome wizard has been finished or skipped. False shows it once on next launch. */
    completed: boolean;
  };
}

export type ReaderTheme = "light" | "sepia" | "dark";
export type ReaderFontFamily = "serif" | "sans";

/** Secrets never leave the main process; the UI only learns whether each one is set. */
export type SecretKey = "anthropicApiKey" | "braveApiKey";

export interface SettingsView {
  settings: Settings;
  secrets: Record<SecretKey, boolean>;
  /** False when the OS keychain is unavailable: secrets then live in memory for this session only. */
  secretsPersisted: boolean;
}

export type SettingsPatch = {
  [K in keyof Settings]?: Partial<Settings[K]>;
};

export const DEFAULT_MODEL = "claude-haiku-5-5";

export function defaultSettings(env: Record<string, string | undefined> = {}): Settings {
  const provider: AIProviderKind =
    env.CORVUS_AI_PROVIDER === "claude-code-cli" || env.CORVUS_AI_PROVIDER === "local" ? env.CORVUS_AI_PROVIDER : "anthropic-api";
  const localApi: LocalModelApi = env.CORVUS_LOCAL_API === "openai" ? "openai" : "ollama";
  const retriever: RetrieverKind =
    env.CORVUS_RETRIEVER === "brave" || env.CORVUS_RETRIEVER === "duckduckgo" ? env.CORVUS_RETRIEVER : "searxng";
  return {
    appearance: { theme: "system", showBookmarksBar: true, tabLayout: "horizontal", sidebarWidth: 240, sidebarCollapsed: false },
    ai: {
      provider,
      model: env.CORVUS_AI_MODEL || DEFAULT_MODEL,
      claudeCliPath: "claude",
      localBaseUrl: env.CORVUS_LOCAL_BASE_URL || "http://localhost:11434",
      localApi,
      retriever,
      searxngUrl: env.CORVUS_SEARXNG_URL || "http://localhost:8898",
      answerLanguage: "",
      maxOutputTokens: 400,
    },
    agent: { maxSteps: 15, askBeforeRisky: true },
    mcp: { enabled: false, host: "127.0.0.1", port: 0, accessLevel: "standard", allowEvaluate: false, approvedClients: [] },
    downloads: { directory: "", askWhereToSave: false },
    webscope: { enabled: false, maxBodyBytes: 5 * 1024 * 1024 },
    monitor: { enabled: true, defaultIntervalMinutes: 30, maxWatches: 50 },
    scheduledAgents: { enabled: true, maxSteps: 12, maxTokens: 60000 },
    startup: { mode: "restore" },
    update: {
      autoCheck: true,
      channel: env.CORVUS_UPDATE_CHANNEL === "beta" ? "beta" : "stable",
      feedUrl: env.CORVUS_UPDATE_FEED_URL ?? "",
    },
    reader: { fontSize: 19, lineWidth: 64, theme: "light", font: "serif", translateLanguage: "" },
    pdf: { openInViewer: true },
    semanticSearch: { indexPages: true, useEmbeddings: false, embeddingModel: env.CORVUS_EMBED_MODEL || "nomic-embed-text" },
    crashReports: { saveLogs: false },
    onboarding: { completed: false },
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Merge a (possibly untrusted or outdated) partial settings object into a complete one.
 * Unknown keys and values of the wrong type are ignored.
 */
export function mergeSettings(base: Settings, patch: unknown): Settings {
  if (!isObject(patch)) return base;
  const out = structuredClone(base) as unknown as Record<string, Record<string, unknown>>;
  for (const [section, values] of Object.entries(patch)) {
    const target = out[section];
    if (!target || !isObject(values)) continue;
    for (const [key, value] of Object.entries(values)) {
      if (!(key in target)) continue;
      const current = target[key];
      if (Array.isArray(current)) {
        if (Array.isArray(value) && value.every((v) => typeof v === "string")) target[key] = [...value];
      } else if (typeof current === typeof value) {
        target[key] = value;
      }
    }
  }
  const merged = out as unknown as Settings;
  merged.mcp.port = Number.isInteger(merged.mcp.port) && merged.mcp.port >= 0 && merged.mcp.port <= 65535 ? merged.mcp.port : 0;
  if (merged.mcp.host !== "127.0.0.1" && merged.mcp.host !== "0.0.0.0") merged.mcp.host = base.mcp.host;
  if (!ACCESS_LEVELS.includes(merged.mcp.accessLevel)) merged.mcp.accessLevel = base.mcp.accessLevel;
  merged.ai.maxOutputTokens = Math.max(50, Math.min(4000, Math.round(merged.ai.maxOutputTokens)));
  merged.agent.maxSteps = Math.max(1, Math.min(50, Math.round(merged.agent.maxSteps)));
  merged.webscope.maxBodyBytes = Math.max(64 * 1024, Math.min(50 * 1024 * 1024, Math.round(merged.webscope.maxBodyBytes)));
  merged.appearance.sidebarWidth = Math.max(180, Math.min(480, Math.round(merged.appearance.sidebarWidth)));
  merged.monitor.defaultIntervalMinutes = Math.max(5, Math.min(1440, Math.round(merged.monitor.defaultIntervalMinutes)));
  merged.monitor.maxWatches = Math.max(1, Math.min(200, Math.round(merged.monitor.maxWatches)));
  merged.scheduledAgents.maxSteps = Math.max(1, Math.min(50, Math.round(merged.scheduledAgents.maxSteps)));
  merged.scheduledAgents.maxTokens = Math.max(2000, Math.min(500000, Math.round(merged.scheduledAgents.maxTokens)));
  if (!["horizontal", "vertical"].includes(merged.appearance.tabLayout)) merged.appearance.tabLayout = base.appearance.tabLayout;
  if (!["system", "light", "dark"].includes(merged.appearance.theme)) merged.appearance.theme = base.appearance.theme;
  if (!["anthropic-api", "claude-code-cli", "local"].includes(merged.ai.provider)) merged.ai.provider = base.ai.provider;
  if (!["ollama", "openai"].includes(merged.ai.localApi)) merged.ai.localApi = base.ai.localApi;
  if (!["searxng", "brave", "duckduckgo"].includes(merged.ai.retriever)) merged.ai.retriever = base.ai.retriever;
  if (!["restore", "newtab"].includes(merged.startup.mode)) merged.startup.mode = base.startup.mode;
  if (!["stable", "beta"].includes(merged.update.channel)) merged.update.channel = base.update.channel;
  merged.update.feedUrl = merged.update.feedUrl.slice(0, 2048);
  merged.reader.fontSize = Math.max(15, Math.min(28, Math.round(merged.reader.fontSize)));
  merged.reader.lineWidth = Math.max(36, Math.min(90, Math.round(merged.reader.lineWidth)));
  if (!["light", "sepia", "dark"].includes(merged.reader.theme)) merged.reader.theme = base.reader.theme;
  if (!["serif", "sans"].includes(merged.reader.font)) merged.reader.font = base.reader.font;
  merged.semanticSearch.embeddingModel = merged.semanticSearch.embeddingModel.trim().slice(0, 200) || base.semanticSearch.embeddingModel;
  return merged;
}

/**
 * Effective MCP access level from settings. The legacy `allowEvaluate` toggle still grants full
 * access when it was on, so upgrading a config that had it enabled keeps evaluate/uploads working.
 */
export function resolveMcpAccessLevel(mcp: { accessLevel: AccessLevel; allowEvaluate: boolean }): AccessLevel {
  return mcp.allowEvaluate && mcp.accessLevel !== "full" ? "full" : mcp.accessLevel;
}

export function mcpAddCommand(port: number, token: string, host = "127.0.0.1"): string {
  return `claude mcp add --transport http corvus http://${host}:${port}/mcp --header "Authorization: Bearer ${token}"`;
}
