/**
 * Runs scheduled AI agent tasks in the background. On its due tick (driven by the single page-monitor
 * timer, never a second one) it fires each due schedule: it drives the SAME agent loop the Command
 * Bar uses (runAgent + the shared TOOLS / AGENT_SYSTEM / executor), but in a background tab, under
 * strict step and token caps, and with a scheduled-run approval gate that NEVER auto-approves — a
 * risky action (or a secret/CAPTCHA handoff, or ask_user) pauses the run, surfaces its tab and raises
 * a notification until the user approves, skips or stops it on corvus://schedules. When the run ends
 * it captures the agent's summary, closes the tab, records the result and notifies, exactly like the
 * watches change alert.
 */
import crypto from "node:crypto";
import { Notification } from "electron";
import { AgentStopError, runAgent, type AgentModelProvider, type AgentStep, type AgentToolResult, type ToolExecutor } from "@corvus/ai-engine";
import type { TabId } from "@corvus/shared";
import { summarizeArgs } from "../shared/agent-activity";
import { classifyAction } from "../shared/agent-safety";
import type { AgentApprovalDecision } from "../shared/command-bar-ipc";
import { NEW_TAB_URL } from "../shared/internal-urls";
import { MAX_CONCURRENT_RUNS, clampMaxSteps, selectDueSchedules, type AgentSchedule, type ScheduleRunRecord } from "../shared/schedule";
import type { ScheduleApprovalView, ScheduleInput, ScheduleView } from "../shared/schedule-ipc";
import { AGENT_SYSTEM, PER_TURN_TOKENS, TOOLS, argStr, providerFromSettings, runAgentTool, type ToolRunState } from "./agent-tools";
import type { AppContext } from "./context";
import type { ProfileRuntime } from "./profiles";
import { ScheduleStore } from "./schedule-store";
import type { BrowserWindowCtl } from "./window";

/** Name shown in the shared agent-activity timeline for scheduled runs. */
const SCHED_CLIENT = "Corvus (scheduled)";
const SCHEDULES_URL = "corvus://schedules/";
const SUMMARY_CHARS = 400;
/** Wall-clock cap for one run, including any time it spends paused waiting for approval. */
const RUN_DEADLINE_MS = 10 * 60_000;

interface ActiveRun extends ToolRunState {
  schedule: AgentSchedule;
  profileId: string;
  win: BrowserWindowCtl;
  record: ScheduleRunRecord;
  finalText: string;
  abort: AbortController;
  cancelled: boolean;
  deadline: NodeJS.Timeout;
  approval: { view: ScheduleApprovalView; resolve: (d: AgentApprovalDecision) => void } | null;
}

function errorText(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.length > 300 ? `${message.slice(0, 297)}…` : message;
}

export class ScheduledAgentRunner {
  private readonly stores = new Map<string, ScheduleStore>();
  private readonly active = new Map<string, ActiveRun>();
  /** Schedule ids with a run in flight (global; ids are unique uuids). */
  private readonly running = new Set<string>();
  private testProvider: AgentModelProvider | null | undefined;

  constructor(private readonly ctx: AppContext) {}

  /** Smoke/tests inject a fake provider; `undefined` restores the configured one. */
  setTestProvider(provider: AgentModelProvider | null | undefined): void {
    this.testProvider = provider;
  }

  private provider(): AgentModelProvider | null {
    if (this.testProvider !== undefined) return this.testProvider;
    return providerFromSettings(this.ctx);
  }

  attach(runtime: ProfileRuntime): void {
    this.storeFor(runtime);
  }

  storeFor(runtime: ProfileRuntime): ScheduleStore {
    let store = this.stores.get(runtime.profile.id);
    if (!store) {
      store = new ScheduleStore(runtime.dataDir, () => 50);
      this.stores.set(runtime.profile.id, store);
      store.onChange(() => this.pushTo(runtime.profile.id));
    }
    return store;
  }

  // ------------------------------------------------------------------- scheduling

