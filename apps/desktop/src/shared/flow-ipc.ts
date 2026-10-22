/**
 * IPC contract for recorded flows. The corvus://flows manager talks InternalRpc; the browser chrome
 * starts/stops recording over ChromeRpc. Merged into InternalRpc / ChromeRpc / InternalEvent in
 * ./ipc.ts so that file's diff stays small.
 */
import type { TabId } from "@corvus/shared";
import type { FlowStep, SavedFlow } from "./flow";
import type { WorkflowEdit } from "./workflow";
import type { MemoryHintKind, MemoryStats, SiteMemoryEntry } from "./site-memory";

/** The Learned tab for one site. */
export interface SiteMemoryPaneView {
  /** The "Learn from runs" setting. */
  enabled: boolean;
  entry: SiteMemoryEntry | null;
  /** Runs on this site with and without injected hints. */
  stats: MemoryStats;
  totalHosts: number;
}

/** Everything learned, for the manager page. */
export interface SiteMemoryState {
  enabled: boolean;
  entries: SiteMemoryEntry[];
  stats: MemoryStats;
}

/** One-way channel: the tab preload reports a captured user interaction while recording. */
export const FLOW_CAPTURE_CHANNEL = "corvus:flow-captured";
/** Main -> tab preload: turn interaction capture on/off for this document. */
export const FLOW_RECORD_SET_CHANNEL = "corvus:flow-record-set";

/** Raw interaction captured in the page and handed to the recorder (coalesced into FlowSteps). */
export interface CapturedInteraction {
  kind: "click" | "input" | "submit";
  url: string;
  target?: FlowStep["target"];
  value?: string;
  secret?: boolean;
}

export type FlowRecordingPhase = "idle" | "recording" | "review";

/** Live recording state for the manager page. `steps` is the growing capture. */
export interface FlowRecordingView {
  phase: FlowRecordingPhase;
  startUrl: string;
  steps: FlowStep[];
  /** Proposed name in the review (save) phase. */
  suggestedName: string;
  atCap: boolean;
}

export type FlowReplayStatus = "running" | "paused" | "awaiting-approval" | "done" | "error" | "stopped";

export type FlowStepStatus = "pending" | "running" | "ok" | "error" | "skipped";

/** Shown while a replay is paused: a risky action to approve, a secret handoff, or a failed step. */
export interface FlowApprovalView {
  kind: "risky" | "handoff" | "error";
  /** Step label the prompt is about. */
  title: string;
  reason: string;
}

export interface FlowReplayView {
  flowId: string;
  status: FlowReplayStatus;
  /** Index of the step currently executing (or that failed), 0-based. */
  cursor: number;
  total: number;
  error: string | null;
  approval: FlowApprovalView | null;
  stepStatuses: FlowStepStatus[];
  tabId: TabId | null;
}

/** A saved flow/workflow as the manager and the side panel see it. */
export interface FlowView extends SavedFlow {
  /** Non-null while this flow is replaying. */
  replay: FlowReplayView | null;
}

/**
 * A workflow proposed from a finished agent run, waiting for the user to review and confirm it.
 * Nothing is saved until the user clicks Save; one pending draft per profile, held in memory.
 */
export interface WorkflowDraftView {
  runId: string;
  task: string;
  edit: WorkflowEdit;
  /** Steps of the run that were not kept (failed, skipped, reads), for the review text. */
  dropped: number;
  createdAt: number;
}

export type FlowApprovalDecision = "approve" | "skip" | "stop";

export interface FlowChromeRpc {
  /**
   * Propose the window's finished Command Bar run as a workflow: builds a draft and opens the
   * Workflows side panel to review it. Never saves by itself.
   */
  "workflow.saveFromRun"(): void;
  /** Start recording the given tab's interactions (the active tab when omitted). */
  "flow.startRecording"(tabId: TabId | null): void;
  /** Stop capturing and move to the review/save phase (recorded steps are held). */
  "flow.stopRecording"(): void;
}

export interface FlowInternalRpc {
  "flow.list"(): FlowView[];
  "flow.recording"(): FlowRecordingView;
  /** Begin recording the caller window's active tab, then return to browsing. */
  "flow.startRecording"(): FlowRecordingView;
  "flow.stopRecording"(): FlowRecordingView;
  /** Persist the reviewed recording under a name; returns the updated flow list. */
  "flow.saveRecording"(name: string): FlowView[];
  /** Throw away a finished recording without saving. */
  "flow.discardRecording"(): FlowRecordingView;
  "flow.rename"(id: string, name: string): FlowView[];
  "flow.remove"(id: string): FlowView[];
  /** Play a saved flow back in a new tab, with values for its `{{params}}` (missing ones throw). */
  "flow.replay"(id: string, params?: Record<string, string>): FlowView[];
  /** Save an edited workflow (rename, description, sites, steps, parameters). */
  "flow.update"(id: string, edit: WorkflowEdit): FlowView[];
  /** The pending workflow draft, if any. */
  "flow.draft"(): WorkflowDraftView | null;
  /** Build a draft from a finished agent run (corvus://agent-runs "Save as workflow"). */
  "flow.draftFromRun"(runId: string): WorkflowDraftView;
  /** Confirm the draft (after the user's edits) and save it as a workflow. */
  "flow.saveDraft"(edit: WorkflowEdit): FlowView[];
  "flow.discardDraft"(): null;
  /** Site memory (the Learned view): list, edit (remove a hint), forget, switch on/off. */
  "memory.state"(): SiteMemoryState;
  "memory.removeHint"(host: string, kind: MemoryHintKind, key: string): SiteMemoryState;
  "memory.forget"(host: string): SiteMemoryState;
  "memory.forgetAll"(): SiteMemoryState;
  "memory.setEnabled"(on: boolean): SiteMemoryState;
  "flow.pauseReplay"(id: string, paused: boolean): FlowView[];
  "flow.stopReplay"(id: string): FlowView[];
  /** Resolve a pending approval (risky action, secret handoff or a failed step). */
  "flow.approve"(id: string, decision: FlowApprovalDecision): FlowView[];
}

export type FlowInternalEvent = { type: "flows-changed" };
