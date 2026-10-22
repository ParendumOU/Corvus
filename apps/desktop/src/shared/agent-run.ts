/**
 * Durable model for in-browser agent runs: the per-profile record shown on corvus://agent-runs and
 * the pure helpers that decide whether a run can be resumed and build the recent-run memory note.
 *
 * The record here is the view half (no model transcript); the store keeps the transcript alongside it
 * so an interrupted run can continue from where it stopped. Pure (no node/Electron) so it is unit
 * tested and safe for both tsconfig projects.
 */
import type { AgentRunStatus, AgentRunStep } from "./command-bar-ipc";
import type { RunSiteHints } from "./site-memory";

export type AgentRunSource = "command-bar" | "scheduled";

/** Why the model loop ended (mirrors ai-engine AgentStopReason); null while a run is in flight. */
export type AgentRunStopReason = "done" | "max_steps" | "aborted" | "error" | "budget" | null;

/** A run status as stored: the live states plus "interrupted" for a run cut off by an app restart. */
export type StoredRunStatus = AgentRunStatus | "interrupted";

/** One persisted agent run as shown on corvus://agent-runs. The model transcript is kept separately. */
export interface AgentRunRecord {
  id: string;
  task: string;
  source: AgentRunSource;
  status: StoredRunStatus;
  stopReason: AgentRunStopReason;
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
  startedAt: number;
  endedAt: number | null;
  /** A continuation point survives, so the run can be resumed within the step/token caps. */
  resumable: boolean;
  /** Whether learned hints / saved workflows were in the prompt (to compare runs with and without). */
  siteHints?: RunSiteHints;
}

/** Cap stored runs per profile; the oldest are pruned. */
export const MAX_STORED_RUNS = 50;
/** Cap the saved transcript (whole assistant/user turn pairs beyond the head are dropped). */
export const MAX_TRANSCRIPT_MESSAGES = 60;
/** Cap each saved tool-result/text block so one giant page can't bloat the store. */
export const MAX_BLOCK_CHARS = 8000;
/** How many prior runs feed the recent-run memory note handed to a new run. */
export const RECENT_MEMORY_RUNS = 3;
export const RECENT_MEMORY_SUMMARY_CHARS = 220;

/** Statuses that represent a run that stopped before the model declared itself finished. */
const INTERRUPTED_LIVE: ReadonlySet<StoredRunStatus> = new Set(["running", "paused", "awaiting-approval"]);

/** Map a persisted status to its load-time value: a live status means the app died mid-run. */
export function statusOnLoad(status: StoredRunStatus): StoredRunStatus {
  return INTERRUPTED_LIVE.has(status) ? "interrupted" : status;
}

/**
 * Whether a run can be continued from its transcript. Interrupted, stopped and errored runs resume;
 * a run that completed under a cap (max_steps / budget) resumes to go further; a cleanly finished run
 * does not. The store also requires a non-empty transcript before it marks a record resumable.
 */
export function isResumableStatus(status: StoredRunStatus, stopReason: AgentRunStopReason): boolean {
  if (INTERRUPTED_LIVE.has(status) || status === "interrupted") return true;
  if (status === "stopped" || status === "error") return true;
  if (status === "done") return stopReason === "max_steps" || stopReason === "budget";
  return false;
}

/** A compact, bounded digest of recent successful runs, for a new run to reference. Empty when none. */
export function recentRunMemoryNote(records: readonly AgentRunRecord[]): string {
  const done = records
    .filter((r) => r.status === "done" && r.finalText.trim().length > 0)
    .slice(0, RECENT_MEMORY_RUNS);
  if (done.length === 0) return "";
  const lines = done.map((r) => `- ${r.task.replace(/\s+/g, " ").slice(0, 120)} -> ${r.finalText.replace(/\s+/g, " ").trim().slice(0, RECENT_MEMORY_SUMMARY_CHARS)}`);
  return `For context, here is what earlier Corvus runs found (reference only, may be stale; verify before relying on it):\n${lines.join("\n")}`;
}
