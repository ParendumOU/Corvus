import crypto from "node:crypto";
import {
  AgentStopError,
  runAgent,
  type AgentMessage,
  type AgentModelProvider,
  type AgentStep,
  type AgentStopReason,
  type AgentTool,
  type AgentToolResult,
  type ToolExecutor,
} from "@corvus/ai-engine";
import type { TabId } from "@corvus/shared";
import { summarizeArgs } from "../shared/agent-activity";
import { isResumableStatus, recentRunMemoryNote, type AgentRunStopReason, type StoredRunStatus } from "../shared/agent-run";
import { CREDENTIAL_TOOLS } from "../shared/agent-safety";
import { NEW_TAB_URL } from "../shared/internal-urls";
import type {
  AgentApprovalDecision,
  AgentApprovalRequest,
  AgentRunStep,
  AgentRunView,
  CommandBarWindowExtras,
} from "../shared/command-bar-ipc";
import type { AgentResumeResult } from "../shared/agent-run-ipc";
import type { StoredAgentRun } from "./agent-run-store";
import { TranscriptBuilder, normalizeResumeTranscript } from "./agent-transcript";
import type { CredentialApprover } from "./agent-credentials";
import { AGENT_SYSTEM, PER_TURN_TOKENS, TOOLS, agentSetupReason, agentToolset, argStr, capAgentTools, classifyToolCall, providerFromSettings, runAgentTool, stepPreview, type ProviderOverride } from "./agent-tools";
import { applyPromptAddendum, capAccessLevel, matchSiteProfile } from "../shared/site-profiles";
import type { AppContext } from "./context";
import type { BrowserWindowCtl } from "./window";
import { stepToToolCall } from "../shared/flow";
import { captureAction, isWorkflowTool, learnFromRun, noteToolResult, runWorkflowAgentTool, workflowRunContext, type WorkflowRunState } from "./workflow-agent";

/** Name shown in the shared agent-activity timeline and in each page overlay caption. */
const AGENT_CLIENT = "Corvus";

interface Run {
  id: string;
  task: string;
  status: AgentRunView["status"];
  steps: AgentRunStep[];
  finalText: string;
  error: string | null;
  stepCount: number;
  maxSteps: number;
  inputTokens: number;
  outputTokens: number;
  provider: string;
  model: string;
  tabId: TabId | null;
  startedAt: number;
  abort: AbortController;
  elementNames: Map<string, string>;
  approval: { request: AgentApprovalRequest; resolve: (d: AgentApprovalDecision) => void } | null;
  messageStepId: string | null;
  /** The task text handed to the model (may carry a recent-run memory note); run.task stays clean. */
  seededTask: string;
  /** System prompt for this run (base + any matched site-profile addendum). */
  system: string;
  /** Tool set for this run (narrowed by a matched site profile's access cap). */
  tools: AgentTool[];
  /** Running transcript, persisted so an interrupted run can be resumed. */
  transcript: TranscriptBuilder;
  stopReason: AgentRunStopReason;
  /** Saved workflows: start site, the "save as workflow" offer, the action being captured. */
  wf: WorkflowRunState;
}

/**
 * Runs a Command Bar agent in a window: builds the tool set over the BrowserController, drives the
 * provider-agnostic loop, and gates every action with the pause switch and risky-action approval.
 * One run per window. Steps feed both the Command Bar's Do panel and the shared agent timeline, so
 * the agent-cursor overlay and the pause kill switch work exactly as for an external MCP client.
 */
export class AgentRunner {
  private readonly runs = new WeakMap<BrowserWindowCtl, Run>();
  private testProvider: AgentModelProvider | null | undefined;

  constructor(private readonly ctx: AppContext) {}

  /** Smoke tests inject a fake provider; `undefined` restores the configured one. */
  setTestProvider(provider: AgentModelProvider | null | undefined): void {
    this.testProvider = provider;
  }

  private provider(override?: ProviderOverride): AgentModelProvider | null {
    if (this.testProvider !== undefined) return this.testProvider;
    const withOverride = providerFromSettings(this.ctx, override);
    if (withOverride || !override) return withOverride;
    // A site-profile provider override that can't be built (e.g. no key) falls back to the global one.
    return providerFromSettings(this.ctx);
  }

