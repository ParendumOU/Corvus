/**
 * Records a browser flow in a tab and replays it as a saved macro.
 *
 * RECORD: the tab preload reports the user's clicks, field edits and submits (each as a robust,
 * snapshot-matched target); this service coalesces them — plus the tab's own top-level navigations —
 * into an ordered FlowStep list, which the user names and saves per profile (bounded count + size).
 *
 * REPLAY: each step is carried out through the EXACT action primitives the agent uses
 * (ctx.controller navigate/snapshot/click/type), with a visible step cursor, pause/stop, a per-step
 * timeout, and robust failure (a step that cannot find its target pauses with an error instead of
 * crashing). Every step is classified with the SAME agent-safety gate (classifyAction): anything
 * risky (submit/login/payment-looking) pauses for the user's approval and a secret field is never
 * typed unattended — it is handed to the user exactly like the agent's ask_user path.
 */
import { Notification, type WebContents } from "electron";
import { describeSpend, spendHost, type TabId } from "@corvus/shared";
import { classifyAction } from "../shared/agent-safety";
import {
  MAX_STEPS_PER_FLOW,
  labelForStep,
  resolveTargetRef,
  stepToToolCall,
  type FlowStep,
  type FlowTarget,
  type SavedFlow,
} from "../shared/flow";
import {
  FLOW_RECORD_SET_CHANNEL,
  type CapturedInteraction,
  type FlowApprovalDecision,
  type FlowApprovalView,
  type FlowRecordingView,
  type FlowReplayStatus,
  type FlowReplayView,
  type FlowStepStatus,
  type FlowView,
  type WorkflowDraftView,
} from "../shared/flow-ipc";
import {
  cleanTask,
  materializeFlow,
  nameFromTask,
  normalizeEdit,
  parameterizeStep,
  runToFlow,
  sitesForSteps,
  suggestParams,
  type WorkflowEdit,
  type WorkflowOutcome,
} from "../shared/workflow";
import { NEW_TAB_URL, isInternalUrl } from "../shared/internal-urls";
import type { AppContext } from "./context";
import { FlowStore } from "./flow-store";
import { SiteMemoryService } from "./site-memory-service";
import type { ProfileRuntime } from "./profiles";
import type { BrowserWindowCtl, TabRuntime } from "./window";

/** A top-level navigation within this window of a click/submit is treated as its consequence. */
const NAV_AFTER_ACTION_MS = 1500;
/** Per-step wall-clock cap for one primitive (snapshot/navigate/click/type). */
const PER_STEP_TIMEOUT_MS = 20_000;
/** Whole-replay wall-clock cap, including time spent paused for approval. */
const REPLAY_DEADLINE_MS = 10 * 60_000;
/** How many snapshots to take while waiting for a step's target to appear before failing. */
const RESOLVE_ATTEMPTS = 6;
const RESOLVE_GAP_MS = 500;

class ReplayStop extends Error {}

