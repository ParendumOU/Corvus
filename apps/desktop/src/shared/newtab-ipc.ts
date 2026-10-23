/**
 * IPC contract of the New Tab dashboard (corvus://newtab). Every network read a widget needs
 * (prices, feeds, weather, wallpapers, an AI widget's data) happens in the main process, so the
 * page keeps its 'self'-only CSP; AI-built widgets run in a sandboxed frame that only gets data
 * from the sources it declared.
 */
import type { NewTabLayout, WallpaperSource, WidgetConfigs } from "./newtab";

export interface NewTabSite {
  url: string;
  title: string;
  faviconUrl?: string;
}

export interface NewTabView {
  layout: NewTabLayout;
  profileName: string;
  topSites: NewTabSite[];
  mcpRunning: boolean;
  canUndo: boolean;
}

export interface FeedItem {
  title: string;
  url: string;
  source: string;
  at: number | null;
}

export interface WallpaperView {
  url: string;
  credit: string;
  link: string;
}

export interface NewTabRpc {
  "newtab.view"(): NewTabView;
  /** Saves the page's layout (sanitized) and returns what was stored. */
  "newtab.save"(layout: NewTabLayout): NewTabView;
  "newtab.undo"(): NewTabView;
  "newtab.reset"(): NewTabView;
  /** Lets the person choose a background picture; returns the stored file name, or null. */
  "newtab.pickImage"(): string | null;
  "newtab.wallpaper"(source: WallpaperSource): WallpaperView | null;
  /**
   * Data for a custom widget from the sources it declared, keyed by source name; a source that
   * failed (or waits for consent) has { error }.
   */
  "newtab.customData"(widgetId: string): Record<string, unknown>;
  /** The person allows (or stops) a custom widget reading these hosts with their session. */
  "newtab.consent"(widgetId: string, hosts: string[]): NewTabView;
  /** Opens a link from a custom widget, only for hosts it declared. */
  "newtab.openFromWidget"(widgetId: string, url: string): boolean;
}

export type NewTabInternalEvent = { type: "newtab-changed" };

/** What a "page" source hands a widget. */
export interface PageSnapshot {
  url: string;
  title: string;
  /** Unread count read from the title ("(3) Home / X", "Inbox (12)"), or null. */
  count: number | null;
  /** Text of the source's CSS selector, when it has one. */
  text: string;
  checkedAt: number;
}

/** What MCP agents may change on the New Tab page (the newtab_* tools). */
export type NewTabAgentRequest =
  | { action: "get" }
  | { action: "add"; type: string; config?: Record<string, unknown>; x?: number; y?: number; w?: number; h?: number }
  | { action: "update"; id: string; config?: Record<string, unknown>; x?: number; y?: number; w?: number; h?: number }
  | { action: "remove"; id: string }
  | { action: "background"; background: Record<string, unknown> }
  | { action: "custom"; id?: string; config: Partial<WidgetConfigs["custom"]>; w?: number; h?: number }
  | { action: "undo" };