  /** URL of the window's active tab, used to match a site profile at run start. */
  private activeUrl(win: BrowserWindowCtl): string | null {
    try {
      const tab = win.activeTab();
      if (!tab) return null;
      const wc = tab.view.webContents;
      return !wc.isDestroyed() ? wc.getURL() || tab.url : tab.url;
    } catch {
      return null;
    }
  }

  /** The system prompt, tool set and provider override to use, given any matching site profile. */
  private siteContext(win: BrowserWindowCtl): { system: string; tools: AgentTool[]; override: ProviderOverride | undefined } {
    const url = this.activeUrl(win);
    const profile = url ? matchSiteProfile(win.profile.siteProfiles.list(), url) : null;
    // Credential tools only when Settings, Passwords allows agents to use opted-in logins.
    const base = agentToolset(this.ctx.agentCredentials.enabled);
    if (!profile) return { system: base.system, tools: base.tools, override: undefined };
    const level = capAccessLevel("full", profile.accessCap);
    const override = profile.provider || profile.model ? { provider: profile.provider, model: profile.model } : undefined;
    return { system: applyPromptAddendum(base.system, profile), tools: capAgentTools(base.tools, level), override };
  }

  private setupReason(): string | null {
    if (this.testProvider !== undefined) return this.testProvider ? null : "Agent mode is not configured.";
    return agentSetupReason(this.ctx);
  }

  windowExtras(win: BrowserWindowCtl): CommandBarWindowExtras {
    return { agentRun: this.view(win), agentReady: this.setupReason() === null, agentSetupReason: this.setupReason() };
  }

  private view(win: BrowserWindowCtl): AgentRunView | null {
    const run = this.runs.get(win);
    if (!run) return null;
    return {
      id: run.id,
      task: run.task,
      status: run.status,
      steps: run.steps,
      finalText: run.finalText,
      error: run.error,
      stepCount: run.stepCount,
      maxSteps: run.maxSteps,
      inputTokens: run.inputTokens,
      outputTokens: run.outputTokens,
      provider: run.provider,
      model: run.model,
      tabId: run.tabId,
      approval: run.approval?.request ?? null,
      startedAt: run.startedAt,
      ...(run.wf.offer ? { offerWorkflow: true } : {}),
      ...(run.wf.hints ? { siteHints: run.wf.hints } : {}),
    };
  }

  // ----------------------------------------------------------------- controls

  start(win: BrowserWindowCtl, task: string): void {
    const trimmed = task.trim().slice(0, 2000);
    if (!trimmed) return;
    const existing = this.runs.get(win);
    if (existing && !isFinished(existing.status)) existing.abort.abort();

    const site = this.siteContext(win);
    const provider = this.provider(site.override);
    if (!provider) {
      this.runs.set(win, { ...this.blankRun(trimmed, trimmed), provider: this.ctx.settings.get().ai.provider, model: this.ctx.settings.get().ai.model, status: "error", error: this.setupReason() ?? "Agent mode is not available." });
      win.pushState();
      return;
    }

    const note = recentRunMemoryNote(win.profile.agentRuns.views());
    const seededTask = note ? `${note}\n\nTask: ${trimmed}` : trimmed;
    const wf = workflowRunContext(this.ctx, win.profile, this.activeUrl(win), site, trimmed);
    const run: Run = {
      ...this.blankRun(trimmed, seededTask),
      maxSteps: this.ctx.settings.get().agent.maxSteps,
      provider: provider.kind,
      model: provider.model,
      system: wf.system,
      tools: wf.tools,
      wf: wf.state,
    };
    this.runs.set(win, run);
    win.pushState();
    void this.drive(win, run, provider);
  }

