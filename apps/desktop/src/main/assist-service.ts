import crypto from "node:crypto";
import { app, clipboard, nativeImage, nativeTheme, type Rectangle, type WebContents } from "electron";
import {
  type AnswerProvider,
  type AssistTask,
  type ChatTurn,
  buildAssistAgentTask,
  createProvider,
  parseComparison,
  parseConditionResult,
  parseSummary,
  parseTabGroups,
  parseTranslatedSegments,
  readingMinutes,
  runAssist,
} from "@corvus/ai-engine";
import type { TabId } from "@corvus/shared";
import { ASSIST_MAX_THUMBS, ASSIST_MIN_STEPS, ASSIST_TOKEN_BUDGET, assistAgentView, historyActions } from "../shared/assist-agent";
import { keptMessages, matchesConversation, type AssistConversationSummary } from "../shared/assist-history";
import { isNewTabUrl } from "../shared/internal-urls";
import type { AgentApprovalDecision, AgentRunView } from "../shared/command-bar-ipc";
import { commandForInput } from "../shared/shortcuts";
import { matchSiteProfile, type SiteProfile } from "../shared/site-profiles";
import { hostKey, workflowsForUrl } from "../shared/workflow";
import { captureFieldScript, cleanWriteOutput, insertFieldScript, writeActionLabel, type CapturedField, type WriteAction } from "../shared/inline-write";
import { MAX_COMPARE_TABS, compareCandidates, comparisonMarkdown, type CompareCandidate, type ComparisonTable } from "../shared/compare";
import {
  ASSIST_MAX_WIDTH,
  ASSIST_MIN_WIDTH,
  type AssistActionKind,
  type AssistMessage,
  type AgentLiveView,
  type AssistPanelState,
  type AssistTabView,
  type AssistView,
  type AssistWindowExtras,
} from "../shared/assist-ipc";
import {
  findDuplicates,
  groupByDomain,
  organizerCandidates,
  proposalsFromIndices,
  sanitizeGroupsToApply,
  siteOf,
  type OrganizerProposal,
  type OrganizerTab,
} from "../shared/tab-organizer";
import {
  applyTranslationsScript,
  ASSIST_WORLD_ID,
  collectSegmentsScript,
  jumpToSectionScript,
  readPageScript,
  restoreTranslationScript,
  type RawPage,
} from "./assist-scripts";
import { AssistPanelView } from "./assist-views";
import { readVideoTranscript, seekVideo } from "./youtube-transcript";
import { youTubeVideoId } from "../shared/youtube";
import { ASSIST_AGENT_SYSTEM } from "./agent-tools";
import type { AppContext } from "./context";
import type { BrowserWindowCtl, TabRuntime } from "./window";
import { claudeCliEnv } from "../shared/settings";

const MAX_MESSAGES = 40;
const SUMMARY_CACHE = 40;
const ORGANIZER_CACHE = 10;
const TRANSLATE_SEGMENTS = 120;
const TRANSLATE_CHARS = 4500;
/** A whole-page translation stops after this many batches (about 180,000 characters). */
const TRANSLATE_MAX_BATCHES = 40;
const SCRIPT_TIMEOUT_MS = 8000;
/** Longest request the agentic chat takes (instructions can be longer than a question). */
const AGENT_REQUEST_CHARS = 2000;
const THUMB_WIDTH = 280;
/** The live view of an agent's tab: width of the capture and how often it is taken. */
const LIVE_WIDTH = 360;
const LIVE_EVERY_MS = 1200;

/** A capture through the DevTools protocol gives up after this long. */
const LIVE_CDP_TIMEOUT_MS = 8000;

/** The live view of one window: the tab it captures and its latest capture. */
interface LiveCapture {
  tabId: TabId;
  thumb: string | null;
  timer: NodeJS.Timeout;
  /** A capture is under way (the next tick skips). */
  busy: boolean;
}

interface TabAssist {
  messages: AssistMessage[];
  /** Cancels the running action; for an agent turn it stops the run. */
  abort: AbortController | null;
  /** The live agent run of this conversation, while it runs. */
  runId: string | null;
  translation: "none" | "translated" | "working";
  translatedUrl: string;
  /** The video last read on this tab: its address and where each cited stretch starts (s). */
  video?: { url: string; starts: number[] };
  /** A text field waiting for the composer to say what to write in it ("Write…"). */
  writing?: { field: CapturedField; site: string } | null;
  /** The field each written text goes into, by message id (captured in the page by token). */
  writeTokens?: Map<string, string>;
  /** "Compare tabs" is choosing which tabs to compare. */
  comparePicker?: CompareCandidate[] | null;
  /** The conversation's id in the profile's history, once kept. */
  conversationId?: string;
  /** What was last kept, to write the history only when the conversation changed. */
  savedSignature?: string;
}

/** Changes when a kept conversation gains or finishes a message. */
function conversationSignature(kept: AssistMessage[]): string {
  const last = kept.at(-1);
  return last ? `${kept.length}:${last.id}:${last.status}:${last.text.length}` : "";
}

type GroupsInput = Array<{ name: string; color: string; tabIds: string[] }>;

function isReadable(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

/** Why a feature has no AI provider, phrased for the given feature name. */
function providerSetupReason(provider: string, feature: string): string {
  if (provider === "claude-code-cli") return `Corvus could not start the Claude Code CLI. Check its path in Settings to use ${feature}.`;
  if (provider === "local") return `Set a local model and base URL in Settings to use ${feature}.`;
  return `Add an Anthropic API key in Settings, or switch to a local provider, to use ${feature}.`;
}

function hash(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex").slice(0, 24);
}

function errorText(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.length > 300 ? `${message.slice(0, 297)}…` : message;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("The page did not respond in time")), ms);
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

function setLru<K, V>(map: Map<K, V>, key: K, value: V, max: number): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > max) map.delete(map.keys().next().value as K);
}

/** A small JPEG data: URL of a screenshot for the conversation, or null when it cannot be decoded. */
function thumbnail(base64: string): string | null {
  try {
    const image = nativeImage.createFromBuffer(Buffer.from(base64, "base64"));
    if (image.isEmpty()) return null;
    const small = image.getSize().width > THUMB_WIDTH ? image.resize({ width: THUMB_WIDTH, quality: "good" }) : image;
    return `data:image/jpeg;base64,${small.toJPEG(62).toString("base64")}`;
  } catch {
    return null;
  }
}

/**
 * Corvus Assist: the per-window side panel, per-tab conversations, page reading/translation in an
 * isolated world, and the tab organizer. Every AI action is one provider call over a capped prompt.
 */
export class AssistService {
  private readonly panels = new WeakMap<BrowserWindowCtl, AssistPanelView>();
  private readonly tabs = new Map<TabId, TabAssist>();
  private readonly summaries = new Map<string, { text: string; model: string }>();
  private readonly organizerCache = new Map<string, { groups: Array<{ name: string; color: string; tabs: number[] }>; model: string }>();
  private readonly timers = new WeakMap<BrowserWindowCtl, NodeJS.Timeout>();
  private readonly live = new Map<BrowserWindowCtl, LiveCapture>();
  private provider: { key: string; value: AnswerProvider | null } | null = null;
  private testProvider: AnswerProvider | null | undefined;

