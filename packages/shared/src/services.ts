/**
 * Entry-point contracts for each workspace package, so they can be built in parallel
 * and wired together by apps/desktop.
 */
import type { AccessLevel } from "./agent.js";
import type { BrowserController } from "./browser.js";
import type { AIProviderKind, LocalModelApi, RetrieverKind, SearchEngine } from "./search.js";
import type { DeviceInfo, SyncCollection } from "./sync.js";

// ---- @corvus/ai-engine: export function createSearchEngine(config: AiEngineConfig): SearchEngine
export interface AiEngineConfig {
  provider: AIProviderKind;
  apiKey?: string; // anthropic-api
  model?: string; // default "claude-haiku-5-5"
  claudeCliPath?: string; // claude-code-cli, default "claude"
  localBaseUrl?: string; // local, default "http://localhost:11434"
  localApi?: LocalModelApi; // local, default "ollama"
  retriever: RetrieverKind;
  searxngUrl?: string;
  braveApiKey?: string;
  cacheDir?: string; // on-disk cache; memory-only if omitted
  uiLocale?: string; // fallback answer language
  maxOutputTokens?: number; // default 400
}
export type CreateSearchEngine = (config: AiEngineConfig) => SearchEngine;

// ---- @corvus/mcp-server: export function startMcpServer(opts: McpServerOptions): Promise<McpServerHandle>
export interface McpClientInfo { name: string; version?: string; remoteAddress: string }
export interface McpServerOptions {
  controller: BrowserController;
  search?: SearchEngine;
  host?: string; // "127.0.0.1" (default, loopback only) or "0.0.0.0" (all interfaces, remote clients)
  port?: number; // 0/undefined = random free port
  token: string; // required bearer token
  allowEvaluate?: boolean; // default false; legacy switch, maps to accessLevel "full" when accessLevel is unset
  /** read: inspect only; standard (default): + navigation and input; full: + evaluate, uploads, downloads, PDF. */
  accessLevel?: AccessLevel;
  /** Ask the user to approve a new client. Return false to reject. */
  onClientConnect?: (info: McpClientInfo) => Promise<boolean>;
  /** Called for every tool invocation (for the activity log / AI badge). */
  onToolCall?: (event: { client: string; tool: string; args: unknown; at: number }) => void;
  /** Called when a tool invocation finishes (activity timeline: duration and result size). */
  onToolResult?: (event: McpToolResultEvent) => void;
}
export interface McpToolResultEvent { client: string; tool: string; at: number; durationMs: number; ok: boolean; resultChars: number }
export interface McpServerHandle {
  port: number;
  url: string;
  close(): Promise<void>;
  /** Forget a client's approval and close its open sessions. */
  revokeClient?(name: string): void;
}
export type StartMcpServer = (opts: McpServerOptions) => Promise<McpServerHandle>;

// ---- @corvus/sync-core
//   export function generateRecoveryPhrase(): string            // 24 BIP39 words
//   export function validateRecoveryPhrase(p: string): boolean
//   export function createSyncClient(opts: SyncClientOptions): SyncClient
export interface SyncStateStorage {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
}
export interface SyncClientOptions {
  serverUrl: string;
  phrase: string;
  deviceName: string;
  platform: string;
  storage: SyncStateStorage; // persists deviceId, cursor, record versions
  fetch?: typeof fetch;
}
export interface SyncItem<T = unknown> { collection: SyncCollection; id: string; payload: T | null; deleted: boolean }
export interface SyncClient {
  readonly chainId: string;
  register(): Promise<void>; // creates chain if new, registers this device
  push(items: SyncItem[]): Promise<{ conflicts: SyncItem[] }>;
  pull(): Promise<SyncItem[]>; // decrypted changes since last cursor
  listDevices(): Promise<DeviceInfo[]>;
  removeDevice(deviceId: string): Promise<void>;
  wipeChain(): Promise<void>;
}
