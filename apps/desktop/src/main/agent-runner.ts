import crypto from "node:crypto";
import { Notification } from "electron";
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
import { actionLabel, resultLabel } from "../shared/assist-agent";
import { isResumableStatus, recentRunMemoryNote, type AgentRunSource, type AgentRunStopReason, type StoredRunStatus } from "../shared/agent-run";
import { CREDENTIAL_TOOLS } from "../shared/agent-safety";
import { NEW_TAB_URL } from "../shared/internal-urls";
import { RunTabs } from "./agent-tabs";
import type {
  AgentApprovalDecision,
  AgentApprovalRequest,
  AgentLeftTab,
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
import { tr } from "./menu-i18n";

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
  /** Where the run lives: the Command Bar (one per window) or an Assist conversation. */
  source: AgentRunSource;
  /** Embedded (Assist) runs: called on every change instead of pushing the window state. */
  onUpdate: ((view: AgentRunView) => void) | null;
  /** Embedded runs: a screenshot was handed to the model (for a thumbnail in the conversation). */
  onScreenshot: ((stepId: string, image: { base64: string; mediaType: string }) => void) | null;
  /** Total token budget for the run (runAgent's default when undefined). */
  tokenBudget: number | undefined;
  /** The tab an embedded run started in (the person's tab). */
  startTab: TabId | null;
  /** That tab was not agent-driven before the run: drop the AI badge after it. */
  clearAgentMark: boolean;
  /** The tabs the run opens, grouped under its task (set when the run starts driving). */
  tabs?: RunTabs;
  /** Its tabs still open when it ended, offered to the person in the panel. */
  leftTabs: AgentLeftTab[];
  /** The window the run works in, while it drives. */
  win: BrowserWindowCtl | null;
  /** A tool call is under way (its own input events are not the person's)... */
  acting: boolean;
  /** ...or ended just now. */
  quietUntil: number;
  /** The person took over the page: the next action waits for handBack. */
  takenOver: boolean;
  handBack: (() => void) | null;
  /** They handed it back before the next action: that action is dropped so the agent re-reads. */
  handedBack: boolean;
}

/** Input that means the person is using the page (pointer moves and wheel scrolls do not). */
const TAKE_OVER_INPUT = new Set(["mouseDown", "rawKeyDown", "keyDown", "touchStart", "gestureTap"]);
/** The agent's own synthetic input can land a moment after its tool call returns. */
const QUIET_AFTER_ACTION_MS = 300;
/** What the agent hears when the person hands the page back. */
export const HANDED_BACK =
  "The person used the page while you waited and handed it back; this action was not carried out. The page may have changed: take a new page_snapshot (or a screenshot) before you act.";

/** An Assist conversation turn run as a browser agent in the user's current tab. */
export interface EmbeddedRunOptions {
  /** The tab the agent works in (the user's current tab). */
  tabId: TabId;
  /** The URL of that tab, for site profiles and saved workflows. */
  url: string | null;
  /** The user's request as typed (run history). */
  task: string;
  /** The first user message handed to the model (request + page context + conversation). */
  seed: string;
  /** Base system prompt; the visual, credential, site-profile and workflow blocks are added to it. */
  system: string;
  maxSteps: number;
  tokenBudget: number;
  onUpdate(view: AgentRunView): void;
  onScreenshot?(stepId: string, image: { base64: string; mediaType: string }): void;
}

/**
 * Runs a Command Bar agent in a window: builds the tool set over the BrowserController, drives the
 * provider-agnostic loop, and gates every action with the pause switch and risky-action approval.
 * One run per window. Steps feed both the Command Bar's Do panel and the shared agent timeline, so
 * the agent-cursor overlay and the pause kill switch work exactly as for an external MCP client.
 */
export class AgentRunner {
  private readonly runs = new WeakMap<BrowserWindowCtl, Run>();
  /** Embedded (Assist) runs by id, while they are live. */
  private readonly embedded = new Map<string, Run>();
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
  private siteContext(
    win: BrowserWindowCtl,
    url: string | null = this.activeUrl(win),
    baseSystem?: string,
  ): { system: string; tools: AgentTool[]; override: ProviderOverride | undefined } {
    const profile = url ? matchSiteProfile(win.profile.siteProfiles.list(), url) : null;
    // Credential tools only when Settings, Passwords allows agents to use opted-in logins.
    const base = agentToolset(this.ctx.agentCredentials.enabled, baseSystem);
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
    return run ? viewOf(run) : null;
  }

  /** Whether agent mode is set up, so an Assist chat turn can run as an agent. Cheap: builds nothing. */
  ready(): boolean {
    return this.setupReason() === null;
  }

  // ----------------------------------------------------------------- embedded (Assist) runs

