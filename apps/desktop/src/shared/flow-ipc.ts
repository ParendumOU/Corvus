/**
 * IPC contract for recorded flows. The corvus://flows manager talks InternalRpc; the browser chrome
 * starts/stops recording over ChromeRpc. Merged into InternalRpc / ChromeRpc / InternalEvent in
 * ./ipc.ts so that file's diff stays small.
 */
import type { TabId } from "@corvus/shared";
import type { FlowStep } from "./flow";

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

export interface FlowView {
  id: string;
  name: string;
  startUrl: string;
  steps: FlowStep[];
  createdAt: number;
  updatedAt: number;
  /** Non-null while this flow is replaying. */
  replay: FlowReplayView | null;
}

export type FlowApprovalDecision = "approve" | "skip" | "stop";

export interface FlowChromeRpc {
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
  /** Play a saved flow back in a new tab. */
  "flow.replay"(id: string): FlowView[];
  "flow.pauseReplay"(id: string, paused: boolean): FlowView[];
  "flow.stopReplay"(id: string): FlowView[];
  /** Resolve a pending approval (risky action, secret handoff or a failed step). */
  "flow.approve"(id: string, decision: FlowApprovalDecision): FlowView[];
}

export type FlowInternalEvent = { type: "flows-changed" };
