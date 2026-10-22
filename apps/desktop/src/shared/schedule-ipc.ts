/**
 * IPC contract for scheduled AI agents. The corvus://schedules manager talks InternalRpc.
 * Merged into InternalRpc / InternalEvent in ./ipc.ts so that file's diff stays small.
 */
import type { AgentApprovalDecision } from "./command-bar-ipc";
import type { ScheduleKind, ScheduleRunRecord } from "./schedule";

/** Shown on the manager while a run is paused waiting for the user to approve a risky action. */
export interface ScheduleApprovalView {
  tool: string;
  summary: string;
  reason: string;
  /** A secret/challenge the user must handle in the page, not just approve. */
  handoff: boolean;
}

export interface ScheduleView {
  id: string;
  name: string;
  task: string;
  kind: ScheduleKind;
  cron: string;
  intervalMinutes: number;
  paused: boolean;
  createdAt: number;
  nextRunAt: number | null;
  maxSteps: number;
  /** A run is executing right now (in a background tab). */
  running: boolean;
  /** Non-null while the current run is paused for the user's approval. */
  approval: ScheduleApprovalView | null;
  lastRun: ScheduleRunRecord | null;
  history: ScheduleRunRecord[];
}

/** User-editable fields when adding or editing a schedule. */
export interface ScheduleInput {
  name: string;
  task: string;
  kind: ScheduleKind;
  cron?: string;
  intervalMinutes?: number;
  maxSteps?: number;
}

export interface ScheduleInternalRpc {
  "schedule.list"(): ScheduleView[];
  "schedule.add"(input: ScheduleInput): ScheduleView[];
  "schedule.update"(id: string, input: ScheduleInput): ScheduleView[];
  "schedule.remove"(id: string): ScheduleView[];
  "schedule.pause"(id: string, paused: boolean): ScheduleView[];
  /** Fire a schedule immediately, ignoring its cadence. */
  "schedule.runNow"(id: string): ScheduleView[];
  /** Cancel the in-flight run of a schedule. */
  "schedule.cancel"(id: string): ScheduleView[];
  /** Resolve a pending risky-action approval for the schedule's current run. */
  "schedule.approve"(id: string, decision: AgentApprovalDecision): ScheduleView[];
}

export type ScheduleInternalEvent = { type: "schedules-changed" };
