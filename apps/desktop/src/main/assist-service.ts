import crypto from "node:crypto";
import { app, nativeTheme, type Rectangle, type WebContents } from "electron";
import {
  type AnswerProvider,
  type AssistTask,
  type ChatTurn,
  createProvider,
  parseSummary,
  parseTabGroups,
  parseTranslatedSegments,
  readingMinutes,
  runAssist,
} from "@corvus/ai-engine";
import type { TabId } from "@corvus/shared";
import { commandForInput } from "../shared/shortcuts";
import { matchSiteProfile, type SiteProfile } from "../shared/site-profiles";
import { hostKey, workflowsForUrl } from "../shared/workflow";
import {
  ASSIST_MAX_WIDTH,
  ASSIST_MIN_WIDTH,
  type AssistActionKind,
  type AssistMessage,
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
import type { AppContext } from "./context";
import type { BrowserWindowCtl, TabRuntime } from "./window";

const MAX_MESSAGES = 40;
const SUMMARY_CACHE = 40;
const ORGANIZER_CACHE = 10;
const TRANSLATE_SEGMENTS = 120;
const TRANSLATE_CHARS = 4500;
const SCRIPT_TIMEOUT_MS = 8000;

interface TabAssist {
  messages: AssistMessage[];
  abort: AbortController | null;
  translation: "none" | "translated" | "working";
  translatedUrl: string;
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
    const key = JSON.stringify([ai.provider, ai.model, ai.claudeCliPath, ai.localBaseUrl, ai.localApi, Boolean(apiKey), apiKey ? hash(apiKey) : ""]);
    if (this.provider?.key !== key) {
      let value: AnswerProvider | null = null;
      try {
        value = createProvider({
          provider: ai.provider,
          apiKey,
          model: ai.model,
          claudeCliPath: ai.claudeCliPath || undefined,
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
    this.panels.get(win)?.dispose();
    this.panels.delete(win);
    this.ctx.agents.disposeWindow(win);
  }

  private refreshAll(): void {
    for (const w of this.ctx.windows.all()) this.refresh(w);
  }

  /** Pushes fresh panel state (coalesced) when the panel is open. */
  refresh(win: BrowserWindowCtl): void {
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
    const provider = this.currentProvider();
    const ai = this.ctx.settings.get().ai;
    const setupReason = provider ? null : providerSetupReason(ai.provider, "Corvus Assist");
    return {
      ready: provider !== null,
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
    };
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
      entry = { messages: [], abort: null, translation: "none", translatedUrl: "" };
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

  /** Context menu / panel: page-level actions. */
  runPage(win: BrowserWindowCtl, tab: TabRuntime, kind: "summarize" | "translate-page"): void {
    this.open(win, "assist");
    void this.run(win, tab, kind, "");
  }

  activeAction(win: BrowserWindowCtl, kind: "summarize" | "translate-page" | "translate-more" | "ask", input = ""): void {
    const tab = win.activeTab();
    if (!tab) return;
    void this.run(win, tab, kind === "translate-more" ? "translate-page" : kind, input, kind === "translate-more");
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
    if (entry) entry.messages = [];
    this.refresh(win);
  }

  async jumpToSection(win: BrowserWindowCtl, index: number): Promise<void> {
    const wc = win.activeTab()?.view.webContents;
    if (!wc || wc.isDestroyed()) return;
    await this.exec(wc, jumpToSectionScript(index)).catch(() => false);
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

  async run(win: BrowserWindowCtl, tab: TabRuntime, kind: AssistActionKind, input: string, continuing = false): Promise<void> {
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
        const page = await this.readPage(wc);
        sections = page.sections.map((s) => s.heading);
        const fullText = page.sections.map((s) => s.text).join(" ");
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