  private blankRun(task: string, seededTask: string): Run {
    return {
      id: crypto.randomUUID(),
      task,
      status: "running",
      steps: [],
      finalText: "",
      error: null,
      stepCount: 0,
      maxSteps: this.ctx.settings.get().agent.maxSteps,
      inputTokens: 0,
      outputTokens: 0,
      provider: "",
      model: "",
      tabId: null,
      startedAt: Date.now(),
      abort: new AbortController(),
      elementNames: new Map(),
      approval: null,
      messageStepId: null,
      seededTask,
      system: AGENT_SYSTEM,
      tools: TOOLS,
      transcript: new TranscriptBuilder(seededTask),
      stopReason: null,
      wf: { siteUrl: null, offer: false, captured: null, trail: [], hints: null },
    };
  }

  stop(win: BrowserWindowCtl): void {
    const run = this.runs.get(win);
    if (!run) return;
    run.approval?.resolve("stop");
    run.abort.abort();
    if (!isFinished(run.status)) {
      run.status = "stopped";
      this.push(win, run);
    }
  }

  pause(win: BrowserWindowCtl, paused: boolean): void {
    this.ctx.agents.setPaused(paused);
    const run = this.runs.get(win);
    if (run && !isFinished(run.status)) {
      run.status = paused ? "paused" : run.approval ? "awaiting-approval" : "running";
      this.push(win, run);
    }
  }

  approve(win: BrowserWindowCtl, decision: AgentApprovalDecision): void {
    this.runs.get(win)?.approval?.resolve(decision);
  }

  clear(win: BrowserWindowCtl): void {
    const run = this.runs.get(win);
    if (!run) return;
    if (!isFinished(run.status)) {
      run.abort.abort();
      run.approval?.resolve("stop");
    }
    this.runs.delete(win);
    win.pushState();
  }

  private push(win: BrowserWindowCtl, run: Run): void {
    if (this.runs.get(win) === run) win.pushState();
  }

  // ----------------------------------------------------------------- the loop

  /** Continue an interrupted/incomplete run from its saved step state, within the approval gate + caps. */
  resume(win: BrowserWindowCtl | undefined, id: string): AgentResumeResult {
    if (!win) return { ok: false, reason: "Open the run from a browser window to resume it." };
    const stored = win.profile.agentRuns.get(id);
    if (!stored) return { ok: false, reason: "That run is no longer in the history." };
    if (!isResumableStatus(stored.status, stored.stopReason)) return { ok: false, reason: "This run finished and cannot be resumed." };
    const messages = normalizeResumeTranscript(stored.transcript);
    if (!messages) return { ok: false, reason: "This run has no saved step state to continue from." };
    const site = this.siteContext(win);
    const provider = this.provider(site.override);
    if (!provider) return { ok: false, reason: this.setupReason() ?? "Agent mode is not configured." };

    const existing = this.runs.get(win);
    if (existing && !isFinished(existing.status)) existing.abort.abort();

    const wf = workflowRunContext(this.ctx, win.profile, this.activeUrl(win), site, stored.task);
    const run: Run = {
      ...this.blankRun(stored.task, stored.task),
      id: stored.id,
      steps: stored.steps,
      stepCount: stored.stepCount,
      inputTokens: stored.inputTokens,
      outputTokens: stored.outputTokens,
      maxSteps: Math.max(stored.stepCount + 1, this.ctx.settings.get().agent.maxSteps),
      provider: provider.kind,
      model: provider.model,
      system: wf.system,
      tools: wf.tools,
      wf: wf.state,
      transcript: new TranscriptBuilder(messages),
    };
    this.runs.set(win, run);
    win.sendCommand({ type: "open-command-palette" });
    win.pushState();
    void this.drive(win, run, provider, { messages, steps: stored.stepCount, tokens: { input: stored.inputTokens, output: stored.outputTokens } });
    return { ok: true };
  }