  /** Driven by the page-monitor's single poll timer. No-op unless scheduled agents are enabled. */
  tick(): void {
    if (!this.ctx.settings.get().scheduledAgents.enabled) return;
    const owners = new Map<string, string>();
    const all: AgentSchedule[] = [];
    for (const [profileId, store] of this.stores) {
      for (const s of store.list()) {
        owners.set(s.id, profileId);
        all.push(s);
      }
    }
    const due = selectDueSchedules(all, { now: Date.now(), running: this.running, maxConcurrent: MAX_CONCURRENT_RUNS });
    for (const s of due) {
      const profileId = owners.get(s.id);
      if (profileId) void this.fire(profileId, s);
    }
  }

  // ------------------------------------------------------------------- manager API

  list(runtime: ProfileRuntime): ScheduleView[] {
    return this.views(runtime);
  }

  add(runtime: ProfileRuntime, input: ScheduleInput): ScheduleView[] {
    this.storeFor(runtime).add(input);
    return this.views(runtime);
  }

  update(runtime: ProfileRuntime, id: string, input: ScheduleInput): ScheduleView[] {
    this.storeFor(runtime).update(id, input);
    return this.views(runtime);
  }

  remove(runtime: ProfileRuntime, id: string): ScheduleView[] {
    this.cancelRun(id, true);
    this.storeFor(runtime).remove(id);
    return this.views(runtime);
  }

  pause(runtime: ProfileRuntime, id: string, paused: boolean): ScheduleView[] {
    this.storeFor(runtime).pause(id, paused);
    return this.views(runtime);
  }

  runNow(runtime: ProfileRuntime, id: string): ScheduleView[] {
    this.storeFor(runtime).runNow(id);
    this.tick();
    return this.views(runtime);
  }

  cancel(runtime: ProfileRuntime, id: string): ScheduleView[] {
    this.cancelRun(id, true);
    return this.views(runtime);
  }

  approve(runtime: ProfileRuntime, id: string, decision: AgentApprovalDecision): ScheduleView[] {
    this.active.get(id)?.approval?.resolve(decision);
    return this.views(runtime);
  }

  views(runtime: ProfileRuntime): ScheduleView[] {
    const store = this.storeFor(runtime);
    return store.list().map((s) => {
      const run = this.active.get(s.id);
      return {
        id: s.id,
        name: s.name,
        task: s.task,
        kind: s.kind,
        cron: s.cron,
        intervalMinutes: s.intervalMinutes,
        paused: s.paused,
        createdAt: s.createdAt,
        nextRunAt: s.nextRunAt,
        maxSteps: s.maxSteps,
        running: run !== undefined,
        approval: run?.approval?.view ?? null,
        lastRun: run ? run.record : s.lastRun,
        history: s.history,
      };
    });
  }

  // ------------------------------------------------------------------- the run

  private cancelRun(id: string, cancelled: boolean): void {
    const run = this.active.get(id);
    if (!run) return;
    run.cancelled = cancelled;
    run.approval?.resolve("stop");
    run.abort.abort();
  }

  private windowFor(profileId: string): BrowserWindowCtl {
    return this.ctx.windows.forProfile(profileId)[0] ?? this.ctx.windows.open(profileId);
  }

