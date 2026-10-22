/**
 * IPC wiring for recorded flows: the corvus://flows manager (InternalRpc), the browser chrome's
 * start/stop-recording controls (ChromeRpc) and the one-way capture bridge a tab preload uses to
 * report interactions while recording. Spread into ipc.ts so that file's diff stays small.
 */
import { ipcMain, type IpcMainEvent } from "electron";
import { FLOW_CAPTURE_CHANNEL, type FlowApprovalDecision, type FlowChromeRpc, type FlowInternalRpc } from "../shared/flow-ipc";
import type { InternalPage } from "../shared/internal-urls";
import type { AppContext } from "./context";
import { parseInteraction } from "./flow-service";
import type { ProfileRuntime } from "./profiles";
import type { BrowserWindowCtl } from "./window";

class IpcError extends Error {}

const str = (value: unknown, name: string, max = 4096): string => {
  if (typeof value !== "string" || value.length > max) throw new IpcError(`Invalid ${name}`);
  return value;
};

/** Parameter values from a renderer: a flat object of short strings. */
export function paramValues(value: unknown): Record<string, string> | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) throw new IpcError("Invalid parameters");
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>).slice(0, 24)) {
    if (typeof v !== "string" || k.length > 60 || v.length > 2000) throw new IpcError("Invalid parameters");
    out[k] = v;
  }
  return out;
}

function decision(value: unknown): FlowApprovalDecision {
  if (value === "approve" || value === "skip" || value === "stop") return value;
  throw new IpcError("Invalid decision");
}

interface InternalContext {
  profile: ProfileRuntime;
  window: BrowserWindowCtl | undefined;
}

type InternalHandlers<T> = {
  [K in keyof T]: T[K] extends (...args: infer A) => infer R ? (c: InternalContext, ...args: A) => R | Promise<Awaited<R>> : never;
};

type ChromeHandlers<T> = {
  [K in keyof T]: T[K] extends (...args: infer A) => infer R ? (w: BrowserWindowCtl, ...args: A) => R | Promise<Awaited<R>> : never;
};

export const FLOW_INTERNAL_PERMISSIONS: Record<keyof FlowInternalRpc, readonly InternalPage[]> = {
  "flow.list": ["flows"],
  "flow.recording": ["flows"],
  "flow.startRecording": ["flows"],
  "flow.stopRecording": ["flows"],
  "flow.saveRecording": ["flows"],
  "flow.discardRecording": ["flows"],
  "flow.rename": ["flows"],
  "flow.remove": ["flows"],
  "flow.replay": ["flows"],
  "flow.pauseReplay": ["flows"],
  "flow.stopReplay": ["flows"],
  "flow.approve": ["flows"],
  "flow.update": ["flows"],
  "flow.draft": ["flows"],
  "flow.draftFromRun": ["flows", "agent-runs"],
  "flow.saveDraft": ["flows"],
  "flow.discardDraft": ["flows"],
  "memory.state": ["flows"],
  "memory.removeHint": ["flows"],
  "memory.forget": ["flows"],
  "memory.forgetAll": ["flows"],
  "memory.setEnabled": ["flows"],
};

const HINT_KINDS = ["target", "url", "obstacle", "sequence"] as const;
export function hintKind(value: unknown): (typeof HINT_KINDS)[number] {
  if (typeof value === "string" && (HINT_KINDS as readonly string[]).includes(value)) return value as (typeof HINT_KINDS)[number];
  throw new IpcError("Invalid hint kind");
}

export function flowChromeHandlers(ctx: AppContext): ChromeHandlers<FlowChromeRpc> {
  return {
    "workflow.saveFromRun": (w) => {
      const runId = ctx.agentRunner.windowExtras(w).agentRun?.id;
      if (!runId) throw new IpcError("There is no finished run to save.");
      ctx.flows.draftFromRun(w.profile, runId);
      ctx.assist.open(w, "workflows");
    },
    "flow.startRecording": (w) => void ctx.flows.startRecording(w),
    "flow.stopRecording": (w) => void ctx.flows.stopRecording(w),
  };
}

function requireWindow(c: InternalContext): BrowserWindowCtl {
  if (!c.window) throw new IpcError("No window for this page");
  return c.window;
}

export function flowInternalHandlers(ctx: AppContext): InternalHandlers<FlowInternalRpc> {
  return {
    "flow.list": (c) => ctx.flows.list(c.profile),
    "flow.recording": (c) => ctx.flows.recordingView(c.profile.profile.id),
    "flow.startRecording": (c) => ctx.flows.startRecording(requireWindow(c)),
    "flow.stopRecording": (c) => ctx.flows.stopRecording(requireWindow(c)),
    "flow.saveRecording": (c, name) => ctx.flows.saveRecording(c.profile, str(name, "name", 200)),
    "flow.discardRecording": (c) => ctx.flows.discardRecording(c.profile),
    "flow.rename": (c, id, name) => ctx.flows.rename(c.profile, str(id, "id", 128), str(name, "name", 200)),
    "flow.remove": (c, id) => ctx.flows.remove(c.profile, str(id, "id", 128)),
    "flow.replay": (c, id, params) => ctx.flows.replay(c.profile, str(id, "id", 128), paramValues(params)),
    "flow.update": (c, id, edit) => ctx.flows.update(c.profile, str(id, "id", 128), edit),
    "flow.draft": (c) => ctx.flows.draftView(c.profile.profile.id),
    "flow.draftFromRun": (c, runId) => ctx.flows.draftFromRun(c.profile, str(runId, "run id", 128)),
    "flow.saveDraft": (c, edit) => ctx.flows.saveDraft(c.profile, edit),
    "flow.discardDraft": (c) => ctx.flows.discardDraft(c.profile),
    "memory.state": (c) => ctx.flows.memory.state(c.profile),
    "memory.removeHint": (c, host, kind, key) => {
      ctx.flows.memory.removeHint(c.profile, str(host, "host", 300), hintKind(kind), str(key, "key", 400));
      return ctx.flows.memory.state(c.profile);
    },
    "memory.forget": (c, host) => {
      ctx.flows.memory.forget(c.profile, str(host, "host", 300));
      return ctx.flows.memory.state(c.profile);
    },
    "memory.forgetAll": (c) => {
      ctx.flows.memory.forgetAll(c.profile);
      return ctx.flows.memory.state(c.profile);
    },
    "memory.setEnabled": (c, on) => {
      ctx.flows.memory.setEnabled(on === true);
      return ctx.flows.memory.state(c.profile);
    },
    "flow.pauseReplay": (c, id, paused) => ctx.flows.pauseReplay(c.profile, str(id, "id", 128), paused === true),
    "flow.stopReplay": (c, id) => ctx.flows.stopReplay(c.profile, str(id, "id", 128)),
    "flow.approve": (c, id, d) => ctx.flows.approve(c.profile, str(id, "id", 128), decision(d)),
  };
}

/** Receives captured interactions from tab preloads (one-way; the sender is re-validated as a tab). */
export function registerFlowCapture(ctx: AppContext): void {
  ipcMain.on(FLOW_CAPTURE_CHANNEL, (event: IpcMainEvent, raw: unknown) => {
    const found = ctx.windows.byTabWebContents(event.sender);
    if (!found || event.senderFrame !== event.sender.mainFrame) return;
    const profile = ctx.profiles.bySession(event.sender.session);
    if (!profile) return;
    const interaction = parseInteraction(raw);
    if (interaction) ctx.flows.onCaptured(found.tab.id, profile.profile.id, interaction);
  });
}
