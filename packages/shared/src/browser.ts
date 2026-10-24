/**
 * Browser domain model and the BrowserController contract.
 *
 * The desktop app (apps/desktop) implements BrowserController.
 * The MCP server (packages/mcp-server) consumes it to expose the browser to AI agents.
 */
import type { AgentCapabilities, ChallengeInfo, DialogInfo, SnapshotElement, SnapshotOptions, Viewport } from "./agent.js";

export type TabId = string;
export type GroupId = string;
export type ProfileId = string;

export type GroupColor = "grey" | "blue" | "red" | "yellow" | "green" | "pink" | "purple" | "cyan" | "orange";

export const GROUP_COLORS: readonly GroupColor[] = ["grey", "blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange"];

export interface Tab {
  id: TabId;
  windowId: string;
  url: string;
  title: string;
  faviconUrl?: string;
  groupId?: GroupId;
  pinned: boolean;
  active: boolean;
  loading: boolean;
  /** True when the tab was opened/driven by an MCP client. Shown in the UI with an AI badge. */
  agentControlled: boolean;
}

export interface TabGroup {
  id: GroupId;
  title: string;
  color: GroupColor;
  collapsed: boolean;
  /** Saved workspace this group was opened from or saved as (desktop workspaces). */
  workspaceId?: string;
}

export interface Profile {
  id: ProfileId;
  name: string;
  avatar?: string;
  /** Linked account (e.g. sync chain). Undefined if the profile is local-only. */
  syncChainId?: string;
}

export interface Bookmark {
  id: string;
  parentId: string | null; // null = root
  kind: "folder" | "bookmark";
  title: string;
  url?: string; // only for kind === "bookmark"
  position: number;
  createdAt: number;
  updatedAt: number;
}

export interface HistoryEntry {
  id: string;
  url: string;
  title: string;
  visitedAt: number;
  visitCount: number;
}

/** Compact, token-friendly snapshot of a page for AI consumption. */
export interface PageSnapshot {
  tabId: TabId;
  url: string;
  title: string;
  /** Readability-extracted main text, truncated to maxChars. */
  text: string;
  /** Interactive elements with stable refs usable by click/type. */
  elements: SnapshotElement[];
  truncated: boolean;
  viewport?: Viewport;
  /**
   * Human-verification challenge detected on the page. The agent solves it with the normal tools and
   * calls ask_user only if it cannot (see challengeGuidance in @corvus/shared).
   */
  challenge?: ChallengeInfo;
  /** An open JavaScript dialog blocks the page until handled. */
  dialog?: DialogInfo;
}

export interface BrowserController extends AgentCapabilities {
  listTabs(): Promise<Tab[]>;
  listGroups(): Promise<TabGroup[]>;
  openTab(url: string, opts?: { background?: boolean; groupId?: GroupId; agent?: boolean }): Promise<Tab>;
  closeTab(id: TabId): Promise<void>;
  activateTab(id: TabId): Promise<void>;
  navigate(id: TabId, url: string): Promise<Tab>;
  goBack(id: TabId): Promise<void>;
  goForward(id: TabId): Promise<void>;
  reload(id: TabId): Promise<void>;
  createGroup(tabIds: TabId[], opts?: { title?: string; color?: GroupColor }): Promise<TabGroup>;
  ungroup(tabIds: TabId[]): Promise<void>;
  snapshot(id: TabId, opts?: SnapshotOptions): Promise<PageSnapshot>;
  click(id: TabId, ref: string): Promise<void>;
  type(id: TabId, ref: string, text: string, opts?: { submit?: boolean }): Promise<void>;
  scroll(id: TabId, direction: "up" | "down", amount?: number): Promise<void>;
  screenshot(id: TabId): Promise<{ mimeType: "image/png"; base64: string }>;
  evaluate?(id: TabId, expression: string, opts?: { world?: "main" | "isolated"; timeoutMs?: number }): Promise<unknown>; // Full access only
  listBookmarks(): Promise<Bookmark[]>;
  addBookmark(b: Pick<Bookmark, "title" | "url" | "parentId">): Promise<Bookmark>;
  searchHistory(query: string, limit?: number): Promise<HistoryEntry[]>;
}
