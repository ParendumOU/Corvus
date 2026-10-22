/**
 * IPC contracts for the Command Bar (Ctrl/Cmd+K): the agent run view pushed to the chrome UI inside
 * WindowState, and the chrome RPC methods that start and steer a run. Merged into ChromeRpc /
 * WindowState in ./ipc.ts so that file's diff stays small.
 */
import type { TabId } from "@corvus/shared";
import type { CapturedAction } from "./workflow";
import type { RunSiteHints } from "./site-memory";

export type AgentRunStatus = "running" | "paused" | "awaiting-approval" | "done" | "error" | "stopped";

export type AgentStepStatus = "running" | "ok" | "error" | "skipped";

export interface AgentRunStep {
  id: string;
  /** Tool name, or "message" for the agent's own text. */
  kind: string;
  /** Short, display-only summary of the arguments. */
  summary: string;
  /** Result preview or message text (already truncated, untrusted page text stripped of markup). */
  detail?: string;
  status: AgentStepStatus;
  /** Size of the tool result handed to the model, in characters. */
  resultChars?: number;
  at: number;
  /**
   * What a successful click/type/navigate did, in the recorder's (role, name, index) form, so the
   * run can be saved as a workflow. Absent on reads, failures and older runs.
   */
  action?: CapturedAction;
}

export interface AgentApprovalRequest {
  id: string;
  tool: string;
  summary: string;
  reason: string;
  /** A secret/challenge the user must handle in the page, not just approve. */
  handoff: boolean;
}

export interface AgentRunView {
  id: string;
  task: string;
  status: AgentRunStatus;
  steps: AgentRunStep[];
  /** The agent's closing summary, when it finished with one. */
  finalText: string;
  error: string | null;
  stepCount: number;
  maxSteps: number;
  inputTokens: number;
  outputTokens: number;
  provider: string;
  model: string;
  tabId: TabId | null;
  approval: AgentApprovalRequest | null;
  startedAt: number;
  /** The task asked to keep these steps ("this is repetitive"): offer to save a workflow at the end. */
  offerWorkflow?: boolean;
  /** Saved workflows / learned site hints the prompt carried for the start site. */
  siteHints?: RunSiteHints;
}

export interface CommandBarWindowExtras {
  agentRun: AgentRunView | null;
  /** Agent mode can run because a provider is configured. */
  agentReady: boolean;
  /** Why agent mode is unavailable (no API key, CLI missing), else null. */
  agentSetupReason: string | null;
}

export type AgentApprovalDecision = "approve" | "skip" | "stop";

export interface CommandBarChromeRpc {
  "agent.start"(task: string): void;
  "agent.stop"(): void;
  "agent.pause"(paused: boolean): void;
  "agent.approve"(decision: AgentApprovalDecision): void;
  /** Dismiss a finished run from the panel. */
  "agent.clear"(): void;
}
