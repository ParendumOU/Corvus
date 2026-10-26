import { ACCESS_LEVELS, type AccessLevel, type AIProviderKind, type LocalModelApi, type RetrieverKind } from "@corvus/shared";
import { cleanPasswords } from "./archives";

export type { AccessLevel } from "@corvus/shared";

export type ThemeSource = "system" | "light" | "dark";
export type StartupMode = "restore" | "newtab";
export type TabLayout = "horizontal" | "vertical";
/** Language of Corvus's own pages; "system" follows the operating system. */
export type UiLanguageSetting = "system" | "en" | "es";
export type UiLanguage = "en" | "es";
/** Which Claude Code account the CLI provider runs as. */
export type ClaudeAccountMode = "default" | "folder" | "mcp";
/** Where the toolbar's home button goes. */
export type HomePage = "corvus" | "google" | "bing" | "duckduckgo" | "yahoo" | "ecosia" | "brave" | "startpage" | "custom";

export const HOME_PAGES: Record<Exclude<HomePage, "corvus" | "custom">, string> = {
  google: "https://www.google.com/",
  bing: "https://www.bing.com/",
  duckduckgo: "https://duckduckgo.com/",
  yahoo: "https://www.yahoo.com/",
  ecosia: "https://www.ecosia.org/",
  brave: "https://search.brave.com/",
  startpage: "https://www.startpage.com/",
};
export type UpdateChannel = "stable" | "beta";

