import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { CallToolResult, ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import type { AccessLevel, AgentCapabilities, BrowserController } from "@corvus/shared";
import type { WebScopeEngine } from "@corvus/webscope";
import { z } from "zod";
import { UNTRUSTED_NOTE, wrapUntrusted } from "../content.js";

export type ToolExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

/** Resolves the WebScope engine for the active profile, or null when WebScope is disabled. */
export type WebScopeProvider = () => WebScopeEngine | null;

export interface FlowSummary {
  id: string;
  name: string;
  startUrl: string;
  steps: number;
  /** Optional workflow metadata (desktop fills these; older providers may not). */
  description?: string;
  /** Hosts the workflow applies to (subdomains match too). */
  sites?: string[];
  /** Names of its {{parameters}}. */
  params?: string[];
  origin?: "recorded" | "agent";
  lastStatus?: string | null;
}

/** One saved flow with its steps, for clients that want to follow or adapt it. */
export interface FlowDetail extends FlowSummary {
  paramDetails: Array<{ name: string; label: string; default: string }>;
  stepList: Array<{ kind: string; label: string; url?: string; target?: { role: string; name: string; index: number }; value?: string; submit?: boolean; secret?: boolean }>;
}

export interface FlowRunResult {
  id: string;
  name: string;
  steps: number;
  /** Replay status the service reports, e.g. "running". */
  status: string;
}

/** Lists and replays the active profile's saved recorded flows. Replay keeps its own human-approval gate. */
export interface FlowRunner {
  /** Saved flows, optionally only those that apply to `host`. */
  list(host?: string): FlowSummary[] | Promise<FlowSummary[]>;
  /** One flow with its steps (matched by id or name); throws when none matches. Optional for older providers. */
  read?(nameOrId: string): FlowDetail | Promise<FlowDetail>;
  /** Starts replaying the flow matched by id or name with values for its parameters; throws when none matches or a value is missing. */
  run(nameOrId: string, params?: Record<string, string>): FlowRunResult | Promise<FlowRunResult>;
}

/** Compact hints Corvus learned about one host (no typed values, no secrets). */
export type SiteMemoryHints = { host: string } & Record<string, unknown>;

/** Reads what Corvus learned about sites. "disabled" when the user turned site memory off. */
export interface SiteMemoryReader {
  hints(host: string): SiteMemoryHints | null | "disabled" | Promise<SiteMemoryHints | null | "disabled">;
}

/** Resolves the site-memory reader for the active profile, or null when unavailable. */
export type SiteMemoryProvider = () => SiteMemoryReader | null;

/** Resolves the recorded-flows runner for the active profile, or null when flows are unavailable. */
export type FlowProvider = () => FlowRunner | null;

export interface ToolConfig<S extends z.ZodRawShape> {
  description: string;
  inputSchema: S;
  readOnly?: boolean;
  /** Optional browser capability the tool runs on; the tool is not offered when the controller lacks it. */
  requires?: keyof AgentCapabilities;
}

export type Register = <S extends z.ZodRawShape>(
  name: string,
  config: ToolConfig<S>,
  run: (args: z.infer<z.ZodObject<S>>, signal: AbortSignal, extra: ToolExtra) => Promise<CallToolResult>,
) => void;

export interface ToolContext {
  controller: BrowserController;
  register: Register;
  resolveTab(id: string | undefined): Promise<string>;
  level: AccessLevel;
  /** Present when the app wired in WebScope; the tools gate on this and the full access level. */
  webscope?: WebScopeProvider;
  /** Present when the app wired in recorded flows; run_flow gates on this and the full access level. */
  flows?: FlowProvider;
  /** Present when the app wired in site memory; site_memory gates on this (standard level). */
  siteMemory?: SiteMemoryProvider;
  /** Name of the connected MCP client. */
  client: () => string;
}

export const tabId = z.string().min(1).max(200);
export const optionalTabId = tabId.optional().describe("Tab id; defaults to the active tab");
export const ref = z.string().min(1).max(200).describe("Element ref from page_snapshot or find");
export const coord = z.number().min(0).max(100000);

export function text(value: string): CallToolResult {
  return { content: [{ type: "text", text: value }] };
}

export function untrusted(source: string, body: string, trustedNote?: string): CallToolResult {
  const parts = [UNTRUSTED_NOTE, wrapUntrusted(source, body)];
  if (trustedNote) parts.push(trustedNote);
  return text(parts.join("\n"));
}

export function errorResult(message: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text: message }] };
}

export const OK = text("ok");

/** Fails with a clear message when the browser build lacks a capability. */
export function need<T>(fn: T | undefined, tool: string): T {
  if (!fn) throw new Error(`${tool} is not supported by this browser build`);
  return fn;
}

/** Drops undefined values so optional fields are not sent as explicit undefined. */
export function defined<T extends Record<string, unknown>>(obj: T): { [K in keyof T]: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as { [K in keyof T]: Exclude<T[K], undefined> };
}
