import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { CallToolResult, ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import type { AccessLevel, BrowserController } from "@corvus/shared";
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
  list(): FlowSummary[] | Promise<FlowSummary[]>;
  /** Starts replaying the flow matched by id or name; throws when none matches. */
  run(nameOrId: string): FlowRunResult | Promise<FlowRunResult>;
}

/** Resolves the recorded-flows runner for the active profile, or null when flows are unavailable. */
export type FlowProvider = () => FlowRunner | null;

export interface ToolConfig<S extends z.ZodRawShape> {
  description: string;
  inputSchema: S;
  readOnly?: boolean;
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