  /**
   * Starts an Assist conversation turn as a browser agent in the user's current tab: the same loop,
   * tools, approval gate, spend gate, pause switch and run history as a Command Bar run, reported
   * through `onUpdate` to the Assist panel instead of the Command Bar.
   */
  startEmbedded(win: BrowserWindowCtl, opts: EmbeddedRunOptions): { id: string } | { error: string } {
    const site = this.siteContext(win, opts.url, opts.system);
    const provider = this.provider(site.override);
    if (!provider) return { error: this.setupReason() ?? "Agent mode is not available." };
    const wf = workflowRunContext(this.ctx, win.profile, opts.url, site, opts.task);
    const working = this.ctx.windows.findTab(opts.tabId)?.tab;
    const run: Run = {
      ...this.blankRun(opts.task, opts.seed),
      maxSteps: opts.maxSteps,
      provider: provider.kind,
      model: provider.model,
      system: wf.system,
      tools: wf.tools,
      wf: wf.state,
      tabId: opts.tabId,
      startTab: opts.tabId,
      source: "assist",
      onUpdate: opts.onUpdate,
      onScreenshot: opts.onScreenshot ?? null,
      tokenBudget: opts.tokenBudget,
      clearAgentMark: working ? !working.agentControlled : false,
    };
    this.embedded.set(run.id, run);
    void this.drive(win, run, provider);
    return { id: run.id };
  }

  embeddedView(id: string): AgentRunView | null {
    const run = this.embedded.get(id);
    return run ? viewOf(run) : null;
  }

  stopEmbedded(id: string): void {
    const run = this.embedded.get(id);
    if (!run) return;
    run.approval?.resolve("stop");
    run.abort.abort();
    if (!isFinished(run.status)) {
      run.status = "stopped";
      run.onUpdate?.(viewOf(run));
    }
  }