  private async drive(
    win: BrowserWindowCtl,
    run: Run,
    provider: AgentModelProvider,
    seed?: { messages: AgentMessage[]; steps: number; tokens: { input: number; output: number } },
  ): Promise<void> {
    this.ctx.assist.open(win, "agents");
    this.ctx.agents.clientConnected(AGENT_CLIENT, true);
    this.persist(win, run, true);
    try {
      run.tabId = win.createTab(NEW_TAB_URL, { activate: true, agent: true }).id;
      const execute: ToolExecutor = (name, input, signal) => this.execute(win, run, name, input, signal);
      for await (const step of runAgent({
        provider,
        system: run.system,
        task: run.seededTask,
        tools: run.tools,
        execute,
        maxSteps: run.maxSteps,
        maxTokens: PER_TURN_TOKENS,
        signal: run.abort.signal,
        ...(seed ? { seedMessages: seed.messages, startSteps: seed.steps, startTokens: seed.tokens } : {}),
      })) {
        this.onStep(win, run, step);
      }
    } catch (err) {
      run.status = "error";
      run.error = err instanceof Error ? err.message : String(err);
      run.stopReason = "error";
    } finally {
      if (!isFinished(run.status)) run.status = run.abort.signal.aborted ? "stopped" : "done";
      run.approval = null;
      this.push(win, run);
      this.persist(win, run, true);
      learnFromRun(this.ctx, win.profile, run.wf, run.status === "done" && run.stopReason === "done");
    }
  }

  private onStep(win: BrowserWindowCtl, run: Run, step: AgentStep): void {
    run.transcript.push(step);
    switch (step.type) {
      case "text": {
        if (!run.messageStepId) {
          const s: AgentRunStep = { id: crypto.randomUUID(), kind: "message", summary: "", detail: step.text, status: "ok", at: Date.now() };
          run.messageStepId = s.id;
          run.steps = [...run.steps, s];
        } else {
          run.steps = run.steps.map((s) => (s.id === run.messageStepId ? { ...s, detail: (s.detail ?? "") + step.text } : s));
        }
        run.finalText += step.text;
        break;
      }
      case "tool_use": {
        run.messageStepId = null;
        run.steps = [...run.steps, { id: step.id, kind: step.name, summary: summarizeArgs(step.name, step.input), status: "running", at: Date.now() }];
        break;
      }
      case "tool_result": {
        run.stepCount += 1;
        const action = noteToolResult(run.wf, run, step.name, step.result.isError === true);
        run.steps = run.steps.map((s) =>
          s.id === step.id
            ? {
                ...s,
                status: step.result.isError ? "error" : s.status === "skipped" ? "skipped" : "ok",
                detail: stepPreview(step.name, step.result.content),
                resultChars: step.result.content.length,
                ...(action && s.status !== "skipped" ? { action } : {}),
              }
            : s,
        );
        break;
      }
      case "usage":
        run.inputTokens = step.totalInputTokens;
        run.outputTokens = step.totalOutputTokens;
        break;
      case "stop":
        run.status = step.reason === "error" ? "error" : step.reason === "aborted" ? "stopped" : "done";
        run.stopReason = stopReasonOf(step.reason);
        if (step.reason === "error") run.error = step.message ?? "The agent run failed.";
        break;
    }
    this.push(win, run);
    this.persist(win, run, step.type !== "text" && step.type !== "usage");
  }

  private persist(win: BrowserWindowCtl, run: Run, notify: boolean): void {
    const store = win.profile.agentRuns;
    const stored = toStored(run);
    if (notify) store.commit(stored);
    else store.save(stored);
  }

  // ----------------------------------------------------------------- execution