export interface Settings {
  appearance: {
    theme: ThemeSource;
    showBookmarksBar: boolean;
    /** "horizontal" = classic top tab strip, "vertical" = left sidebar. */
    tabLayout: TabLayout;
    /** Width of the vertical tab sidebar in pixels (when expanded). */
    sidebarWidth: number;
    /** Width of the Corvus Assist panel in pixels, as the person last dragged it. */
    assistWidth: number;
    /** Vertical sidebar collapsed to icons only. */
    sidebarCollapsed: boolean;
    /** Language of Corvus's own pages (settings and the page menu so far). */
    language: UiLanguageSetting;
    /** Home button next to reload, and where it goes ("corvus" = the New Tab page with Corvus search). */
    showHomeButton: boolean;
    homePage: HomePage;
    /** Address for homePage "custom" (http or https). */
    homeUrl: string;
  };
  ai: {
    provider: AIProviderKind;
    model: string;
    claudeCliPath: string;
    /**
     * Claude Code account for the CLI provider: the CLI's own default, a config folder
     * (CLAUDE_CONFIG_DIR), or the folder of the Claude Code session last connected over MCP.
     */
    claudeAccount: ClaudeAccountMode;
    claudeConfigDir: string;
    /** Extra environment for the CLI process, one NAME=value per line. */
    cliEnv: string;
    /** Last Claude Code config folder an approved MCP client reported ("" = default), who and when (0 = never). */
    mcpClaudeConfigDir: string;
    mcpClaudeClient: string;
    mcpClaudeAt: number;
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
    /** Learn compact per-site hints from successful runs (local only, never synced). On by default. */
    siteMemory: boolean;
    /** Remember what is run from the Command Bar (its "Recent" list). On by default. */
    rememberCommands: boolean;
    /** Keep a small capture of the page after each step in the run history. On by default. */
    runScreenshots: boolean;
  };
  passwords: {
    /**
     * Let AI agents (the Command Bar agent and Full-access MCP clients) sign in and fill 2FA codes,
     * only for logins the user opted in one by one, always after an approval prompt. Off by default.
     */
    agentAccess: boolean;
    /** Lock unlocked KeePass databases after this many idle minutes. 0 = never. */
    keepassAutoLockMinutes: number;
    /**
     * Let sites use passkeys and security keys (Windows Hello, Touch ID, USB keys). Off by default:
     * on Windows each request opens the system security-key dialog. Applies to tabs opened afterwards.
     */
    passkeys: boolean;
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
    /** How many tool calls a connected session may make (MCP_RATE_LIMITS). */
    rateLimit: McpRateLimit;
    /** Keep a local log of agents' tool calls (tool, client, site, result; never page content or arguments). */
    activityLog: boolean;
  };
  downloads: {
    /** Absolute folder; empty string = the OS Downloads folder. */
    directory: string;
    askWhereToSave: boolean;
    /** Offer the download links in copied text (a toolbar chip). Only download links are looked at; nothing else of the clipboard is kept. */
    watchClipboard: boolean;
    /** Files Corvus's download queue fetches at once (1-10). */
    maxParallel: number;
    /** Connections per large file when the server serves byte ranges (1-8). */
    segments: number;
    /** Extract archives (and join split files) when every file of a package is in. */
    extractArchives: boolean;
    /** Delete an archive's files once it is extracted. */
    deleteArchives: boolean;
    /** Archive passwords to try after the ones found next to the links. */
    archivePasswords: string[];
  };
  webscope: {
    /** Security workbench: captures your own browser traffic for authorized testing. Off by default. */
    enabled: boolean;
    /** Per-body capture cap in bytes. */
    maxBodyBytes: number;
  };
  memory: {
    /** Put background tabs to sleep after a while to free their memory. On by default. */
    sleepTabs: boolean;
    /** Minutes a tab stays in the background before it sleeps. */
    sleepAfterMinutes: number;
  };
  media: {
    /** Float a video that is playing with sound when you switch to another tab. On by default. */
    autoPictureInPicture: boolean;
  };
  phone: {
    /** The person's own Telegram bot (@username), once its token is checked. The token is a secret. */
    telegramBot: string;
    /** The private chat linked to the bot (who sent it /start): pages go there, links come from it. */
    telegramChatId: string;
    telegramChatName: string;
    /** Open links the linked chat sends to the bot. */
    receiveLinks: boolean;
    /** Answer questions asked from Corvus on the phone (sent to this computer) with its AI search. */
    answerQuestions: boolean;
  };
  translate: {
    /** Offer to translate pages written in another language (a button in the address bar). */
    offer: boolean;
    /** Language pages are translated into: a BCP 47 tag, or "" for Corvus's own language. */
    targetLanguage: string;
  };
  dictation: {
    /** Dictation in the Command Bar and Assist, and the voice command shortcut. Off until set up. */
    enabled: boolean;
    /** Base URL of an OpenAI-compatible speech-to-text service, e.g. https://api.openai.com/v1. */
    baseUrl: string;
    /** The service's transcription model, e.g. gpt-4o-mini-transcribe or whisper-large-v3-turbo. */
    model: string;
    /** Language the person speaks (ISO 639-1), or "" to let the service detect it. */
    language: string;
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
    /** Offer "Make default" once per launch while Corvus is not the default browser. */
    askDefaultBrowser: boolean;
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
export type SecretKey = "anthropicApiKey" | "braveApiKey" | "transcriptionApiKey";

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
    appearance: { theme: "system", showBookmarksBar: true, tabLayout: "horizontal", sidebarWidth: 240, assistWidth: 380, sidebarCollapsed: false, language: "system", showHomeButton: true, homePage: "corvus", homeUrl: "" },
    ai: {
      provider,
      model: env.CORVUS_AI_MODEL || DEFAULT_MODEL,
      claudeCliPath: "claude", claudeAccount: "default", claudeConfigDir: "", cliEnv: "", mcpClaudeConfigDir: "", mcpClaudeClient: "", mcpClaudeAt: 0,
      localBaseUrl: env.CORVUS_LOCAL_BASE_URL || "http://localhost:11434",
      localApi,
      retriever,
      searxngUrl: env.CORVUS_SEARXNG_URL || "http://localhost:8898",
      answerLanguage: "",
      maxOutputTokens: 400,
    },
    agent: { maxSteps: 15, askBeforeRisky: true, siteMemory: true, rememberCommands: true, runScreenshots: true },
    passwords: { agentAccess: false, keepassAutoLockMinutes: 15, passkeys: false },
    mcp: { enabled: false, host: "127.0.0.1", port: 0, accessLevel: "standard", allowEvaluate: false, approvedClients: [], rateLimit: "standard", activityLog: true },
    downloads: { directory: "", askWhereToSave: false, watchClipboard: true, maxParallel: 3, segments: 4, extractArchives: true, deleteArchives: false, archivePasswords: [] },
    webscope: { enabled: false, maxBodyBytes: 5 * 1024 * 1024 },
    memory: { sleepTabs: true, sleepAfterMinutes: 60 },
    media: { autoPictureInPicture: true },
    phone: { telegramBot: "", telegramChatId: "", telegramChatName: "", receiveLinks: true, answerQuestions: true },
    translate: { offer: true, targetLanguage: "" },
    dictation: { enabled: false, baseUrl: "", model: "", language: "" },
    monitor: { enabled: true, defaultIntervalMinutes: 30, maxWatches: 50 },
    scheduledAgents: { enabled: true, maxSteps: 12, maxTokens: 60000 },
    startup: { mode: "restore", askDefaultBrowser: true },
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
  if (!Object.hasOwn(MCP_RATE_LIMITS, merged.mcp.rateLimit)) merged.mcp.rateLimit = base.mcp.rateLimit;
  merged.ai.maxOutputTokens = Math.max(50, Math.min(4000, Math.round(merged.ai.maxOutputTokens)));
  merged.agent.maxSteps = Math.max(1, Math.min(50, Math.round(merged.agent.maxSteps)));
  merged.passwords.keepassAutoLockMinutes = Math.max(0, Math.min(1440, Math.round(merged.passwords.keepassAutoLockMinutes) || 0));
  merged.webscope.maxBodyBytes = Math.max(64 * 1024, Math.min(50 * 1024 * 1024, Math.round(merged.webscope.maxBodyBytes)));
  merged.appearance.sidebarWidth = Math.max(180, Math.min(480, Math.round(merged.appearance.sidebarWidth)));
  merged.appearance.assistWidth = Math.max(320, Math.min(960, Math.round(merged.appearance.assistWidth) || 380));
  merged.monitor.defaultIntervalMinutes = Math.max(5, Math.min(1440, Math.round(merged.monitor.defaultIntervalMinutes)));
  merged.monitor.maxWatches = Math.max(1, Math.min(200, Math.round(merged.monitor.maxWatches)));
  merged.scheduledAgents.maxSteps = Math.max(1, Math.min(50, Math.round(merged.scheduledAgents.maxSteps)));
  merged.scheduledAgents.maxTokens = Math.max(2000, Math.min(500000, Math.round(merged.scheduledAgents.maxTokens)));
  if (!["horizontal", "vertical"].includes(merged.appearance.tabLayout)) merged.appearance.tabLayout = base.appearance.tabLayout;
  if (!["system", "light", "dark"].includes(merged.appearance.theme)) merged.appearance.theme = base.appearance.theme;
  if (!["system", "en", "es"].includes(merged.appearance.language)) merged.appearance.language = base.appearance.language;
  merged.downloads.maxParallel = Math.max(1, Math.min(10, Math.round(merged.downloads.maxParallel) || 3));
  merged.downloads.segments = Math.max(1, Math.min(8, Math.round(merged.downloads.segments) || 4));
  merged.downloads.archivePasswords = cleanPasswords(merged.downloads.archivePasswords);
  merged.memory.sleepAfterMinutes = Math.max(5, Math.min(1440, Math.round(merged.memory.sleepAfterMinutes) || 60));
  if (merged.translate.targetLanguage !== "" &&!/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(merged.translate.targetLanguage)) {
    merged.translate.targetLanguage = base.translate.targetLanguage;
  }
  merged.dictation.baseUrl = merged.dictation.baseUrl.trim().slice(0, 2048);
  merged.dictation.model = merged.dictation.model.trim().slice(0, 200);
  if (merged.dictation.language !== "" && !/^[a-z]{2,3}$/.test(merged.dictation.language)) merged.dictation.language = base.dictation.language;
  if (!["default", "folder", "mcp"].includes(merged.ai.claudeAccount)) merged.ai.claudeAccount = base.ai.claudeAccount;
  if (!["corvus", "custom", ...Object.keys(HOME_PAGES)].includes(merged.appearance.homePage)) merged.appearance.homePage = base.appearance.homePage;
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
export type McpRateLimit = "strict" | "standard" | "relaxed";

/** Per connected MCP session: a burst of `capacity` calls, then `refillPerSecond` calls a second. */
export const MCP_RATE_LIMITS: Readonly<Record<McpRateLimit, { capacity: number; refillPerSecond: number }>> = {
  strict: { capacity: 10, refillPerSecond: 1 },
  standard: { capacity: 30, refillPerSecond: 5 },
  relaxed: { capacity: 100, refillPerSecond: 20 },
};

export function resolveMcpAccessLevel(mcp: { accessLevel: AccessLevel; allowEvaluate: boolean }): AccessLevel {
  return mcp.allowEvaluate && mcp.accessLevel !== "full" ? "full" : mcp.accessLevel;
}

export function mcpAddCommand(port: number, token: string, host = "127.0.0.1"): string {
  return `claude mcp add --transport http corvus http://${host}:${port}/mcp --header "Authorization: Bearer ${token}"`;
}

/** The language Corvus pages use: the chosen one, or Spanish for a Spanish system locale ("es-ES"). */
export function resolveUiLanguage(setting: UiLanguageSetting, locale: string): UiLanguage {
  if (setting === "en" || setting === "es") return setting;
  return /^es\b/i.test(locale) ? "es" : "en";
}

/** Address the home button opens; a custom address that is not http(s) falls back to the New Tab page. */
export function homePageUrl(appearance: Pick<Settings["appearance"], "homePage" | "homeUrl">): string {
  if (appearance.homePage === "corvus") return "corvus://newtab/";
  if (appearance.homePage === "custom") {
    try {
      const url = new URL(appearance.homeUrl.trim());
      return url.protocol === "http:" || url.protocol === "https:" ? url.href : "corvus://newtab/";
    } catch {
      return "corvus://newtab/";
    }
  }
  return HOME_PAGES[appearance.homePage];
}

/** NAME=value lines (blank lines and # comments ignored); later lines win. */
export function parseEnvLines(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    const name = eq > 0 ? trimmed.slice(0, eq).trim() : "";
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) env[name] = trimmed.slice(eq + 1).trim();
  }
  return env;
}

/** Extra environment for the Claude Code CLI: the person's variables, then the chosen account. */
export function claudeCliEnv(ai: Settings["ai"]): Record<string, string> {
  const env = parseEnvLines(ai.cliEnv);
  if (ai.claudeAccount === "folder" && ai.claudeConfigDir.trim()) env.CLAUDE_CONFIG_DIR = ai.claudeConfigDir.trim();
  // "" makes the CLI use its default folder even when Corvus itself runs with another one.
  if (ai.claudeAccount === "mcp" && ai.mcpClaudeAt > 0) env.CLAUDE_CONFIG_DIR = ai.mcpClaudeConfigDir;
  return env;
}