function errorText(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.length > 240 ? `${message.slice(0, 237)}…` : message;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

function sameTarget(a: FlowTarget | undefined, b: FlowTarget | undefined): boolean {
  return !!a && !!b && a.role === b.role && a.name === b.name && a.index === b.index;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

interface Recording {
  profileId: string;
  win: BrowserWindowCtl;
  tabId: TabId;
  phase: "recording" | "review";
  startUrl: string;
  steps: FlowStep[];
  lastInteractionAt: number;
  atCap: boolean;
  cleanup: () => void;
}

interface Replay {
  flowId: string;
  profileId: string;
  win: BrowserWindowCtl;
  tabId: TabId | null;
  flow: SavedFlow;
  status: FlowReplayStatus;
  cursor: number;
  stepStatuses: FlowStepStatus[];
  error: string | null;
  abort: AbortController;
  paused: boolean;
  resumeWaiters: Array<() => void>;
  approval: { view: FlowApprovalView; resolve: (d: FlowApprovalDecision) => void } | null;
  deadline: NodeJS.Timeout;
  /** First step whose target could not be found or whose action failed (marks the flow stale). */
  brokenStep: number | null;
  runtime: ProfileRuntime;
  /** Who started it: the person (manager / panel) or an agent (MCP run_flow). */
  by: "user" | "agent";
}

export class FlowService {
  private readonly stores = new Map<string, FlowStore>();
  private readonly recordings = new Map<string, Recording>();
  private readonly replays = new Map<string, Replay>();
  /** Pending "save as workflow" drafts, one per profile, never persisted until the user confirms. */
  private readonly drafts = new Map<string, WorkflowDraftView>();

  /** What Corvus learned about sites (site memory), per profile; changes refresh the same views. */
  readonly memory: SiteMemoryService;

  constructor(private readonly ctx: AppContext) {
    this.memory = new SiteMemoryService(ctx, (profileId) => this.pushTo(profileId));
  }

  attach(runtime: ProfileRuntime): void {
    this.storeFor(runtime);
  }

  storeFor(runtime: ProfileRuntime): FlowStore {
    let store = this.stores.get(runtime.profile.id);
    if (!store) {
      store = new FlowStore(runtime.dataDir);
      this.stores.set(runtime.profile.id, store);
      store.onChange(() => this.pushTo(runtime.profile.id));
    }
    return store;
  }

  // -------------------------------------------------------------------- views

  list(runtime: ProfileRuntime): FlowView[] {
    return this.storeFor(runtime)
      .list()
      .map((f) => ({ ...f, replay: this.replayView(f.id) }));
  }

  private replayView(flowId: string): FlowReplayView | null {
    for (const r of this.replays.values()) {
      if (r.flowId !== flowId) continue;
      return {
        flowId: r.flowId,
        status: r.status,
        cursor: r.cursor,
        total: r.flow.steps.length,
        error: r.error,
        approval: r.approval?.view ?? null,
        stepStatuses: r.stepStatuses,
        tabId: r.tabId,
      };
    }
    return null;
  }

  recordingView(profileId: string): FlowRecordingView {
    const rec = this.recordings.get(profileId);
    if (!rec) return { phase: "idle", startUrl: "", steps: [], suggestedName: "", atCap: false };
    return {
      phase: rec.phase,
      startUrl: rec.startUrl,
      steps: rec.steps,
      suggestedName: rec.phase === "review" ? `${hostOf(rec.startUrl)} flow` : "",
      atCap: rec.atCap,
    };
  }

  isRecording(win: BrowserWindowCtl): boolean {
    const rec = this.recordings.get(win.profile.profile.id);
    return rec?.phase === "recording";
  }

  // ---------------------------------------------------------------- recording

  /** The active tab if it is a web page, otherwise the window's first web tab. */
  private pickRecordTab(win: BrowserWindowCtl): TabRuntime | undefined {
    const active = win.activeTab();
    if (active && /^https?:/i.test(active.url)) return active;
    for (const t of win.listTabs()) {
      if (/^https?:/i.test(t.url)) {
        const rt = win.getTab(t.id);
        if (rt) return rt;
      }
    }
    return undefined;
  }

  /** Start recording a web tab in the window (the active one, or the first web tab). */
  startRecording(win: BrowserWindowCtl): FlowRecordingView {
    const profileId = win.profile.profile.id;
    const existing = this.recordings.get(profileId);
    if (existing) existing.cleanup();
    const tab = this.pickRecordTab(win);
    const wc = tab?.view.webContents;
    const url = tab?.url ?? "";
    if (!tab || !wc || wc.isDestroyed() || !/^https?:/i.test(url)) {
      this.recordings.delete(profileId);
      throw new Error("Open a web page in a tab, then start recording.");
    }
    if (win.activeTab()?.id !== tab.id) win.activate(tab.id);

    const onNavigate = (_e: unknown, navUrl: string): void => this.onNavigate(profileId, navUrl);
    const onDomReady = (): void => {
      if (this.recordings.get(profileId)?.phase === "recording" && !wc.isDestroyed()) wc.send(FLOW_RECORD_SET_CHANNEL, true);
    };
    wc.on("did-navigate", onNavigate);
    wc.on("dom-ready", onDomReady);
    const cleanup = (): void => {
      if (!wc.isDestroyed()) {
        wc.off("did-navigate", onNavigate);
        wc.off("dom-ready", onDomReady);
        wc.send(FLOW_RECORD_SET_CHANNEL, false);
      }
    };

    const rec: Recording = {
      profileId,
      win,
      tabId: tab.id,
      phase: "recording",
      startUrl: url,
      steps: [],
      lastInteractionAt: 0,
      atCap: false,
      cleanup,
    };
    this.recordings.set(profileId, rec);
    if (!wc.isDestroyed()) wc.send(FLOW_RECORD_SET_CHANNEL, true);
    this.pushTo(profileId);
    return this.recordingView(profileId);
  }

  stopRecording(win: BrowserWindowCtl): FlowRecordingView {
    const profileId = win.profile.profile.id;
    const rec = this.recordings.get(profileId);
    if (rec && rec.phase === "recording") {
      rec.cleanup();
      rec.phase = "review";
      this.pushTo(profileId);
    }
    return this.recordingView(profileId);
  }

  saveRecording(runtime: ProfileRuntime, name: string): FlowView[] {
    const profileId = runtime.profile.id;
    const rec = this.recordings.get(profileId);
    if (!rec || rec.phase !== "review") throw new Error("There is no finished recording to save.");
    const flow = this.storeFor(runtime).create(name, rec.startUrl, rec.steps);
    if (!flow) throw new Error("Could not save the flow — it is empty, too large, or you have reached the limit.");
    this.recordings.delete(profileId);
    this.pushTo(profileId);
    return this.list(runtime);
  }

  discardRecording(runtime: ProfileRuntime): FlowRecordingView {
    const profileId = runtime.profile.id;
    this.recordings.get(profileId)?.cleanup();
    this.recordings.delete(profileId);
    this.pushTo(profileId);
    return this.recordingView(profileId);
  }

  /** Called from the capture IPC bridge for an interaction reported by a tab preload. */
  onCaptured(tabId: TabId, profileId: string, interaction: CapturedInteraction): void {
    const rec = this.recordings.get(profileId);
    if (!rec || rec.phase !== "recording" || rec.tabId !== tabId) return;
    if (rec.steps.length >= MAX_STEPS_PER_FLOW) {
      rec.atCap = true;
      this.pushTo(profileId);
      return;
    }
    rec.lastInteractionAt = Date.now();
    this.coalesce(rec, interaction);
    this.pushTo(profileId);
  }

  private coalesce(rec: Recording, i: CapturedInteraction): void {
    const last = rec.steps[rec.steps.length - 1];
    if (i.kind === "click") {
      if (!i.target) return;
      this.pushStep(rec, { kind: "click", url: i.url, label: "", target: i.target });
      return;
    }
    if (i.kind === "input") {
      if (!i.target) return;
      if (last && last.kind === "type" && sameTarget(last.target, i.target)) {
        last.secret = i.secret === true;
        if (last.secret) delete last.value;
        else last.value = i.value ?? "";
        last.label = labelForStep(last);
        return;
      }
      const step: FlowStep = { kind: "type", url: i.url, label: "", target: i.target, submit: false, secret: i.secret === true };
      if (!step.secret) step.value = i.value ?? "";
      this.pushStep(rec, step);
      return;
    }
    // submit
    if (i.target) {
      this.pushStep(rec, { kind: "click", url: i.url, label: "", target: i.target });
    } else if (last && last.kind === "type") {
      last.submit = true;
      last.label = labelForStep(last);
    }
  }

  private pushStep(rec: Recording, step: FlowStep): void {
    step.label = labelForStep(step);
    rec.steps.push(step);
  }

  private onNavigate(profileId: string, url: string): void {
    const rec = this.recordings.get(profileId);
    if (!rec || rec.phase !== "recording") return;
    if (!/^https?:/i.test(url) || isInternalUrl(url)) return;
    if (rec.steps.length >= MAX_STEPS_PER_FLOW) {
      rec.atCap = true;
      this.pushTo(profileId);
      return;
    }
    // A navigation right after a click/submit is that action's result, not a new user step.
    if (Date.now() - rec.lastInteractionAt < NAV_AFTER_ACTION_MS) return;
    const last = rec.steps[rec.steps.length - 1];
    if (last && last.kind === "navigate" && last.url === url) return;
    if (rec.steps.length === 0 && url === rec.startUrl) return;
    this.pushStep(rec, { kind: "navigate", url, label: "" });
    this.pushTo(profileId);
  }

  // ------------------------------------------------------------------- flows

  rename(runtime: ProfileRuntime, id: string, name: string): FlowView[] {
    this.storeFor(runtime).rename(id, name);
    return this.list(runtime);
  }

  remove(runtime: ProfileRuntime, id: string): FlowView[] {
    this.stopReplayById(id);
    this.storeFor(runtime).remove(id);
    return this.list(runtime);
  }

  /** Save an edited workflow from the manager or the side panel (validated again here). */
  update(runtime: ProfileRuntime, id: string, raw: unknown): FlowView[] {
    const current = this.storeFor(runtime).get(id);
    if (!current) throw new Error("No such workflow.");
    const edit = normalizeEdit(raw, current.name);
    if (!edit) throw new Error("A workflow needs a start page and at least one step.");
    if (!this.storeFor(runtime).update(id, edit)) throw new Error("Could not save the workflow: it is too large.");
    return this.list(runtime);
  }

  /** Count a run of a workflow made by an agent (run_workflow / MCP). */
  recordRun(runtime: ProfileRuntime, id: string, outcome: WorkflowOutcome): void {
    this.storeFor(runtime).recordRun(id, outcome);
  }

  // ------------------------------------------------------------------ drafts

  draftView(profileId: string): WorkflowDraftView | null {
    return this.drafts.get(profileId) ?? null;
  }

  /**
   * Propose a finished agent run as a workflow. Only a DRAFT: the user reviews it (name, steps,
   * parameters) and confirms with saveDraft. Typed values are suggested as parameters up front.
   */
  draftFromRun(runtime: ProfileRuntime, runId: string): WorkflowDraftView {
    const run = runtime.agentRuns.get(runId);
    if (!run) throw new Error("That run is no longer in the history.");
    if (run.status === "running" || run.status === "paused" || run.status === "awaiting-approval") throw new Error("Wait for the run to finish first.");
    const converted = runToFlow(run.steps);
    if (!converted) throw new Error("This run has no replayable steps (only reads, or it ran before workflows existed).");
    let edit: WorkflowEdit = {
      name: nameFromTask(run.task),
      description: (cleanTask(run.task) || run.task).slice(0, 400),
      startUrl: converted.startUrl,
      sites: sitesForSteps(converted.startUrl, converted.steps),
      steps: converted.steps,
      params: [],
    };
    for (const s of suggestParams(edit.steps)) edit = parameterizeStep(edit, s.stepIndex, s.name);
    const acted = run.steps.filter((s) => s.kind !== "message").length;
    const kept = converted.steps.length + (run.steps.some((s) => s.action?.kind === "navigate" && s.status === "ok") ? 1 : 0);
    const draft: WorkflowDraftView = { runId, task: run.task, edit, dropped: Math.max(0, acted - kept), createdAt: Date.now() };
    this.drafts.set(runtime.profile.id, draft);
    this.pushTo(runtime.profile.id);
    return draft;
  }

  /** The user confirmed the (possibly edited) draft: save it as an agent-origin workflow. */
  saveDraft(runtime: ProfileRuntime, raw: unknown): FlowView[] {
    const draft = this.drafts.get(runtime.profile.id);
    if (!draft) throw new Error("There is no workflow waiting to be saved.");
    const edit = normalizeEdit(raw, draft.edit.name);
    if (!edit) throw new Error("A workflow needs a start page and at least one step.");
    const flow = this.storeFor(runtime).createFromEdit(edit, "agent", draft.runId);
    if (!flow) throw new Error("Could not save the workflow: it is too large, or you have reached the limit.");
    this.drafts.delete(runtime.profile.id);
    this.pushTo(runtime.profile.id);
    return this.list(runtime);
  }

  discardDraft(runtime: ProfileRuntime): null {
    this.drafts.delete(runtime.profile.id);
    this.pushTo(runtime.profile.id);
    return null;
  }

  // ------------------------------------------------------------------ replay

  replay(runtime: ProfileRuntime, id: string, params?: Record<string, string>, by: "user" | "agent" = "user"): FlowView[] {
    const profileId = runtime.profile.id;
    if (this.replays.has(profileId)) return this.list(runtime);
    const saved = this.storeFor(runtime).get(id);
    if (!saved) throw new Error("No such flow.");
    const filled = materializeFlow(saved, params);
    if (filled.missing.length > 0) throw new Error(`Fill in: ${filled.missing.join(", ")}.`);
    const flow: SavedFlow = { ...saved, startUrl: filled.startUrl, steps: filled.steps };
    const win = this.windowFor(profileId);
    const r: Replay = {
      flowId: id,
      profileId,
      win,
      tabId: null,
      flow,
      status: "running",
      cursor: 0,
      stepStatuses: flow.steps.map(() => "pending" as FlowStepStatus),
      error: null,
      abort: new AbortController(),
      paused: false,
      resumeWaiters: [],
      approval: null,
      deadline: setTimeout(() => r.abort.abort(), REPLAY_DEADLINE_MS),
      brokenStep: null,
      runtime,
      by,
    };
    this.replays.set(profileId, r);
    void this.drive(r);
    return this.list(runtime);
  }

  pauseReplay(runtime: ProfileRuntime, id: string, paused: boolean): FlowView[] {
    const r = this.replayFor(runtime.profile.id, id);
    if (r && !isFinished(r.status)) {
      r.paused = paused;
      if (paused) r.status = "paused";
      else {
        r.status = r.approval ? "awaiting-approval" : "running";
        for (const w of [...r.resumeWaiters]) w();
      }
      this.push(r);
    }
    return this.list(runtime);
  }

  stopReplay(runtime: ProfileRuntime, id: string): FlowView[] {
    this.stopReplayById(id);
    return this.list(runtime);
  }

  approve(runtime: ProfileRuntime, id: string, decision: FlowApprovalDecision): FlowView[] {
    this.replayFor(runtime.profile.id, id)?.approval?.resolve(decision);
    return this.list(runtime);
  }

  private replayFor(profileId: string, id: string): Replay | undefined {
    const r = this.replays.get(profileId);
    return r && r.flowId === id ? r : undefined;
  }

  private stopReplayById(id: string): void {
    for (const r of this.replays.values()) {
      if (r.flowId !== id) continue;
      r.approval?.resolve("stop");
      r.paused = false;
      for (const w of [...r.resumeWaiters]) w();
      r.abort.abort();
    }
  }

  private windowFor(profileId: string): BrowserWindowCtl {
    return this.ctx.windows.forProfile(profileId)[0] ?? this.ctx.windows.open(profileId);
  }

  private async drive(r: Replay): Promise<void> {
    try {
      r.tabId = r.win.createTab(r.flow.startUrl || NEW_TAB_URL, { activate: true, agent: true }).id;
      await sleep(400);
      for (let i = 0; i < r.flow.steps.length; i++) {
        if (r.abort.signal.aborted) throw new ReplayStop();
        r.cursor = i;
        r.stepStatuses[i] = "running";
        this.push(r);
        r.stepStatuses[i] = await this.executeStep(r, r.flow.steps[i]!);
        this.push(r);
      }
    } catch (err) {
      if (!(err instanceof ReplayStop)) {
        r.status = "error";
        r.error = errorText(err);
        if (r.cursor >= 0 && r.cursor < r.stepStatuses.length) r.stepStatuses[r.cursor] = "error";
      }
    } finally {
      clearTimeout(r.deadline);
      if (r.status !== "error") r.status = r.abort.signal.aborted ? "stopped" : "done";
      r.approval = null;
      this.replays.delete(r.profileId);
      this.recordReplay(r);
      this.push(r);
    }
  }

  /** Count the replay in the workflow's usage; a step that broke marks it failed (stale). */
  private recordReplay(r: Replay): void {
    const outcome: WorkflowOutcome =
      r.status === "error" || r.brokenStep !== null
        ? { status: "failed", by: r.by, error: r.error ?? "A step could not find its target.", brokenStep: r.brokenStep ?? r.cursor }
        : { status: r.status === "stopped" ? "stopped" : "ok", by: r.by };
    try {
      this.storeFor(r.runtime).recordRun(r.flowId, outcome);
    } catch {
      // Usage is bookkeeping; never let it break the replay teardown.
    }
  }

  private async executeStep(r: Replay, step: FlowStep): Promise<FlowStepStatus> {
    if (r.abort.signal.aborted) throw new ReplayStop();
    await this.waitWhilePaused(r);
    if (r.abort.signal.aborted) throw new ReplayStop();

    const { tool, input, elementName, context } = stepToToolCall(step);
    let risk = classifyAction(tool, input, elementName, context);
    if (step.secret) risk = { risky: true, handoff: true, reason: risk.reason || "This field needs your password or another secret." };

    if (risk.spend && !risk.handoff && r.by === "agent") {
      // An MCP client started this replay (run_flow): it has no run panel, so a spend gets the same
      // native "Allow once / Deny" dialog as its own clicks. Deny stops the replay.
      const allowed = await this.ctx.spendApprovals.confirm({
        client: this.ctx.agents.currentClient,
        action: describeSpend({ kind: tool === "type" ? "submit" : "click", name: elementName, url: step.url }),
        host: spendHost(step.url),
      });
      if (r.abort.signal.aborted) throw new ReplayStop();
      if (!allowed) {
        r.error = `You declined a step that spends money (${step.label}). The replay stopped there.`;
        r.stepStatuses[r.cursor] = "skipped";
        r.abort.abort();
        throw new ReplayStop();
      }
    } else if (risk.risky) {
      const decision = await this.requestApproval(r, { kind: risk.handoff ? "handoff" : "risky", title: step.label, reason: risk.reason });
      if (decision === "stop") throw new ReplayStop();
      if (decision === "skip") return "skipped";
      // A secret/sensitive handoff is performed by the user in the tab, never replayed automatically.
      if (risk.handoff) return "ok";
    }

    for (;;) {
      if (r.abort.signal.aborted) throw new ReplayStop();
      try {
        await this.perform(r, step);
        return "ok";
      } catch (err) {
        if (r.brokenStep === null) r.brokenStep = r.cursor;
        const decision = await this.requestApproval(r, { kind: "error", title: step.label, reason: errorText(err) });
        if (decision === "stop") throw new ReplayStop();
        if (decision === "skip") return "skipped";
        // approve === retry: fall through and try the step again.
      }
    }
  }

  private async perform(r: Replay, step: FlowStep): Promise<void> {
    const tabId = r.tabId;
    if (!tabId) throw new Error("The replay tab is gone.");
    const c = this.ctx.controller;
    if (step.kind === "navigate") {
      await withTimeout(c.navigate(tabId, step.url), PER_STEP_TIMEOUT_MS, "Navigation timed out.");
      return;
    }
    const ref = await this.resolveRef(r, step);
    if (step.kind === "type") {
      await withTimeout(c.type(tabId, ref, step.value ?? "", { submit: step.submit === true }), PER_STEP_TIMEOUT_MS, "Typing timed out.");
    } else {
      await withTimeout(c.click(tabId, ref), PER_STEP_TIMEOUT_MS, "Click timed out.");
    }
  }

  /** Snapshot the tab (retrying for the page to settle) and resolve the recorded target to a live ref. */
  private async resolveRef(r: Replay, step: FlowStep): Promise<string> {
    const tabId = r.tabId!;
    const target = step.target!;
    for (let attempt = 0; attempt < RESOLVE_ATTEMPTS; attempt++) {
      if (r.abort.signal.aborted) throw new ReplayStop();
      const snap = await withTimeout(this.ctx.controller.snapshot(tabId, { maxChars: 2000 }), PER_STEP_TIMEOUT_MS, "Snapshot timed out.").catch(() => null);
      if (snap) {
        const ref = resolveTargetRef(snap.elements, target);
        if (ref) return ref;
      }
      await sleep(RESOLVE_GAP_MS);
    }
    throw new Error(`Couldn't find ${step.label || "the target element"} on the page.`);
  }

  private requestApproval(r: Replay, view: FlowApprovalView): Promise<FlowApprovalDecision> {
    return new Promise<FlowApprovalDecision>((resolve) => {
      let settled = false;
      const done = (d: FlowApprovalDecision): void => {
        if (settled) return;
        settled = true;
        r.abort.signal.removeEventListener("abort", onAbort);
        if (r.approval?.resolve === done) r.approval = null;
        if (r.status === "awaiting-approval") r.status = r.paused ? "paused" : "running";
        this.push(r);
        resolve(d);
      };
      const onAbort = (): void => done("stop");
      r.abort.signal.addEventListener("abort", onAbort, { once: true });
      r.approval = { view, resolve: done };
      r.status = "awaiting-approval";
      this.surfaceForApproval(r, view);
      this.push(r);
    });
  }

  private surfaceForApproval(r: Replay, view: FlowApprovalView): void {
    if (r.tabId && !r.win.isDisposed() && r.win.hasTab(r.tabId)) {
      r.win.activate(r.tabId);
      if (!r.win.win.isDestroyed()) r.win.win.focus();
    }
    if (Notification.isSupported()) {
      const title = view.kind === "error" ? `Replay paused: ${r.flow.name}` : `Approval needed: ${r.flow.name}`;
      const n = new Notification({ title: title.slice(0, 120), body: view.reason.slice(0, 200) });
      n.on("click", () => this.windowFor(r.profileId).openSingleton("corvus://flows/"));
      n.show();
    }
  }

  private waitWhilePaused(r: Replay): Promise<void> {
    if (!r.paused || r.abort.signal.aborted) return Promise.resolve();
    r.status = "paused";
    this.push(r);
    return new Promise<void>((resolve) => {
      const finish = (): void => {
        if (!r.paused || r.abort.signal.aborted) {
          r.resumeWaiters = r.resumeWaiters.filter((w) => w !== finish);
          r.abort.signal.removeEventListener("abort", finish);
          if (!isFinished(r.status) && !r.abort.signal.aborted) r.status = r.approval ? "awaiting-approval" : "running";
          resolve();
        }
      };
      r.resumeWaiters.push(finish);
      r.abort.signal.addEventListener("abort", finish, { once: true });
    });
  }

  private push(r: Replay): void {
    this.pushTo(r.profileId);
  }

  private pushTo(profileId: string): void {
    for (const win of this.ctx.windows.forProfile(profileId)) {
      win.notifyInternalPages({ type: "flows-changed" }, ["flows"]);
      // The Workflows view of the side panel lists the same flows.
      this.ctx.assist?.refresh(win);
    }
  }

  // --------------------------------------------------------------- lifecycle

  stop(): void {
    for (const rec of this.recordings.values()) rec.cleanup();
    this.recordings.clear();
    for (const r of this.replays.values()) {
      r.approval?.resolve("stop");
      r.abort.abort();
      clearTimeout(r.deadline);
    }
    this.flush();
  }

  flush(): void {
    for (const store of this.stores.values()) store.flush();
    this.memory.flush();
  }
}

export function isFinished(status: FlowReplayStatus): boolean {
  return status === "done" || status === "error" || status === "stopped";
}

/** Validate and clamp a raw interaction from a tab preload before the recorder trusts it. */
export function parseInteraction(raw: unknown): CapturedInteraction | null {
  if (typeof raw !== "object" || raw === null) return null;
  const v = raw as Record<string, unknown>;
  if (v.kind !== "click" && v.kind !== "input" && v.kind !== "submit") return null;
  const url = typeof v.url === "string" ? v.url.slice(0, 4096) : "";
  const out: CapturedInteraction = { kind: v.kind, url };
  const t = v.target as Record<string, unknown> | undefined;
  if (t && typeof t === "object" && typeof t.role === "string" && typeof t.name === "string") {
    out.target = {
      role: t.role.slice(0, 80),
      name: t.name.slice(0, 120),
      index: typeof t.index === "number" && Number.isFinite(t.index) && t.index >= 0 ? Math.floor(t.index) : 0,
      tag: typeof t.tag === "string" ? t.tag.slice(0, 40) : "",
      selector: typeof t.selector === "string" ? t.selector.slice(0, 400) : "",
    };
  }
  if (typeof v.value === "string") out.value = v.value.slice(0, 2000);
  if (v.secret === true) out.secret = true;
  return out;
}