  private async execute(win: BrowserWindowCtl, run: Run, name: string, input: unknown, signal: AbortSignal): Promise<AgentToolResult> {
    await this.waitWhilePaused(run, signal);
    if (signal.aborted) throw new AgentStopError("aborted");
    run.wf.captured = null;
    // A saved secret was filled into the agent tab: no workflow replay there until it navigates.
    const locked = name === "run_workflow" && run.tabId ? this.ctx.secretFills?.check(run.tabId) : null;
    if (locked) return { content: locked, isError: true };
    if (isWorkflowTool(name)) return this.runWorkflowTool(win, run, name, input, signal);

    if (CREDENTIAL_TOOLS.has(name)) return this.executeCredential(win, run, name, input, signal);

    const risk = await classifyToolCall(this.ctx, run, name, input);
    if (name === "ask_user") {
      const decision = await this.requestApproval(win, run, name, input, { handoff: true, reason: argStr(input, "message") || "The agent needs your help to continue." }, signal);
      run.steps = run.steps.map((s) => (s.id === findRunningId(run, name) ? { ...s, status: decision === "approve" ? "ok" : "skipped" } : s));
      if (decision === "stop") throw new AgentStopError("stopped by user");
      return { content: decision === "approve" ? "The user handled it and asked you to continue." : "The user skipped this; continue without it." };
    }
    // "Ask before risky actions" off (auto mode) skips this prompt, except for spending money and
    // saved secrets (alwaysAsk): those ask every time.
    if (risk.risky && (risk.alwaysAsk === true || this.ctx.settings.get().agent.askBeforeRisky)) {
      const decision = await this.requestApproval(win, run, name, input, risk, signal);
      if (decision === "stop") throw new AgentStopError("stopped by user");
      if (decision === "skip") {
        run.steps = run.steps.map((s) => (s.id === findRunningId(run, name) ? { ...s, status: "skipped" } : s));
        return { content: "The user skipped this action. Choose a different approach or finish." };
      }
    }
    if (risk.handoff) {
      return { content: "This needs a secret or a human check. Call ask_user instead of doing it yourself." };
    }

    await this.waitWhilePaused(run, signal);
    if (signal.aborted) throw new AgentStopError("aborted");

    const at = Date.now();
    this.recordCall(name, input, at);
    const started = Date.now();
    try {
      run.wf.captured = captureAction(run, name, input);
      const result = await runAgentTool(this.ctx, run, name, input, signal);
      this.ctx.agents.toolResult({ client: AGENT_CLIENT, tool: name, at, durationMs: Date.now() - started, ok: !result.isError, resultChars: result.content.length });
      return result;
    } catch (err) {
      this.ctx.agents.toolResult({ client: AGENT_CLIENT, tool: name, at, durationMs: Date.now() - started, ok: false, resultChars: 0 });
      throw err;
    }
  }

  /**
   * fill_login / fill_totp: Corvus fills an opted-in saved login or 2FA code by reference after the
   * person approves this one use in the run panel, whatever "ask before risky actions" says. The
   * result only says what was filled; the secret never reaches the model, the transcript or history.
   */
  private async executeCredential(win: BrowserWindowCtl, run: Run, name: string, input: unknown, signal: AbortSignal): Promise<AgentToolResult> {
    const at = Date.now();
    this.recordCall(name, input, at);
    const approve: CredentialApprover = async (req) => {
      const decision = await this.requestApproval(win, run, name, input, { handoff: false, reason: req.reason }, signal);
      if (decision === "stop") throw new AgentStopError("stopped by user");
      return decision === "approve";
    };
    const username = argStr(input, "username");
    const opts = { approve, client: AGENT_CLIENT, handoffHint: "Call ask_user so the person can do this step.", ...(username ? { username } : {}) };
    try {
      if (!run.tabId) throw new Error("No agent tab is open yet.");
      const ref = argStr(input, "ref");
      const outcome =
        name === "fill_totp"
          ? await this.ctx.agentCredentials.fillTotp(run.tabId, ref, opts)
          : await this.ctx.agentCredentials.fillLogin(run.tabId, ref || null, opts);
      if (outcome.status === "declined") run.steps = run.steps.map((s) => (s.id === findRunningId(run, name) ? { ...s, status: "skipped" } : s));
      this.ctx.agents.toolResult({ client: AGENT_CLIENT, tool: name, at, durationMs: Date.now() - at, ok: outcome.status === "filled", resultChars: outcome.message.length });
      return { content: outcome.message, ...(outcome.status === "error" ? { isError: true } : {}) };
    } catch (err) {
      this.ctx.agents.toolResult({ client: AGENT_CLIENT, tool: name, at, durationMs: Date.now() - at, ok: false, resultChars: 0 });
      throw err;
    }
  }