  constructor(private readonly ctx: AppContext) {
    ctx.settings.onChange((next, prev) => {
      if (next === prev || JSON.stringify(next.ai) !== JSON.stringify(prev.ai)) this.provider = null;
      this.refreshAll();
    });
    ctx.agents.onChange(() => this.refreshAll());
  }

  /** Smoke tests inject a fake provider; `undefined` restores the configured one. */
  setTestProvider(provider: AnswerProvider | null | undefined): void {
    this.testProvider = provider;
    this.refreshAll();
  }

  private currentProvider(): AnswerProvider | null {
    if (this.testProvider !== undefined) return this.testProvider;
    const ai = this.ctx.settings.get().ai;
    const apiKey = this.ctx.settings.getSecret("anthropicApiKey");
    const key = JSON.stringify([ai.provider, ai.model, ai.claudeCliPath, claudeCliEnv(ai), ai.localBaseUrl, ai.localApi, Boolean(apiKey), apiKey ? hash(apiKey) : ""]);
    if (this.provider?.key !== key) {
      let value: AnswerProvider | null = null;
      try {
        value = createProvider({
          provider: ai.provider,
          apiKey,
          model: ai.model,
          claudeCliPath: ai.claudeCliPath || undefined,
          claudeCliEnv: claudeCliEnv(ai),
          localBaseUrl: ai.localBaseUrl || undefined,
          localApi: ai.localApi,
          retriever: ai.retriever,
        });
      } catch {
        value = null;
      }
      this.provider = { key, value };
    }
    return this.provider.value;
  }

  /**
   * Provider for one action, honoring a matched site profile's provider/model override. Falls back
   * to the global provider when there is no override or the override cannot be built. Connection
   * details (api key, local base URL, CLI path) always come from global settings.
   */
  private providerFor(profile: SiteProfile | null): AnswerProvider | null {
    if (this.testProvider !== undefined) return this.testProvider;
    if (!profile || (!profile.provider && !profile.model)) return this.currentProvider();
    const ai = this.ctx.settings.get().ai;
    try {
      return createProvider({
        provider: profile.provider ?? ai.provider,
        apiKey: this.ctx.settings.getSecret("anthropicApiKey"),
        model: profile.model || ai.model,
        claudeCliPath: ai.claudeCliPath || undefined,
        claudeCliEnv: claudeCliEnv(ai),
        localBaseUrl: ai.localBaseUrl || undefined,
        localApi: ai.localApi,
        retriever: ai.retriever,
      });
    } catch {
      return this.currentProvider();
    }
  }

  private lang(): string {
    return this.ctx.settings.get().ai.answerLanguage || app.getLocale() || "en";
  }

  /** Shared provider resolution + setup state, reused by the reader tools. */
  readerProviderInfo(): { provider: AnswerProvider | null; setupReason: string | null; lang: string } {
    const provider = this.currentProvider();
    const ai = this.ctx.settings.get().ai;
    const setupReason = provider ? null : providerSetupReason(ai.provider, "the reading tools");
    return { provider, setupReason, lang: this.lang() };
  }

  // ------------------------------------------------------------- panel

  private panel(win: BrowserWindowCtl): AssistPanelView {
    let panel = this.panels.get(win);
    if (!panel) {
      panel = new AssistPanelView(win.win, win.chrome, (_wc, event, input) => {
        const command = commandForInput(input, process.platform);
        if (!command) return;
        event.preventDefault();
        win.runCommand(command);
      });
      this.panels.set(win, panel);
    }
    return panel;
  }

  windowForPanel(sender: WebContents): BrowserWindowCtl | undefined {
    return this.ctx.windows.all().find((w) => this.panels.get(w)?.webContents === sender);
  }

  /** Panel WebContents of a window (smoke screenshots). Null until the panel has been opened. */
  panelWebContents(win: BrowserWindowCtl): WebContents | null {
    return this.panels.get(win)?.webContents ?? null;
  }

  isOpen(win: BrowserWindowCtl): boolean {
    return this.panels.get(win)?.open === true;
  }

  windowExtras(win: BrowserWindowCtl): AssistWindowExtras {
    return { assistOpen: this.isOpen(win), agentsPaused: this.ctx.agents.paused, agentActive: this.ctx.agents.isActive(win) };
  }

  open(win: BrowserWindowCtl, view?: AssistView): void {
    const panel = this.panel(win);
    if (view) panel.current = view;
    panel.setOpen(true);
    win.relayout();
    panel.focus();
    this.refresh(win);
    win.pushState();
  }

  close(win: BrowserWindowCtl): void {
    const panel = this.panels.get(win);
    if (!panel?.open) return;
    this.stopLive(win);
    panel.setOpen(false);
    win.relayout();
    win.focusContent();
    win.pushState();
  }

  toggle(win: BrowserWindowCtl, view?: AssistView): void {
    const panel = this.panels.get(win);
    if (panel?.open && (!view || panel.current === view)) this.close(win);
    else this.open(win, view);
  }

  setView(win: BrowserWindowCtl, view: AssistView): void {
    this.panel(win).current = view;
    this.refresh(win);
  }

  resize(win: BrowserWindowCtl, width: number): void {
    const panel = this.panel(win);
    panel.width = Math.max(ASSIST_MIN_WIDTH, Math.min(ASSIST_MAX_WIDTH, Math.round(width)));
    win.relayout();
  }

  /** Width the window reserves for the panel on the right of the page. */
  reservedWidth(win: BrowserWindowCtl, total: number): number {
    return this.panels.get(win)?.reserved(total) ?? 0;
  }

  layout(win: BrowserWindowCtl, panelBounds: Rectangle, content: Rectangle): void {
    this.panels.get(win)?.layout(panelBounds);
    this.ctx.agents.layout(win, content);
  }

  disposeWindow(win: BrowserWindowCtl): void {
    this.stopLive(win);
    this.panels.get(win)?.dispose();
    this.panels.delete(win);
    this.ctx.agents.disposeWindow(win);
  }

  private refreshAll(): void {
    for (const w of this.ctx.windows.all()) this.refresh(w);
  }

  /** Pushes fresh panel state (coalesced) when the panel is open. */
  refresh(win: BrowserWindowCtl): void {
    this.keepConversations(win);
    const panel = this.panels.get(win);
    if (!panel?.open || this.timers.has(win)) return;
    this.timers.set(
      win,
      setTimeout(() => {
        this.timers.delete(win);
        if (!win.isDisposed() && panel.open) panel.send(this.panelState(win));
      }, 30),
    );
  }

