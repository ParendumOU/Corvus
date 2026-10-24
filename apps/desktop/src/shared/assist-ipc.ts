/**
 * IPC contracts for Corvus Assist (side panel), the AI tab organizer and the agent activity
 * overlay. The panel and the overlay are their own WebContentsViews in the default session; they
 * are never tabs, so neither web pages, extensions nor MCP agents can read or script them.
 */
import type { TabId } from "@corvus/shared";
import type { AgentCall, AgentClient } from "./agent-activity";
import type { AssistAgentView } from "./assist-agent";
import type { CompareCandidate, ComparisonTable } from "./compare";
import type { AgentApprovalDecision } from "./command-bar-ipc";
import type { GroupProposal, OrganizerProposal } from "./tab-organizer";
import type { FlowApprovalDecision, FlowView, SiteMemoryPaneView, WorkflowDraftView } from "./flow-ipc";
import type { MemoryHintKind } from "./site-memory";
import type { WorkflowEdit } from "./workflow";

export const ASSIST_RPC = "corvus:assist-rpc";
export const ASSIST_EVENT = "corvus:assist-event";
export const OVERLAY_EVENT = "corvus:overlay-event";
export const OVERLAY_DISMISS = "corvus:overlay-dismiss";

export const ASSIST_MIN_WIDTH = 320;
export const ASSIST_MAX_WIDTH = 640;
export const ASSIST_DEFAULT_WIDTH = 380;

export type AssistActionKind = "summarize" | "ask" | "explain" | "translate-selection" | "translate-page" | "write" | "compare";

export interface AssistUsage {
  inputTokens: number;
  outputTokens: number;
  model: string;
  cached: boolean;
  ms: number;
}

export interface AssistMessage {
  id: string;
  kind: AssistActionKind;
  /** The user's question, or an excerpt of the selection. */
  prompt: string;
  text: string;
  status: "streaming" | "done" | "error" | "cancelled";
  error?: string;
  usage?: AssistUsage;
  /** Parsed summary (also while streaming). */
  summary?: { tldr: string; points: Array<{ text: string; sections: number[] }> };
  /** Section headings the answer can cite as [n] (summaries and answers). */
  sections?: string[];
  /** The sections are a video's transcript: their headings are timestamps a citation plays from. */
  video?: boolean;
  readingMinutes?: number;
  /** Page translation: how many passages were translated. */
  translated?: number;
  /** Page translation: more passages are left after this batch. */
  more?: boolean;
  /** "Write with Corvus AI": the text is for a field on `site`; Insert puts it there (once). */
  write?: { site: string; inserted: boolean; gone?: boolean };
  /** "Compare tabs": the table (pages as columns) and the verdict, once the reply is in. */
  comparison?: ComparisonTable;
  /** The turn ran as a browser agent: its steps and any approval waiting for the person. */
  agent?: AssistAgentView;
  at: number;
}

export interface AssistTabView {
  tabId: TabId;
  url: string;
  title: string;
  faviconUrl?: string;
  /** Whether the page can be read (web page, not an internal or blank page). */
  readable: boolean;
  messages: AssistMessage[];
  busy: boolean;
  translation: "none" | "translated" | "working";
  /** A text field waits for what to write in it ("Write…" in its menu): the composer asks for that. */
  writing: { site: string; excerpt: string } | null;
  /** "Compare tabs" is choosing its tabs: the window's web pages, the ticked ones to compare. */
  comparePicker: CompareCandidate[] | null;
  /** The chat can act in the browser (an agent provider is set up), so it works on any tab. */
  canAct: boolean;
}

export interface AgentActivityView {
  paused: boolean;
  calls: AgentCall[];
  clients: AgentClient[];
  mcpRunning: boolean;
}

export type AssistView = "assist" | "agents" | "workflows";

/** The Workflows view: saved workflows that apply to the active tab's site, plus a pending draft. */
export interface WorkflowsPaneView {
  /** Host of the active tab ("" when it is not a web page). */
  host: string;
  url: string;
  /** Workflows whose sites match the host, most recently useful first. */
  items: FlowView[];
  /** All saved flows in the profile (for the "open the full list" link). */
  total: number;
  /** A run proposed as a workflow, waiting for review. */
  draft: WorkflowDraftView | null;
  /** The Learned tab: what Corvus learned about this site. */
  memory: SiteMemoryPaneView;
}

