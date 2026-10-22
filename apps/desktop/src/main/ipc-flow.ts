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
};

export function flowChromeHandlers(ctx: AppContext): ChromeHandlers<FlowChromeRpc> {
  return {
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
    "flow.replay": (c, id) => ctx.flows.replay(c.profile, str(id, "id", 128)),
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