  panelState(win: BrowserWindowCtl): AssistPanelState {
    const panel = this.panel(win);
    const waiting = this.waitingElsewhere(win);
    const provider = this.currentProvider();
    const ai = this.ctx.settings.get().ai;
    const ready = provider !== null || this.ctx.agentRunner.ready();
    const setupReason = ready ? null : providerSetupReason(ai.provider, "Corvus Assist");
    return {
      ready,
      setupReason,
      provider: provider?.kind ?? ai.provider,
      model: provider?.model ?? ai.model,
      lang: this.lang(),
      dark: nativeTheme.shouldUseDarkColors,
      view: panel.current,
      tab: this.tabView(win),
      agents: this.ctx.agents.view(),
      workflows: panel.current === "workflows" ? this.workflowsView(win) : null,
      focusToken: panel.focusToken,
      waitingElsewhere: waiting,
      workingElsewhere: waiting ? null : this.workingElsewhere(win),
      keepsHistory: !win.isPrivate,
    };
  }

  /**
   * Keeps this window's finished conversations in the profile's history (never a private window's),
   * with the page they are on; a conversation an agent spread over several tabs is kept with the one
   * on screen. Only conversations that changed are written.
   */
  private keepConversations(win: BrowserWindowCtl): void {
    if (win.isPrivate || win.isDisposed()) return;
    const seen = new Set<TabAssist>();
    for (const t of [...win.listTabs()].sort((a, b) => Number(b.active) - Number(a.active))) {
      const entry = this.tabs.get(t.id);
      if (!entry || seen.has(entry)) continue;
      seen.add(entry);
      if (entry.messages.some((m) => m.status === "streaming")) continue;
      const kept = keptMessages(entry.messages);
      const signature = conversationSignature(kept);
      if (!signature || entry.savedSignature === signature) continue;
      entry.savedSignature = signature;
      entry.conversationId ??= crypto.randomUUID();
      win.profile.assistHistory.save({ id: entry.conversationId, url: t.url, pageTitle: t.title, createdAt: kept[0]!.at, updatedAt: Date.now(), messages: kept });
    }
  }

  historyList(win: BrowserWindowCtl, query: string): AssistConversationSummary[] {
    if (win.isPrivate) return [];
    return win.profile.assistHistory
      .summaries()
      .filter((s) => matchesConversation(s, query))
      .slice(0, 100);
  }

  /** Carries on a past conversation: on its page (a new tab, or this one when it is empty) or where it is open already. */
  openConversation(win: BrowserWindowCtl, id: string): void {
    const record = win.isPrivate ? undefined : win.profile.assistHistory.get(id);
    if (!record) return;
    for (const [tabId, entry] of this.tabs) {
      if (entry.conversationId === id && win.hasTab(tabId)) {
        win.activate(tabId);
        this.open(win, "assist");
        return;
      }
    }
    const active = win.activeTab();
    const activeUrl = active ? (active.view.webContents.isDestroyed() ? active.url : active.view.webContents.getURL() || active.url) : "";
    const free = active && !this.tabs.get(active.id)?.messages.length;
    let tabId: TabId;
    if (active && free && activeUrl === record.url) tabId = active.id;
    else if (active && free && isNewTabUrl(activeUrl)) {
      tabId = active.id;
      win.loadUrl(tabId, record.url);
    } else tabId = win.createTab(record.url, { activate: true }).id;
    const messages = record.messages.map((m) => ({ ...m }));
    this.tabs.set(tabId, {
      messages,
      abort: null,
      runId: null,
      translation: "none",
      translatedUrl: "",
      conversationId: record.id,
      savedSignature: conversationSignature(messages),
    });
    this.open(win, "assist");
    this.refresh(win);
  }

  removeConversation(win: BrowserWindowCtl, id: string): void {
    win.profile.assistHistory.remove(id);
    // Still open in a tab: kept again only if the person carries on with it.
    for (const entry of this.tabs.values()) if (entry.conversationId === id) entry.conversationId = undefined;
  }

  clearHistory(win: BrowserWindowCtl): void {
    win.profile.assistHistory.clear();
    for (const entry of this.tabs.values()) entry.conversationId = undefined;
  }

  /**
   * An agent run of this window working in a tab the person is not looking at, with a capture of
   * that tab taken every second or so while the panel is open.
   */
  private workingElsewhere(win: BrowserWindowCtl): AgentLiveView | null {
    const active = win.activeTab()?.id;
    const run = this.ctx.agentRunner.liveRuns(win).find((r) => r.tabId && r.tabId !== active && win.hasTab(r.tabId));
    if (!run?.tabId) {
      this.stopLive(win);
      return null;
    }
    const live = this.startLive(win, run.tabId);
    const groupId = win.groupOf(run.tabId);
    const group = groupId ? win.listGroups().find((g) => g.id === groupId)?.title : "";
    const title = group || win.listTabs().find((t) => t.id === run.tabId)?.title || "";
    return { runId: run.id, tabId: run.tabId, title, step: run.step, thumb: live.thumb };
  }

  private startLive(win: BrowserWindowCtl, tabId: TabId): LiveCapture {
    const current = this.live.get(win);
    if (current?.tabId === tabId) return current;
    this.stopLive(win);
    const live: LiveCapture = { tabId, thumb: null, busy: false, timer: setInterval(() => void this.captureLive(win, live), LIVE_EVERY_MS) };
    this.live.set(win, live);
    void this.captureLive(win, live);
    return live;
  }

  private stopLive(win: BrowserWindowCtl): void {
    const live = this.live.get(win);
    if (!live) return;
    clearInterval(live.timer);
    this.live.delete(win);
  }

  private async captureLive(win: BrowserWindowCtl, live: LiveCapture): Promise<void> {
    if (win.isDisposed() || !this.panels.get(win)?.open) return this.stopLive(win);
    const wc = win.getTab(live.tabId)?.view.webContents;
    if (!wc || wc.isDestroyed() || live.busy) return;
    live.busy = true;
    try {
      const image = await this.captureHidden(wc);
      if (!image || image.isEmpty() || this.live.get(win) !== live) return;
      const small = image.getSize().width > LIVE_WIDTH ? image.resize({ width: LIVE_WIDTH, quality: "good" }) : image;
      live.thumb = `data:image/jpeg;base64,${small.toJPEG(60).toString("base64")}`;
      this.refresh(win);
    } catch {
      // The tab is closing or busy; the next capture tries again.
    } finally {
      live.busy = false;
    }
  }

