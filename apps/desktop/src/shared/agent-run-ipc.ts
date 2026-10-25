/**
 * IPC contract for the agent run history. The corvus://agent-runs page talks InternalRpc.
 * Merged into InternalRpc / InternalEvent in ./ipc.ts so that file's diff stays small.
 */
import type { AgentRunRecord } from "./agent-run";

/** Outcome of a resume request (the run continues in the page's window, or is declined with a reason). */
export interface AgentResumeResult {
  ok: boolean;
  reason?: string;
}

export interface AgentRunsInternalRpc {
  "agentRuns.list"(): AgentRunRecord[];
  "agentRuns.get"(id: string): AgentRunRecord | null;
  "agentRuns.remove"(id: string): AgentRunRecord[];
  "agentRuns.clear"(): AgentRunRecord[];
  /** Continue an interrupted/incomplete run from its saved step state, within the approval gate + caps. */
  "agentRuns.resume"(id: string): AgentResumeResult;
  /** The captures kept with a run, as data: URLs by step id. */
  "agentRuns.shots"(id: string): Record<string, string>;
}

export type AgentRunsInternalEvent = { type: "agent-runs-changed" };