  approveEmbedded(id: string, decision: AgentApprovalDecision): void {
    this.embedded.get(id)?.approval?.resolve(decision);
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

  /** Why an agent run cannot start (no model set up), or null when it can. */
  unavailableReason(): string | null {
    return this.provider() ? null : (this.setupReason() ?? "Agent mode is not available.");
  }

  /** A run Corvus starts for the person (such as "Download with AI"), shown in the window's Command Bar. */
  startVisible(win: BrowserWindowCtl, task: string): void {
    win.sendCommand({ type: "open-command-palette" });
    this.start(win, task);
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
      source: "command-bar",
      onUpdate: null,
      onScreenshot: null,
      tokenBudget: undefined,
      startTab: null,
      clearAgentMark: false,
      leftTabs: [],
      win: null,
      acting: false,
      quietUntil: 0,
      takenOver: false,
      handBack: null,
      handedBack: false,
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
    if (run.onUpdate) run.onUpdate(viewOf(run));
    else if (this.runs.get(win) === run) win.pushState();
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
    if (run.source === "command-bar") this.ctx.assist.open(win, "agents");
    run.win = win;
    this.ctx.agents.clientConnected(AGENT_CLIENT, true);
    this.persist(win, run, true);
    try {
      // Command Bar runs work in a fresh agent tab; Assist runs in the user's current tab. Tabs the
      // agent opens join one group named after the task and stay open for the person afterwards.
      run.tabs = new RunTabs(this.ctx, win, run.task, run.source === "assist" ? run.tabId : null);
      if (run.source === "command-bar") {
        run.tabId = win.createTab(NEW_TAB_URL, { activate: true, agent: true }).id;
        run.tabs.adopt(run.tabId);
      }
      const execute: ToolExecutor = (name, input, signal) => this.execute(win, run, name, input, signal);
      for await (const step of runAgent({
        provider,
        system: run.system,
        task: run.seededTask,
        tools: run.tools,
        execute,
        maxSteps: run.maxSteps,
        maxTokens: PER_TURN_TOKENS,
        ...(run.tokenBudget ? { tokenBudget: run.tokenBudget } : {}),
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
      run.takenOver = false;
      run.handBack = null;
      run.handedBack = false;
      run.win = null;
      run.leftTabs = run.tabs?.release() ?? [];
      this.push(win, run);
      this.persist(win, run, true);
      learnFromRun(this.ctx, win.profile, run.wf, run.status === "done" && run.stopReason === "done");
      if (run.source === "assist") {
        this.embedded.delete(run.id);
        const start = run.clearAgentMark && run.startTab ? this.ctx.windows.findTab(run.startTab) : undefined;
        start?.window.clearAgentMark(start.tab.id);
      }
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
        const label = actionLabel(step.name, step.input, run.elementNames.get(argStr(step.input, "ref")) ?? "", tr);
        run.steps = [...run.steps, { id: step.id, kind: step.name, summary: summarizeArgs(step.name, step.input), label, status: "running", at: Date.now() }];
        break;
      }
      case "tool_result": {
        run.stepCount += 1;
        if (step.result.image && run.onScreenshot) run.onScreenshot(step.id, step.result.image);
        const action = noteToolResult(run.wf, run, step.name, step.result.isError === true);
        run.steps = run.steps.map((s) =>
          s.id === step.id
            ? {
                ...s,
                status: step.result.isError ? "error" : s.status === "skipped" ? "skipped" : "ok",
                detail: stepPreview(step.name, step.result.content),
                label: s.status === "skipped" ? (s.label ?? s.summary) : resultLabel(step.name, s.label ?? s.summary, step.result.content, step.result.isError === true, tr),
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
    if (run.takenOver) {
      await this.waitForHandBack(win, run, signal);
      if (signal.aborted) throw new AgentStopError("aborted");
      run.handedBack = true;
    }
    if (run.handedBack) {
      run.handedBack = false;
      run.steps = run.steps.map((s) => (s.id === findRunningId(run, name) ? { ...s, status: "skipped" } : s));
      return { content: HANDED_BACK };
    }
    run.acting = true;
    try {
      return await this.executeStep(win, run, name, input, signal);
    } finally {
      run.acting = false;
      run.quietUntil = Date.now() + QUIET_AFTER_ACTION_MS;
    }
  }

  /**
   * The person clicked or typed in a tab of this window. A run working in that tab (its working tab
   * or one it opened) between two actions stops there: the person has taken over, and the run's
   * next action waits until they hand the page back.
   */
  personInput(win: BrowserWindowCtl, tabId: TabId, type: string): void {
    if (!TAKE_OVER_INPUT.has(type)) return;
    const runs = [this.runs.get(win), ...this.embedded.values()];
    for (const run of runs) {
      if (!run || run.win !== win || run.status !== "running" || run.takenOver || run.acting || Date.now() < run.quietUntil) continue;
      if (run.tabId !== tabId && !run.tabs?.owns(tabId)) continue;
      run.takenOver = true;
      this.push(win, run);
    }
  }

  /** This window's runs still going: where each works and its latest step, for the live view. */
  liveRuns(win: BrowserWindowCtl): Array<{ id: string; tabId: TabId | null; step: string }> {
    return [this.runs.get(win), ...this.embedded.values()]
      .filter((r): r is Run => Boolean(r) && r!.win === win && !isFinished(r!.status))
      .map((r) => ({ id: r.id, tabId: r.tabId, step: [...r.steps].reverse().find((s) => s.kind !== "message")?.label ?? "" }));
  }

  /** Stops a run of this window by id (the live view's Stop). */
  stopRun(win: BrowserWindowCtl, id: string): void {
    if (this.runs.get(win)?.id === id) this.stop(win);
    else this.stopEmbedded(id);
  }

  handBack(win: BrowserWindowCtl): void {
    const run = this.runs.get(win);
    if (run) this.handBackRun(win, run);
  }

  handBackEmbedded(id: string): void {
    const run = this.embedded.get(id);
    if (run?.win) this.handBackRun(run.win, run);
  }

  /** The person is done: a waiting action is released, or the next one learns the page changed. */
  private handBackRun(win: BrowserWindowCtl, run: Run): void {
    if (run.handBack) return run.handBack();
    if (!run.takenOver) return;
    run.takenOver = false;
    run.handedBack = true;
    this.push(win, run);
  }

  private waitForHandBack(win: BrowserWindowCtl, run: Run, signal: AbortSignal): Promise<void> {
    return new Promise<void>((resolve) => {
      const done = (): void => {
        signal.removeEventListener("abort", done);
        run.handBack = null;
        run.takenOver = false;
        this.push(win, run);
        resolve();
      };
      if (signal.aborted) return done();
      signal.addEventListener("abort", done, { once: true });
      run.handBack = done;
      this.push(win, run);
    });
  }

  private async executeStep(win: BrowserWindowCtl, run: Run, name: string, input: unknown, signal: AbortSignal): Promise<AgentToolResult> {
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
      const reason = argStr(input, "message") || "The agent needs your help to continue.";
      this.notifyHandoff(win, reason);
      const decision = await this.requestApproval(win, run, name, input, { handoff: true, reason }, signal);
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
      return { content: "This needs a secret. Call ask_user instead of doing it yourself." };
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

  /** A handoff while Corvus is in the background: a notification that brings the window back. */
  private notifyHandoff(win: BrowserWindowCtl, reason: string): void {
    if (win.win.isDestroyed() || win.win.isFocused() || !Notification.isSupported()) return;
    const n = new Notification({ title: tr("Corvus needs you to continue"), body: reason.slice(0, 200) });
    n.on("click", () => {
      if (win.win.isDestroyed()) return;
      win.win.show();
      win.win.focus();
    });
    n.show();
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

function viewOf(run: Run): AgentRunView {
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
    ...(run.stopReason ? { stopReason: run.stopReason } : {}),
    ...(run.leftTabs.length > 0 ? { leftTabs: run.leftTabs } : {}),
    ...(run.takenOver ? { takenOver: true } : {}),
  };
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
    source: run.source,
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