  private async fire(profileId: string, schedule: AgentSchedule): Promise<void> {
    if (this.running.has(schedule.id)) return;
    this.running.add(schedule.id);
    const store = this.stores.get(profileId);
    const record: ScheduleRunRecord = {
      id: crypto.randomUUID(),
      startedAt: Date.now(),
      endedAt: null,
      status: "running",
      summary: "",
      error: null,
      steps: 0,
      inputTokens: 0,
      outputTokens: 0,
    };

    const provider = this.provider();
    if (!provider || !store) {
      record.status = "error";
      record.endedAt = Date.now();
      record.error = "Agent mode is not configured. Add an API key or Claude Code login in Settings.";
      record.summary = record.error;
      this.running.delete(schedule.id);
      if (store) {
        store.finishRun(schedule.id, record);
        this.notifyResult(profileId, schedule, record);
      }
      return;
    }

    const win = this.windowFor(profileId);
    const run: ActiveRun = {
      schedule,
      profileId,
      win,
      record,
      finalText: "",
      abort: new AbortController(),
      cancelled: false,
      deadline: setTimeout(() => this.cancelRun(schedule.id, false), RUN_DEADLINE_MS),
      approval: null,
      tabId: null,
      elementNames: new Map(),
    };
    this.active.set(schedule.id, run);
    store.setLastRun(schedule.id, record);
    this.ctx.agents.clientConnected(SCHED_CLIENT, true);

    try {
      run.tabId = win.createTab(NEW_TAB_URL, { activate: false, agent: true }).id;
      const settings = this.ctx.settings.get().scheduledAgents;
      const maxSteps = Math.min(clampMaxSteps(schedule.maxSteps), settings.maxSteps);
      const execute: ToolExecutor = (name, input, signal) => this.execute(run, name, input, signal);
      for await (const step of runAgent({
        provider,
        system: AGENT_SYSTEM,
        task: schedule.task,
        tools: TOOLS,
        execute,
        maxSteps,
        maxTokens: PER_TURN_TOKENS,
        tokenBudget: settings.maxTokens,
        signal: run.abort.signal,
      })) {
        this.onStep(run, step);
      }
    } catch (err) {
      record.status = "error";
      record.error = errorText(err);
    } finally {
      clearTimeout(run.deadline);
      if (record.status === "running" || record.status === "awaiting-approval") {
        record.status = run.abort.signal.aborted ? (run.cancelled ? "cancelled" : "stopped") : "done";
      }
      record.endedAt = Date.now();
      record.summary = (run.finalText.trim() || record.summary || this.fallbackSummary(record)).slice(0, SUMMARY_CHARS);
      if (run.tabId) this.closeTab(win, run.tabId);
      run.approval = null;
      this.active.delete(schedule.id);
      this.running.delete(schedule.id);
      store.finishRun(schedule.id, record);
      this.notifyResult(profileId, schedule, record);
    }
  }

  private fallbackSummary(record: ScheduleRunRecord): string {
    if (record.status === "error") return record.error ? `Failed: ${record.error}` : "The run failed.";
    if (record.status === "cancelled") return "The run was cancelled.";
    if (record.status === "stopped") return "The run was stopped.";
    return `Completed ${record.steps} step(s).`;
  }

  private onStep(run: ActiveRun, step: AgentStep): void {
    switch (step.type) {
      case "text":
        run.finalText += step.text;
        run.record.summary = run.finalText.trim().slice(0, SUMMARY_CHARS);
        break;
      case "tool_result":
        run.record.steps += 1;
        this.touch(run);
        break;
      case "usage":
        run.record.inputTokens = step.totalInputTokens;
        run.record.outputTokens = step.totalOutputTokens;
        break;
      case "stop":
        if (step.reason === "error") {
          run.record.status = "error";
          run.record.error = step.message ?? "The agent run failed.";
        } else if (step.reason === "aborted") {
          // User stop at an approval, a cancel, or the deadline: distinguish an explicit cancel.
          run.record.status = run.cancelled ? "cancelled" : "stopped";
        }
        break;
    }
  }

  // ------------------------------------------------------------------- scheduled gate