export interface AssistPanelState {
  /** A provider is configured (API key or Claude Code CLI). */
  ready: boolean;
  setupReason: string | null;
  provider: string;
  model: string;
  lang: string;
  dark: boolean;
  view: AssistView;
  tab: AssistTabView | null;
  agents: AgentActivityView;
  /** Present while the Workflows view is shown. */
  workflows: WorkflowsPaneView | null;
  /** Bumped when the input should take focus (shortcut, context menu). */
  focusToken: number;
  /** An Assist run in another tab of this window is waiting for the person's approval. */
  waitingElsewhere: { tabId: TabId; title: string } | null;
}

export type AssistEventMessage = { type: "state"; state: AssistPanelState };

export interface AssistRpc {
  "state.get"(): AssistPanelState;
  "panel.close"(): void;
  "panel.resize"(width: number): void;
  "panel.setView"(view: AssistView): void;
  "assist.summarize"(): void;
  "assist.ask"(question: string): void;
  "assist.translatePage"(): void;
  "assist.translateMore"(): void;
  "assist.restorePage"(): void;
  "assist.cancel"(): void;
  /** What to write in the field waiting for it (see AssistTabView.writing). */
  "assist.write"(request: string): void;
  /** Stop waiting: the field is left as it is. */
  "assist.cancelWrite"(): void;
  /** Puts a written text into its field (the person approved it). */
  "assist.insertWrite"(messageId: string): void;
  "assist.copyText"(messageId: string): void;
  /** Compares these tabs (2 to 6), with what matters to the person first. */
  "assist.compare"(tabIds: TabId[], focus: string): void;
  "assist.closeCompare"(): void;
  /** Copies a comparison as a Markdown table. */
  "assist.copyComparison"(messageId: string): void;
  "assist.clear"(): void;
  "assist.jumpToSection"(index: number): void;
  "assist.openSettings"(): void;
  /** Answer the approval prompt of the active tab's running Assist agent turn. */
  "assist.approve"(decision: AgentApprovalDecision): void;
  /** Bring a tab of this window to the front (an Assist run there needs attention). */
  "assist.showTab"(tabId: TabId): void;
  "agents.pause"(paused: boolean): void;
  "agents.revoke"(client: string): void;
  "agents.clear"(): void;
  /** Replay a workflow in a new tab with values for its parameters (throws when some are missing). */
  "workflows.run"(id: string, params: Record<string, string>): void;
  "workflows.update"(id: string, edit: WorkflowEdit): void;
  "workflows.remove"(id: string): void;
  "workflows.saveDraft"(edit: WorkflowEdit): void;
  "workflows.discardDraft"(): void;
  "workflows.approve"(id: string, decision: FlowApprovalDecision): void;
  "workflows.stop"(id: string): void;
  "workflows.openManager"(): void;
  "memory.removeHint"(host: string, kind: MemoryHintKind, key: string): void;
  "memory.forget"(host: string): void;
  "memory.setEnabled"(on: boolean): void;
}

export interface AssistBridge {
  call<K extends keyof AssistRpc>(method: K, ...args: Parameters<AssistRpc[K]>): Promise<Awaited<ReturnType<AssistRpc[K]>>>;
  onEvent(listener: (event: AssistEventMessage) => void): () => void;
}

/** Overlay drawn above an agent-driven tab. Coordinates are in the tab view's DIPs. */
export type OverlayEvent =
  | {
      type: "act";
      caption: string;
      /** Element box (click / type), null for page-level actions. */
      target: { x: number; y: number; width: number; height: number } | null;
      kind: "click" | "type" | "navigate" | "scroll" | "read" | "screenshot";
      dark: boolean;
    }
  | { type: "hide" };

export interface OverlayBridge {
  onEvent(listener: (event: OverlayEvent) => void): () => void;
  dismiss(): void;
}

// --------------------------------------------------------------- chrome UI additions

export interface AssistWindowExtras {
  assistOpen: boolean;
  agentsPaused: boolean;
  /** An agent acted in this window within the last few seconds. */
  agentActive: boolean;
}

export type AssistChromeCommand = { type: "open-organizer" };

export interface AssistChromeRpc {
  "assist.toggle"(view?: AssistView): void;
  "organizer.propose"(): OrganizerProposal;
  "organizer.apply"(groups: GroupProposal[], closeTabIds: TabId[]): { grouped: number; closed: number };
}