  /** list_workflows / read_workflow / run_workflow, with this run's approval gate and step log. */
  private runWorkflowTool(win: BrowserWindowCtl, run: Run, name: string, input: unknown, signal: AbortSignal): Promise<AgentToolResult> {
    const changed = (): void => {
      this.push(win, run);
      this.persist(win, run, true);
    };
    return runWorkflowAgentTool(
      {
        ctx: this.ctx,
        runtime: win.profile,
        tabId: () => run.tabId,
        siteUrl: run.wf.siteUrl,
        parentStepId: findRunningId(run, name) ?? null,
        gate: (step, risk) => {
          // Auto mode runs risky steps on its own, but a spend (alwaysAsk) or a handoff always asks.
          if (!risk.handoff && risk.alwaysAsk !== true && !this.ctx.settings.get().agent.askBeforeRisky) return Promise.resolve("approve");
          const call = stepToToolCall(step);
          return this.requestApproval(win, run, call.tool, call.input, risk, signal);
        },
        waitWhilePaused: () => this.waitWhilePaused(run, signal),
        trail: run.wf.trail,
        addStep: (step) => {
          run.steps = [...run.steps, step];
          changed();
        },
        updateStep: (id, patch) => {
          run.steps = run.steps.map((s) => (s.id === id ? { ...s, ...patch } : s));
          changed();
        },
      },
      name,
      input,
      signal,
    );
  }

  private recordCall(name: string, input: unknown, at: number): void {
    try {
      this.ctx.agents.toolCall({ client: AGENT_CLIENT, tool: name, args: input, at });
    } catch {
      // Paused between the gate and here; the result will still report and the loop reconciles.
    }
  }

  private requestApproval(
    win: BrowserWindowCtl,
    run: Run,
    tool: string,
    input: unknown,
    risk: { reason: string; handoff: boolean },
    signal: AbortSignal,
  ): Promise<AgentApprovalDecision> {
    return new Promise<AgentApprovalDecision>((resolve) => {
      let settled = false;
      const done = (d: AgentApprovalDecision): void => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        if (run.approval?.resolve === done) run.approval = null;
        if (!isFinished(run.status)) run.status = "running";
        this.push(win, run);
        resolve(d);
      };
      const onAbort = (): void => done("stop");
      signal.addEventListener("abort", onAbort, { once: true });
      run.approval = {
        request: { id: crypto.randomUUID(), tool, summary: summarizeArgs(tool, input) || argStr(input, "message"), reason: risk.reason, handoff: risk.handoff },
        resolve: done,
      };
      run.status = "awaiting-approval";
      this.push(win, run);
    });
  }

  private async waitWhilePaused(run: Run, signal: AbortSignal): Promise<void> {
    if (!this.ctx.agents.paused || signal.aborted) return;
    run.status = "paused";
    await new Promise<void>((resolve) => {
      const off = this.ctx.agents.onChange(() => {
        if (!this.ctx.agents.paused || signal.aborted) {
          off();
          resolve();
        }
      });
      signal.addEventListener("abort", () => { off(); resolve(); }, { once: true });
    });
    if (!isFinished(run.status) && !signal.aborted) run.status = run.approval ? "awaiting-approval" : "running";
  }

}

function isFinished(status: AgentRunView["status"]): boolean {
  return status === "done" || status === "error" || status === "stopped";
}

function stopReasonOf(reason: AgentStopReason): AgentRunStopReason {
  return reason === "done" || reason === "max_steps" || reason === "aborted" || reason === "error" || reason === "budget" ? reason : null;
}

function toStored(run: Run): StoredAgentRun {
  const status: StoredRunStatus = run.status;
  return {
    id: run.id,
    task: run.task,
    source: "command-bar",
    status,
    stopReason: run.stopReason,
    steps: run.steps,
    finalText: run.finalText,
    error: run.error,
    stepCount: run.stepCount,
    maxSteps: run.maxSteps,
    inputTokens: run.inputTokens,
    outputTokens: run.outputTokens,
    provider: run.provider,
    model: run.model,
    startedAt: run.startedAt,
    endedAt: isFinished(status) ? Date.now() : null,
    transcript: run.transcript.snapshot(),
    ...(run.wf.hints ? { siteHints: run.wf.hints } : {}),
  };
}

function findRunningId(run: Run, _tool: string): string | undefined {
  return [...run.steps].reverse().find((s) => s.status === "running")?.id;
}
