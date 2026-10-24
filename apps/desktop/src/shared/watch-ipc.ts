/**
 * IPC contract for page-change monitoring. The corvus://watches manager talks InternalRpc; the
 * chrome UI uses the ChromeRpc fragment to start watching the active tab and to show the badge.
 * Merged into InternalRpc / ChromeRpc / WindowState in ./ipc.ts.
 */
import type { WatchResult } from "./page-watch";

export interface WatchView {
  id: string;
  url: string;
  title: string;
  faviconUrl?: string;
  intervalMinutes: number;
  paused: boolean;
  /** A fetch is in flight right now. */
  checking: boolean;
  lastCheckedAt: number | null;
  lastChangedAt: number | null;
  lastResult: WatchResult;
  lastError?: string;
  /** Short AI summary of the most recent change, in the user's language. */
  changeSummary: string;
  /** A change the user has not opened yet (drives the badge). */
  unseen: boolean;
  /** "Notify me when…" in the user's words; none = every change notifies. */
  condition?: string;
  /** Whether it held at the last check (absent = not known yet). */
  conditionMet?: boolean;
  /** What on the page decided it, or why it could not be checked. */
  conditionDetail?: string;
}

/** Badge state pushed to the chrome UI for the active window's profile. */
export interface WatchBarState {
  total: number;
  /** Watches with an unacknowledged change. */
  unseen: number;
  /** Monitoring is enabled in settings. */
  enabled: boolean;
}

export interface WatchInternalRpc {
  "watch.list"(): WatchView[];
  "watch.add"(url: string, intervalMinutes?: number, condition?: string): WatchView[];
  /** Sets or clears ("") a watch's "Notify me when…" condition, then checks the page. */
  "watch.setCondition"(id: string, condition: string): WatchView[];
  "watch.remove"(id: string): WatchView[];
  "watch.pause"(id: string, paused: boolean): WatchView[];
  "watch.setInterval"(id: string, intervalMinutes: number): WatchView[];
  "watch.checkNow"(id: string): WatchView[];
  "watch.open"(id: string, where: "current" | "new-tab"): void;
  /** Clear the unseen flag for one watch, or all when id is omitted. */
  "watch.acknowledge"(id?: string): WatchView[];
}

export interface WatchChromeRpc {
  /** Start watching the active tab (default interval); opens corvus://watches. */
  "watch.addActive"(): void;
}

export type WatchInternalEvent = { type: "watches-changed" };
