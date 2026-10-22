/**
 * IPC contracts for Corvus Assist (side panel), the AI tab organizer and the agent activity
 * overlay. The panel and the overlay are their own WebContentsViews in the default session; they
 * are never tabs, so neither web pages, extensions nor MCP agents can read or script them.
 */
import type { TabId } from "@corvus/shared";
import type { AgentCall, AgentClient } from "./agent-activity";
import type { GroupProposal, OrganizerProposal } from "./tab-organizer";

export const ASSIST_RPC = "corvus:assist-rpc";
export const ASSIST_EVENT = "corvus:assist-event";
export const OVERLAY_EVENT = "corvus:overlay-event";
export const OVERLAY_DISMISS = "corvus:overlay-dismiss";

export const ASSIST_MIN_WIDTH = 320;
export const ASSIST_MAX_WIDTH = 640;
export const ASSIST_DEFAULT_WIDTH = 380;

export type AssistActionKind = "summarize" | "ask" | "explain" | "translate-selection" | "translate-page";

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
  readingMinutes?: number;
  /** Page translation: how many passages were translated. */
  translated?: number;
  /** Page translation: more passages are left after this batch. */
  more?: boolean;
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
}

export interface AgentActivityView {
  paused: boolean;
  calls: AgentCall[];
  clients: AgentClient[];
  mcpRunning: boolean;
}

export type AssistView = "assist" | "agents";

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
  /** Bumped when the input should take focus (shortcut, context menu). */
  focusToken: number;
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
  "assist.clear"(): void;
  "assist.jumpToSection"(index: number): void;
  "assist.openSettings"(): void;
  "agents.pause"(paused: boolean): void;
  "agents.revoke"(client: string): void;
  "agents.clear"(): void;
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
