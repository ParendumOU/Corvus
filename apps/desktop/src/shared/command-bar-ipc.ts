/**
 * IPC contracts for the Command Bar (Ctrl/Cmd+K): the agent run view pushed to the chrome UI inside
 * WindowState, and the chrome RPC methods that start and steer a run. Merged into ChromeRpc /
 * WindowState in ./ipc.ts so that file's diff stays small.
 */
import type { TabId } from "@corvus/shared";
import type { CommandRecent, CommandRecentKind } from "./command-history";
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
  /** One readable line for the step ("Opened github.com", "Clicked "Sign in""). */
  label?: string;
  /** Result preview or message text (already truncated, untrusted page text stripped of markup). */
  detail?: string;
  status: AgentStepStatus;
  /** Size of the tool result handed to the model, in characters. */
  resultChars?: number;
  /** A capture of the page after this step is kept with the run (see AgentRunShots). */
  shot?: true;
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
  /** Of inputTokens, those read from the prompt cache (a tenth of the price). */
  cachedInputTokens?: number;
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
  /** Why the model loop ended, once it has (step cap, token budget, ...). */
  stopReason?: "done" | "max_steps" | "aborted" | "error" | "budget";
  /** Tabs the run opened and left open for the person, once it ended. */
  leftTabs?: AgentLeftTab[];
  /** The person clicked or typed in the run's tab: it waits until they hand it back. */
  takenOver?: boolean;
}

/** A tab an agent run opened and left open for the person. */
export interface AgentLeftTab {
  id: TabId;
  title: string;
  url: string;
}

/** A Command Bar task of this window other than the one shown. */
export interface AgentTaskSummary {
  id: string;
  task: string;
  status: AgentRunStatus;
}

export interface CommandBarWindowExtras {
  agentRun: AgentRunView | null;
  /** The window's other tasks: still running in the background, or finished since. */
  agentOthers: AgentTaskSummary[];
  /** Agent mode can run because a provider is configured. */
  agentReady: boolean;
  /** Why agent mode is unavailable (no API key, CLI missing), else null. */
  agentSetupReason: string | null;
}

export type AgentApprovalDecision = "approve" | "skip" | "stop";

export interface CommandBarChromeRpc {
  /** Text of a dictation recorded in the Command Bar, from the speech-to-text service in Settings. */
  "dictation.transcribe"(audio: Uint8Array, mimeType: string): string;
  "agent.start"(task: string): void;
  "agent.stop"(): void;
  "agent.pause"(paused: boolean): void;
  "agent.approve"(decision: AgentApprovalDecision): void;
  /** The person is done using the page they took over: the run carries on. */
  "agent.handBack"(): void;
  /** Show another task of this window in the Command Bar. */
  "agent.focus"(id: string): void;
  /** Dismiss a finished run from the panel. */
  "agent.clear"(): void;
  /** The Command Bar's "Recent" list, newest first (empty when remembering is off). */
  "commands.recent"(): CommandRecent[];
  /** Remember a task, search or address run from the bar (ignored when remembering is off). */
  "commands.remember"(kind: CommandRecentKind, text: string): void;
  "commands.forget"(id: string): CommandRecent[];
}