  private async execute(run: ActiveRun, name: string, input: unknown, signal: AbortSignal): Promise<AgentToolResult> {
    if (signal.aborted) throw new AgentStopError("aborted");
    const elementName = name === "click" || name === "type" ? run.elementNames.get(argStr(input, "ref")) ?? "" : "";
    const risk = classifyAction(name, input, elementName);

    if (name === "ask_user") {
      const reason = argStr(input, "message") || "The agent needs your help to continue.";
      const decision = await this.requestApproval(run, { tool: name, summary: summarizeArgs(name, input) || reason, reason, handoff: true }, signal);
      if (decision === "stop") throw new AgentStopError("stopped by user");
      return { content: decision === "approve" ? "The user handled it and asked you to continue." : "The user skipped this; continue without it." };
    }

    // A scheduled run always asks before a risky action — it is never auto-approved.
    if (risk.risky) {
      const decision = await this.requestApproval(run, { tool: name, summary: summarizeArgs(name, input), reason: risk.reason, handoff: risk.handoff }, signal);
      if (decision === "stop") throw new AgentStopError("stopped by user");
      if (decision === "skip") return { content: "The user skipped this action. Choose a different approach or finish." };
    }
    // Secrets/CAPTCHAs are never performed unattended, even if the risky gate was approved.
    if (risk.handoff) return { content: "This needs a secret or a human check. Call ask_user instead of doing it yourself." };

    if (signal.aborted) throw new AgentStopError("aborted");
    const at = Date.now();
    try {
      this.ctx.agents.toolCall({ client: SCHED_CLIENT, tool: name, args: input, at });
    } catch {
      // timeline may be mid-change; the result still reports
    }
    const started = Date.now();
    try {
      const result = await runAgentTool(this.ctx, run, name, input, signal);
      this.ctx.agents.toolResult({ client: SCHED_CLIENT, tool: name, at, durationMs: Date.now() - started, ok: !result.isError, resultChars: result.content.length });
      return result;
    } catch (err) {
      this.ctx.agents.toolResult({ client: SCHED_CLIENT, tool: name, at, durationMs: Date.now() - started, ok: false, resultChars: 0 });
      throw err;
    }
  }

  private requestApproval(run: ActiveRun, view: ScheduleApprovalView, signal: AbortSignal): Promise<AgentApprovalDecision> {
    return new Promise<AgentApprovalDecision>((resolve) => {
      let settled = false;
      const done = (d: AgentApprovalDecision): void => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        if (run.approval?.resolve === done) run.approval = null;
        if (run.record.status === "awaiting-approval") run.record.status = "running";
        this.touch(run);
        resolve(d);
      };
      const onAbort = (): void => done("stop");
      signal.addEventListener("abort", onAbort, { once: true });
      run.approval = { view, resolve: done };
      run.record.status = "awaiting-approval";
      this.surfaceForApproval(run, view);
      this.touch(run);
    });
  }

  /** Bring the agent tab to the front and notify, so the user can see what needs approval. */
  private surfaceForApproval(run: ActiveRun, view: ScheduleApprovalView): void {
    if (run.tabId && !run.win.isDisposed()) {
      run.win.activate(run.tabId);
      if (!run.win.win.isDestroyed()) run.win.win.focus();
    }
    if (Notification.isSupported()) {
      const notification = new Notification({
        title: `Approval needed: ${run.schedule.name}`.slice(0, 120),
        body: (view.reason || "A scheduled agent wants to take an action.").slice(0, 200),
      });
      notification.on("click", () => this.openManager(run.profileId));
      notification.show();
    }
  }

  private notifyResult(profileId: string, schedule: AgentSchedule, record: ScheduleRunRecord): void {
    if (Notification.isSupported()) {
      const failed = record.status === "error";
      const notification = new Notification({
        title: `${failed ? "Scheduled task failed" : "Scheduled task done"}: ${schedule.name}`.slice(0, 120),
        body: (record.summary || record.error || "").slice(0, 200),
      });
      notification.on("click", () => this.openManager(profileId));
      notification.show();
    }
    this.pushTo(profileId);
  }

  private openManager(profileId: string): void {
    const win = this.ctx.windows.forProfile(profileId)[0] ?? this.ctx.windows.focused();
    win?.openSingleton(SCHEDULES_URL);
  }

  private closeTab(win: BrowserWindowCtl, tabId: TabId): void {
    if (!win.isDisposed() && win.hasTab(tabId)) win.closeTab(tabId);
  }

  private touch(run: ActiveRun): void {
    this.stores.get(run.profileId)?.setLastRun(run.schedule.id, { ...run.record });
  }

  private pushTo(profileId: string): void {
    for (const win of this.ctx.windows.forProfile(profileId)) {
      win.notifyInternalPages({ type: "schedules-changed" }, ["schedules"]);
    }
  }

  // ------------------------------------------------------------------- lifecycle

  stop(): void {
    for (const run of this.active.values()) {
      run.cancelled = false;
      run.approval?.resolve("stop");
      run.abort.abort();
      clearTimeout(run.deadline);
    }
    this.flush();
  }

  flush(): void {
    for (const store of this.stores.values()) store.flush();
  }
}