  /**
   * A capture of a tab that is not on screen. capturePage needs the tab's last frame, which a tab
   * hidden before it painted (or for long) no longer has; the DevTools protocol renders one.
   */
  private async captureHidden(wc: WebContents): Promise<Electron.NativeImage | null> {
    const image = await wc.capturePage(undefined, { stayHidden: true }).catch(() => null);
    if (image && !image.isEmpty()) return image;
    // Agent tabs have the debugger attached already (tab logs); it stays attached, as elsewhere.
    const dbg = wc.debugger;
    if (!dbg.isAttached()) dbg.attach("1.3");
    const shot = (await Promise.race([
      dbg.sendCommand("Page.captureScreenshot", { format: "jpeg", quality: 60 }),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), LIVE_CDP_TIMEOUT_MS)),
    ])) as { data: string } | null;
    return shot ? nativeImage.createFromBuffer(Buffer.from(shot.data, "base64")) : null;
  }

  /** Another tab of the window whose Assist agent turn waits for an approval (the panel shows the active tab). */
  private waitingElsewhere(win: BrowserWindowCtl): AssistPanelState["waitingElsewhere"] {
    const active = win.activeTab()?.id;
    const activeEntry = active ? this.tabs.get(active) : undefined;
    for (const [tabId, entry] of this.tabs) {
      if (tabId === active || entry === activeEntry || !entry.runId || !win.hasTab(tabId)) continue;
      if (entry.messages.at(-1)?.agent?.approval) {
        const title = win.listTabs().find((t) => t.id === tabId)?.title ?? "";
        return { tabId, title };
      }
    }
    return null;
  }

  /** Workflows for the active tab's site (the side panel's Workflows view). */
  private workflowsView(win: BrowserWindowCtl): AssistPanelState["workflows"] {
    const tab = win.activeTab();
    let url = "";
    if (tab) url = tab.view.webContents.isDestroyed() ? tab.url : tab.view.webContents.getURL() || tab.url;
    const all = this.ctx.flows.list(win.profile);
    return {
      host: hostKey(url),
      url,
      items: hostKey(url) ? workflowsForUrl(all, url) : [],
      total: all.length,
      draft: this.ctx.flows.draftView(win.profile.profile.id),
      memory: this.ctx.flows.memory.paneView(win.profile, hostKey(url)),
    };
  }

  private entry(tabId: TabId): TabAssist {
    let entry = this.tabs.get(tabId);
    if (!entry) {
      entry = { messages: [], abort: null, runId: null, translation: "none", translatedUrl: "" };
      this.tabs.set(tabId, entry);
    }
    return entry;
  }

  private tabView(win: BrowserWindowCtl): AssistTabView | null {
    const tab = win.activeTab();
    if (!tab) return null;
    this.prune();
    const entry = this.tabs.get(tab.id);
    const url = tab.view.webContents.isDestroyed() ? tab.url : tab.view.webContents.getURL() || tab.url;
    if (entry && entry.translation === "translated" && entry.translatedUrl !== url) entry.translation = "none";
    return {
      tabId: tab.id,
      url,
      title: tab.title,
      ...(tab.faviconUrl ? { faviconUrl: tab.faviconUrl } : {}),
      readable: isReadable(url),
      messages: entry?.messages ?? [],
      busy: entry?.abort !== null && entry?.abort !== undefined,
      translation: entry?.translation ?? "none",
      writing: entry?.writing ? { site: entry.writing.site, excerpt: entry.writing.field.text.replace(/\s+/g, " ").trim().slice(0, 80) } : null,
      comparePicker: entry?.comparePicker ?? null,
      canAct: this.ctx.agentRunner.ready(),
    };
  }

  /** Drops conversations of tabs that no longer exist. */
  private prune(): void {
    if (this.tabs.size < 8) return;
    for (const id of this.tabs.keys()) if (!this.ctx.windows.findTab(id)) this.tabs.delete(id);
  }

  // ------------------------------------------------------------- actions

  private readPage(wc: WebContents): Promise<RawPage> {
    return withTimeout(wc.executeJavaScriptInIsolatedWorld(ASSIST_WORLD_ID, [{ code: readPageScript() }]) as Promise<RawPage>, SCRIPT_TIMEOUT_MS);
  }

  private exec<T>(wc: WebContents, code: string): Promise<T> {
    return withTimeout(wc.executeJavaScriptInIsolatedWorld(ASSIST_WORLD_ID, [{ code }]) as Promise<T>, SCRIPT_TIMEOUT_MS);
  }

  /** Context menu: explain or translate the selected text. */
  runSelection(win: BrowserWindowCtl, tab: TabRuntime, kind: "explain" | "translate-selection", selection: string): void {
    this.open(win, "assist");
    void this.run(win, tab, kind, selection.slice(0, 4000));
  }

  /** The language the answers are written in, by name ("Spanish"), for menu labels. */
  languageName(): string {
    const lang = this.lang();
    try {
      return new Intl.DisplayNames(["en"], { type: "language" }).of(lang) ?? lang;
    } catch {
      return lang;
    }
  }

  /**
   * "Write with Corvus AI" from a text field's menu: rewrites the field's text (or its selection)
   * into the panel, where Insert puts it in the field. "Write…" (custom) first asks in the panel's
   * composer what to write.
   */
  async writeInField(win: BrowserWindowCtl, tab: TabRuntime, action: WriteAction): Promise<void> {
    const wc = tab.view.webContents;
    const entry = this.entry(tab.id);
    const site = hostKey(wc.isDestroyed() ? tab.url : wc.getURL() || tab.url);
    const field = wc.isDestroyed() ? null : await this.exec<CapturedField | null>(wc, captureFieldScript(crypto.randomUUID())).catch(() => null);
    this.open(win, "assist");
    const label = writeActionLabel(action, this.languageName());
    const fail = (error: string): void => {
      entry.messages = [...entry.messages, { id: crypto.randomUUID(), kind: "write" as const, prompt: label, text: "", status: "error" as const, error, at: Date.now() }].slice(-MAX_MESSAGES);
      this.refresh(win);
    };
    if (!field) return fail("Click in a text field first, then choose what to write. Password and payment fields are left alone.");
    if (action === "custom") {
      entry.writing = { field, site };
      this.refresh(win);
      return;
    }
    if (!field.text.trim()) return fail("This field is empty: choose “Write…” and say what to write.");
    await this.runWrite(win, tab, action, field, site, label);
  }

  /** The composer's request for the field waiting in "Write…". */
  writeRequest(win: BrowserWindowCtl, request: string): void {
    const tab = win.activeTab();
    const pending = tab ? this.tabs.get(tab.id)?.writing : undefined;
    if (!tab || !pending) return;
    this.entry(tab.id).writing = null;
    void this.runWrite(win, tab, "custom", pending.field, pending.site, request);
  }

  cancelWrite(win: BrowserWindowCtl): void {
    const tab = win.activeTab();
    const entry = tab ? this.tabs.get(tab.id) : undefined;
    if (!entry?.writing) return;
    entry.writing = null;
    this.refresh(win);
  }

  private async runWrite(win: BrowserWindowCtl, tab: TabRuntime, action: WriteAction, field: CapturedField, site: string, prompt: string): Promise<void> {
    const entry = this.entry(tab.id);
    entry.abort?.abort();
    const abort = new AbortController();
    entry.abort = abort;
    const message: AssistMessage = { id: crypto.randomUUID(), kind: "write", prompt, text: "", status: "streaming", at: Date.now(), write: { site, inserted: false } };
    entry.messages = [...entry.messages, message].slice(-MAX_MESSAGES);
    (entry.writeTokens ??= new Map()).set(message.id, field.token);
    const update = (patch: Partial<AssistMessage>): void => {
      Object.assign(message, patch);
      entry.messages = entry.messages.map((m) => (m.id === message.id ? { ...message } : m));
      this.refresh(win);
    };
    this.refresh(win);
    const wc = tab.view.webContents;
    const siteProfile = win.profile.siteProfiles.match(wc.isDestroyed() ? tab.url : wc.getURL() || tab.url);
    const addendum = siteProfile?.promptAddendum.trim();
    const provider = this.providerFor(siteProfile);
    try {
      if (!provider) throw new Error("Corvus Assist needs an AI provider. Open Settings to add one.");
      const started = Date.now();
      const task = { kind: "write" as const, instruction: action, text: field.text, lang: this.lang(), site, ...(action === "custom" ? { request: prompt } : {}) };
      let text = "";
      for await (const ev of runAssist(provider, task, abort.signal, addendum ? { systemAddendum: addendum } : undefined)) {
        if (abort.signal.aborted) break;
        if (ev.type === "delta") {
          text += ev.text;
          update({ text });
        } else {
          message.usage = { inputTokens: ev.inputTokens, outputTokens: ev.outputTokens, model: ev.model, cached: false, ms: Date.now() - started };
        }
      }
      if (abort.signal.aborted) {
        update({ status: "cancelled" });
        return;
      }
      const final = cleanWriteOutput(text, field.text);
      update(final ? { text: final, status: "done" } : { text: "", status: "error", error: "The AI wrote nothing for this field." });
    } catch (err) {
      update({ status: abort.signal.aborted ? "cancelled" : "error", error: errorText(err) });
    } finally {
      if (entry.abort === abort) entry.abort = null;
      this.refresh(win);
    }
  }

  /** Insert: the person approved a written text; it goes into its field, as an edit the page sees. */
  async insertWrite(win: BrowserWindowCtl, messageId: string): Promise<void> {
    const tab = win.activeTab();
    const entry = tab ? this.tabs.get(tab.id) : undefined;
    const message = entry?.messages.find((m) => m.id === messageId);
    const token = entry?.writeTokens?.get(messageId);
    if (!tab || !entry || !message?.write || message.status !== "done" || message.write.inserted || !token) return;
    const wc = tab.view.webContents;
    const inserted = !wc.isDestroyed() && (await this.exec<boolean>(wc, insertFieldScript(token, message.text)).catch(() => false)) === true;
    const write = { ...message.write, inserted, ...(inserted ? {} : { gone: true }) };
    entry.messages = entry.messages.map((m) => (m.id === messageId ? { ...m, write } : m));
    if (inserted) {
      entry.writeTokens?.delete(messageId);
      win.focusContent();
    }
    this.refresh(win);
  }

  /** "Compare tabs with Corvus AI…" from a tab's menu: the panel lists the window's pages to pick. */
  openCompare(win: BrowserWindowCtl, fromTabId: TabId): void {
    const tab = win.activeTab();
    if (!tab) return;
    this.entry(tab.id).comparePicker = compareCandidates(win.listTabs(), fromTabId);
    this.open(win, "assist");
  }

  closeCompare(win: BrowserWindowCtl): void {
    const tab = win.activeTab();
    const entry = tab ? this.tabs.get(tab.id) : undefined;
    if (!entry?.comparePicker) return;
    entry.comparePicker = null;
    this.refresh(win);
  }

  /**
   * Reads each chosen tab (loading the ones that are asleep or not loaded yet, without showing
   * them) and asks for one table that compares them, pages as columns, with a verdict.
   */
  async compareTabs(win: BrowserWindowCtl, tabIds: TabId[], focus: string): Promise<void> {
    const tab = win.activeTab();
    if (!tab) return;
    const entry = this.entry(tab.id);
    entry.comparePicker = null;
    const ids = [...new Set(tabIds)].filter((id) => win.hasTab(id)).slice(0, MAX_COMPARE_TABS);
    entry.abort?.abort();
    const abort = new AbortController();
    entry.abort = abort;
    const message: AssistMessage = { id: crypto.randomUUID(), kind: "compare", prompt: focus || `Compare ${ids.length} tabs`, text: "", status: "streaming", at: Date.now() };
    entry.messages = [...entry.messages, message].slice(-MAX_MESSAGES);
    const update = (patch: Partial<AssistMessage>): void => {
      Object.assign(message, patch);
      entry.messages = entry.messages.map((m) => (m.id === message.id ? { ...message } : m));
      this.refresh(win);
    };
    this.refresh(win);
    try {
      if (ids.length < 2) throw new Error("Choose at least two tabs to compare.");
      const provider = this.currentProvider();
      if (!provider) throw new Error("Corvus Assist needs an AI provider. Open Settings to add one.");
      const started = Date.now();
      const pages: Array<{ url: string; title: string; sections: Array<{ heading: string; text: string }> }> = [];
      const columns: ComparisonTable["pages"] = [];
      for (const id of ids) {
        if (abort.signal.aborted) break;
        await win.ensureLoaded(id);
        const t = win.getTab(id);
        const wc = t?.view.webContents;
        if (!t || !wc || wc.isDestroyed() || !isReadable(wc.getURL())) continue;
        const raw = await this.readPage(wc).catch(() => null);
        if (!raw || raw.sections.length === 0) continue;
        pages.push({ url: raw.url, title: raw.title, sections: raw.sections });
        columns.push({ tabId: id, title: t.title || raw.title, url: raw.url, ...(t.faviconUrl ? { faviconUrl: t.faviconUrl } : {}) });
      }
      if (!abort.signal.aborted && pages.length < 2) throw new Error("Corvus could read fewer than two of these pages.");
      let text = "";
      for await (const ev of runAssist(provider, { kind: "compare", pages, lang: this.lang(), ...(focus ? { focus } : {}) }, abort.signal)) {
        if (abort.signal.aborted) break;
        if (ev.type === "delta") text += ev.text;
        else message.usage = { inputTokens: ev.inputTokens, outputTokens: ev.outputTokens, model: ev.model, cached: false, ms: Date.now() - started };
      }
      if (abort.signal.aborted) {
        update({ status: "cancelled" });
        return;
      }
      const parsed = parseComparison(text, pages.length);
      if (!parsed) throw new Error("The comparison came back unreadable. Try again.");
      update({ status: "done", comparison: { pages: columns, rows: parsed.rows, verdict: parsed.verdict } });
    } catch (err) {
      update({ status: abort.signal.aborted ? "cancelled" : "error", error: errorText(err) });
    } finally {
      if (entry.abort === abort) entry.abort = null;
      this.refresh(win);
    }
  }

  copyComparison(win: BrowserWindowCtl, messageId: string): void {
    const tab = win.activeTab();
    const comparison = tab ? this.tabs.get(tab.id)?.messages.find((m) => m.id === messageId)?.comparison : undefined;
    if (comparison) clipboard.writeText(comparisonMarkdown(comparison));
  }

  copyText(win: BrowserWindowCtl, messageId: string): void {
    const tab = win.activeTab();
    const message = tab ? this.tabs.get(tab.id)?.messages.find((m) => m.id === messageId) : undefined;
    if (message?.text) clipboard.writeText(message.text);
  }

  /** Context menu / panel: page-level actions. */
  runPage(win: BrowserWindowCtl, tab: TabRuntime, kind: "summarize" | "translate-page"): void {
    this.open(win, "assist");
    void this.run(win, tab, kind, "");
  }

  activeAction(win: BrowserWindowCtl, kind: "summarize" | "translate-page" | "translate-more" | "ask", input = ""): void {
    const tab = win.activeTab();
    if (!tab) return;
    // The chat runs as a browser agent whenever agent mode is set up; otherwise it is page Q&A.
    if (kind === "ask" && this.ctx.agentRunner.ready()) {
      void this.runAgentChat(win, tab, input);
      return;
    }
    void this.run(win, tab, kind === "translate-more" ? "translate-page" : kind, input, kind === "translate-more");
  }

  /** Approve, skip or stop the action the active tab's Assist agent turn is waiting on. */
  approve(win: BrowserWindowCtl, decision: AgentApprovalDecision): void {
    const tab = win.activeTab();
    const runId = tab ? this.tabs.get(tab.id)?.runId : null;
    if (runId) this.ctx.agentRunner.approveEmbedded(runId, decision);
  }

  handBack(win: BrowserWindowCtl): void {
    const tab = win.activeTab();
    const runId = tab ? this.tabs.get(tab.id)?.runId : null;
    if (runId) this.ctx.agentRunner.handBackEmbedded(runId);
  }

  showTab(win: BrowserWindowCtl, tabId: TabId, url?: string): void {
    if (win.hasTab(tabId)) win.activate(tabId);
    else if (url && /^https?:\/\//i.test(url)) win.createTab(url, { activate: true });
  }

  /**
   * One chat turn as a browser agent in the user's current tab: the agent gets the request, the
   * page text and the recent conversation (with the steps taken), answers directly when it can,
   * and otherwise navigates, clicks, types and searches through the shared AgentRunner, so the
   * approval and spend gates, the pause switch, the overlay and run history all apply. Steps,
   * approvals and screenshot thumbnails show up inline in this conversation.
   */
  private async runAgentChat(win: BrowserWindowCtl, tab: TabRuntime, question: string): Promise<void> {
    const entry = this.entry(tab.id);
    entry.abort?.abort();
    const abort = new AbortController();
    entry.abort = abort;
    const wc = tab.view.webContents;
    const prompt = question.trim().slice(0, AGENT_REQUEST_CHARS);
    const history: ChatTurn[] = entry.messages
      .filter((m) => m.kind === "ask" && m.status === "done")
      .map((m) => ({ question: m.prompt, answer: m.text, actions: historyActions(m.agent) }));
    const message: AssistMessage = { id: crypto.randomUUID(), kind: "ask", prompt, text: "", status: "streaming", at: Date.now() };
    entry.messages = [...entry.messages, message].slice(-MAX_MESSAGES);
    const update = (patch: Partial<AssistMessage>): void => {
      Object.assign(message, patch);
      for (const e of new Set(this.tabs.values())) {
        if (e.messages.some((m) => m.id === message.id)) e.messages = e.messages.map((m) => (m.id === message.id ? { ...message } : m));
      }
      this.refresh(win);
    };
    const finish = (): void => {
      if (entry.abort === abort) entry.abort = null;
      entry.runId = null;
      this.refresh(win);
    };
    this.refresh(win);

    const started = Date.now();
    const url = wc.isDestroyed() ? tab.url : wc.getURL() || tab.url;
    const page = !wc.isDestroyed() && isReadable(url) ? await this.readPage(wc).catch(() => null) : null;
    if (abort.signal.aborted) {
      update({ status: "cancelled" });
      finish();
      return;
    }
    if (page) update({ sections: page.sections.map((s) => s.heading) });

    const thumbs = new Map<string, string>();
    const sync = (view: AgentRunView): void => {
      const { view: agent, answer } = assistAgentView(view, thumbs);
      const status: AssistMessage["status"] =
        view.status === "done" ? "done" : view.status === "stopped" ? "cancelled" : view.status === "error" ? "error" : "streaming";
      const done = status !== "streaming";
      update({
        agent,
        text: answer,
        status,
        ...(status === "error" ? { error: view.error ?? "The assistant stopped with an error." } : {}),
        ...(done ? { usage: { inputTokens: view.inputTokens, ...(view.cachedInputTokens ? { cachedInputTokens: view.cachedInputTokens } : {}), outputTokens: view.outputTokens, model: view.model, cached: false, ms: Date.now() - started } } : {}),
      });
      // The conversation follows the agent into a tab it opened, so the panel keeps showing it there.
      if (view.tabId && view.tabId !== tab.id && !this.tabs.has(view.tabId)) this.tabs.set(view.tabId, entry);
      if (done && entry.runId === view.id) finish();
    };
    const settings = this.ctx.settings.get();
    const launched = this.ctx.agentRunner.startEmbedded(win, {
      tabId: tab.id,
      url: isReadable(url) ? url : null,
      task: prompt,
      seed: buildAssistAgentTask({ lang: this.lang(), question: prompt, history, tab: { url, title: tab.title }, page }),
      system: ASSIST_AGENT_SYSTEM,
      maxSteps: Math.max(settings.agent.maxSteps, ASSIST_MIN_STEPS),
      tokenBudget: ASSIST_TOKEN_BUDGET,
      onUpdate: sync,
      onScreenshot: (stepId, image) => {
        const thumb = thumbnail(image.base64);
        if (!thumb) return;
        thumbs.set(stepId, thumb);
        while (thumbs.size > ASSIST_MAX_THUMBS) thumbs.delete(thumbs.keys().next().value as string);
      },
    });
    if ("error" in launched) {
      update({ status: "error", error: launched.error });
      finish();
      return;
    }
    entry.runId = launched.id;
    abort.signal.addEventListener("abort", () => this.ctx.agentRunner.stopEmbedded(launched.id), { once: true });
  }

  cancel(win: BrowserWindowCtl): void {
    const tab = win.activeTab();
    if (tab) this.tabs.get(tab.id)?.abort?.abort();
  }

  clear(win: BrowserWindowCtl): void {
    const tab = win.activeTab();
    if (!tab) return;
    const entry = this.tabs.get(tab.id);
    entry?.abort?.abort();
    // A new conversation: the one before stays in the history.
    if (entry) {
      entry.messages = [];
      entry.conversationId = undefined;
      entry.savedSignature = undefined;
    }
    this.refresh(win);
  }

  async jumpToSection(win: BrowserWindowCtl, index: number): Promise<void> {
    const tab = win.activeTab();
    const wc = tab?.view.webContents;
    if (!tab || !wc || wc.isDestroyed()) return;
    // A video's sections are stretches of its transcript: jump the video, not the page.
    const video = this.tabs.get(tab.id)?.video;
    const start = video && video.url === wc.getURL() ? video.starts[index] : undefined;
    if (start !== undefined) {
      await seekVideo(wc, start);
      return;
    }
    await this.exec(wc, jumpToSectionScript(index)).catch(() => false);
  }

  /**
   * What Summarize and Ask read: on a video page with captions, the transcript in timestamped
   * stretches (remembered for jumps); otherwise the page's own sections.
   */
  private async readForAssist(wc: WebContents, entry: TabAssist): Promise<RawPage & { video?: boolean }> {
    const url = wc.getURL();
    if (youTubeVideoId(url)) {
      const transcript = await readVideoTranscript(wc, this.lang());
      if (transcript) {
        entry.video = { url, starts: transcript.chunks.map((c) => c.start) };
        const sections = transcript.chunks.map((c) => ({ heading: c.heading, text: c.text }));
        return { url, title: transcript.title, lang: "", sections, words: sections.reduce((n, s) => n + s.text.split(/\s+/).length, 0), video: true };
      }
    }
    delete entry.video;
    return this.readPage(wc);
  }

  /**
   * Translates a whole page in place into `lang`, batch by batch in page order (for the address
   * bar's translate button), reporting the pieces translated so far. Stops at the abort signal;
   * whatever was translated stays until restoreTranslation.
   */
  async translateWholePage(win: BrowserWindowCtl, tab: TabRuntime, lang: string, onProgress: (translated: number) => void, signal: AbortSignal): Promise<number> {
    const wc = tab.view.webContents;
    if (wc.isDestroyed() || !isReadable(wc.getURL())) throw new Error("Only web pages can be translated.");
    const siteProfile = win.profile.siteProfiles.match(wc.getURL());
    const provider = this.providerFor(siteProfile);
    if (!provider) throw new Error(providerSetupReason(this.ctx.settings.get().ai.provider, "page translation"));
    const addendum = siteProfile?.promptAddendum.trim();
    await this.exec(wc, restoreTranslationScript()).catch(() => 0);
    let total = 0;
    for (let i = 0; i < TRANSLATE_MAX_BATCHES && !signal.aborted; i++) {
      const batch = await this.exec<{ segments: string[]; more: boolean }>(wc, collectSegmentsScript(TRANSLATE_SEGMENTS, TRANSLATE_CHARS));
      if (batch.segments.length === 0) break;
      let text = "";
      for await (const ev of runAssist(provider, { kind: "translate-page", segments: batch.segments, lang }, signal, addendum ? { systemAddendum: addendum } : undefined)) {
        if (ev.type === "delta") text += ev.text;
      }
      if (signal.aborted || wc.isDestroyed()) break;
      total += await this.exec<number>(wc, applyTranslationsScript(parseTranslatedSegments(text, batch.segments.length)));
      onProgress(total);
      if (!batch.more) break;
    }
    return total;
  }

  /** Puts a page's original text back after a translation. */
  async restoreTranslation(tab: TabRuntime): Promise<void> {
    if (tab.view.webContents.isDestroyed()) return;
    await this.exec(tab.view.webContents, restoreTranslationScript()).catch(() => 0);
    const entry = this.tabs.get(tab.id);
    if (entry) entry.translation = "none";
  }

  async restorePage(win: BrowserWindowCtl): Promise<void> {
    const tab = win.activeTab();
    if (!tab) return;
    const entry = this.entry(tab.id);
    entry.abort?.abort();
    await this.exec(tab.view.webContents, restoreTranslationScript()).catch(() => 0);
    entry.translation = "none";
    this.refresh(win);
  }

  async run(win: BrowserWindowCtl, tab: TabRuntime, kind: Exclude<AssistActionKind, "write" | "compare">, input: string, continuing = false): Promise<void> {
    const entry = this.entry(tab.id);
    entry.abort?.abort();
    const abort = new AbortController();
    entry.abort = abort;
    const wc = tab.view.webContents;
    const prompt = kind === "ask" ? input.trim().slice(0, 600) : kind === "explain" || kind === "translate-selection" ? input.trim().slice(0, 280) : "";
    const message: AssistMessage = { id: crypto.randomUUID(), kind, prompt, text: "", status: "streaming", at: Date.now() };
    entry.messages = [...entry.messages, message].slice(-MAX_MESSAGES);
    const update = (patch: Partial<AssistMessage>): void => {
      Object.assign(message, patch);
      entry.messages = entry.messages.map((m) => (m.id === message.id ? { ...message } : m));
      this.refresh(win);
    };
    this.refresh(win);

    const matchUrl = wc.isDestroyed() ? tab.url : wc.getURL() || tab.url;
    const siteProfile = win.profile.siteProfiles.match(matchUrl);
    const addendum = siteProfile?.promptAddendum.trim();
    const provider = this.providerFor(siteProfile);
    try {
      if (!provider) throw new Error("Corvus Assist needs an AI provider. Open Settings to add one.");
      const lang = this.lang();
      const started = Date.now();
      let task: AssistTask;
      let sections: string[] | undefined;
      let segmentsCount = 0;
      let more = false;
      let cacheKey: string | null = null;

      if (kind === "summarize" || kind === "ask") {
        if (wc.isDestroyed() || !isReadable(wc.getURL())) throw new Error("Corvus Assist can only read web pages.");
        const page = await this.readForAssist(wc, entry);
        sections = page.sections.map((s) => s.heading);
        const fullText = page.sections.map((s) => s.text).join(" ");
        if (page.video) update({ video: true });
        if (kind === "summarize") {
          update({ sections, readingMinutes: readingMinutes(fullText) });
          task = { kind, page, lang };
          cacheKey = hash(JSON.stringify([page.url, lang, provider.model, addendum ?? "", page.sections]));
        } else {
          const history: ChatTurn[] = entry.messages
            .filter((m) => m.kind === "ask" && m.status === "done" && m.id !== message.id)
            .map((m) => ({ question: m.prompt, answer: m.text }));
          update({ sections });
          task = { kind, page, lang, question: input, history };
        }
      } else if (kind === "explain") {
        task = { kind, selection: input, lang, page: { title: tab.title, url: wc.isDestroyed() ? tab.url : wc.getURL() } };
      } else if (kind === "translate-selection") {
        task = { kind, selection: input, lang };
      } else {
        if (wc.isDestroyed() || !isReadable(wc.getURL())) throw new Error("Corvus Assist can only translate web pages.");
        if (!continuing) await this.exec(wc, restoreTranslationScript()).catch(() => 0);
        entry.translation = "working";
        const batch = await this.exec<{ segments: string[]; more: boolean }>(wc, collectSegmentsScript(TRANSLATE_SEGMENTS, TRANSLATE_CHARS));
        if (batch.segments.length === 0) throw new Error(continuing ? "Everything visible is already translated." : "No text to translate on this page.");
        segmentsCount = batch.segments.length;
        more = batch.more;
        task = { kind, segments: batch.segments, lang };
      }

      const cached = cacheKey ? this.summaries.get(cacheKey) : undefined;
      if (cached) {
        update({ text: cached.text, summary: parseSummary(cached.text, sections?.length ?? 0), status: "done", usage: { inputTokens: 0, outputTokens: 0, model: cached.model, cached: true, ms: Date.now() - started } });
        return;
      }

      let text = "";
      let lines = 0;
      for await (const ev of runAssist(provider, task, abort.signal, addendum ? { systemAddendum: addendum } : undefined)) {
        if (abort.signal.aborted) break;
        if (ev.type === "delta") {
          text += ev.text;
          if (kind === "translate-page") {
            const now = (text.match(/\n/g) ?? []).length;
            if (now !== lines) {
              lines = now;
              update({ text: `${Math.min(lines, segmentsCount)}/${segmentsCount}` });
            }
          } else if (kind === "summarize") {
            update({ text, summary: parseSummary(text, sections?.length ?? 0) });
          } else {
            update({ text });
          }
        } else {
          message.usage = { inputTokens: ev.inputTokens, outputTokens: ev.outputTokens, model: ev.model, cached: false, ms: Date.now() - started };
        }
      }
      if (abort.signal.aborted) {
        if (kind === "translate-page") entry.translation = entry.translatedUrl ? "translated" : "none";
        update({ status: "cancelled" });
        return;
      }
      if (kind === "translate-page") {
        const translations = parseTranslatedSegments(text, segmentsCount);
        const changed = await this.exec<number>(wc, applyTranslationsScript(translations));
        entry.translation = "translated";
        entry.translatedUrl = wc.getURL();
        update({ text: "", status: "done", translated: changed, more });
      } else {
        const final = text.trim();
        if (kind === "summarize" && cacheKey && parseSummary(final, sections?.length ?? 0).tldr) {
          setLru(this.summaries, cacheKey, { text: final, model: message.usage?.model ?? provider.model }, SUMMARY_CACHE);
        }
        update({ text: final, status: "done", ...(kind === "summarize" ? { summary: parseSummary(final, sections?.length ?? 0) } : {}) });
      }
    } catch (err) {
      if (kind === "translate-page") entry.translation = entry.translatedUrl === wc.getURL() && !wc.isDestroyed() ? "translated" : "none";
      update({ status: abort.signal.aborted ? "cancelled" : "error", error: errorText(err) });
    } finally {
      if (entry.abort === abort) entry.abort = null;
      this.refresh(win);
    }
  }

  /**
   * A watched page's "notify me when…": one small call that says whether the condition holds on
   * the page now, and the fact that decides it. Null without an AI provider or a readable verdict.
   */
  async evaluateWatchCondition(
    input: { url: string; title: string; condition: string; text: string },
    signal?: AbortSignal,
  ): Promise<{ met: boolean; detail: string } | null> {
    const provider = this.currentProvider();
    if (!provider) return null;
    let text = "";
    for await (const ev of runAssist(provider, { kind: "watch-condition", ...input, lang: this.lang() }, signal)) {
      if (ev.type === "delta") text += ev.text;
    }
    return parseConditionResult(text);
  }

  /**
   * One token-cheap provider call that summarizes a monitored page's change, in the user's language.
   * Page content (the diff) is untrusted. Returns null when no AI provider is configured.
   */
  async summarizeWatchChange(input: { url: string; title: string; diff: string }, signal?: AbortSignal): Promise<{ text: string; model: string } | null> {
    const provider = this.currentProvider();
    if (!provider) return null;
    let text = "";
    let model = provider.model;
    for await (const ev of runAssist(provider, { kind: "watch-change", url: input.url, title: input.title, diff: input.diff, lang: this.lang() }, signal)) {
      if (ev.type === "delta") text += ev.text;
      else model = ev.model;
    }
    const trimmed = text.trim();
    return trimmed ? { text: trimmed, model } : null;
  }

  // ------------------------------------------------------------- tab organizer

  private organizerTabs(win: BrowserWindowCtl): OrganizerTab[] {
    return win.listTabs().map((t) => ({
      id: t.id,
      title: t.title,
      url: t.url,
      pinned: t.pinned,
      active: t.active,
      ...(t.groupId ? { groupId: t.groupId } : {}),
      ...(t.faviconUrl ? { faviconUrl: t.faviconUrl } : {}),
    }));
  }

  async propose(win: BrowserWindowCtl): Promise<OrganizerProposal> {
    const all = this.organizerTabs(win);
    const candidates = organizerCandidates(all);
    const duplicates = findDuplicates(all);
    const base = {
      duplicates,
      tabs: all.map((t) => ({ id: t.id, title: t.title, url: t.url, ...(t.faviconUrl ? { faviconUrl: t.faviconUrl } : {}) })),
    };
    const fallback = (note: string | null): OrganizerProposal => ({ ...base, source: "domain", groups: groupByDomain(all), usage: null, note });
    const provider = this.currentProvider();
    if (!provider) return fallback("Grouped by site. Add an AI provider in Settings for topic groups.");
    if (candidates.length < 3) return fallback(candidates.length === 0 ? "There are no ungrouped web tabs to organize." : null);

    const inputs = candidates.map((t) => ({ title: t.title, domain: siteOf(t.url) }));
    const key = hash(JSON.stringify([this.lang(), provider.model, inputs]));
    const hit = this.organizerCache.get(key);
    if (hit) {
      const groups = proposalsFromIndices(hit.groups, candidates);
      return { ...base, source: "ai", groups, usage: { inputTokens: 0, outputTokens: 0, model: hit.model, cached: true }, note: null };
    }
    try {
      let text = "";
      let usage: OrganizerProposal["usage"] = null;
      for await (const ev of runAssist(provider, { kind: "organize-tabs", tabs: inputs, lang: this.lang() })) {
        if (ev.type === "delta") text += ev.text;
        else usage = { inputTokens: ev.inputTokens, outputTokens: ev.outputTokens, model: ev.model, cached: false };
      }
      const parsed = parseTabGroups(text, candidates.length);
      const groups = proposalsFromIndices(parsed, candidates);
      if (groups.length === 0) return { ...fallback("The AI found no clear topics, so tabs are grouped by site."), usage };
      setLru(this.organizerCache, key, { groups: parsed, model: usage?.model ?? provider.model }, ORGANIZER_CACHE);
      return { ...base, source: "ai", groups, usage, note: null };
    } catch (err) {
      return fallback(`AI grouping failed (${errorText(err)}), so tabs are grouped by site.`);
    }
  }

  applyOrganizer(win: BrowserWindowCtl, rawGroups: unknown, rawClose: unknown): { grouped: number; closed: number } {
    const known = new Set(win.tabIds());
    const close = (Array.isArray(rawClose) ? rawClose : []).filter((id): id is string => typeof id === "string" && known.has(id));
    const remaining = new Set([...known].filter((id) => !close.includes(id)));
    const groups = sanitizeGroupsToApply(rawGroups as GroupsInput, remaining);
    let grouped = 0;
    for (const g of groups) {
      if (win.createGroup(g.tabIds, { title: g.name, color: g.color })) grouped += 1;
    }
    // Close last: closing can activate another tab, which must not disturb the new groups.
    if (close.length > 0 && close.length < known.size) win.closeTabs(close);
    return { grouped, closed: close.length < known.size ? close.length : 0 };
  }
}
