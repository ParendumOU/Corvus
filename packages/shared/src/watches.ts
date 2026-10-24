/**
 * Watched pages. What to watch is the user's intent and syncs as `watches` (one record per URL,
 * keyed by the URL). Each computer runs its own monitor, and publishes what it last saw as
 * `watch_status` (one record per device, keyed by the device id), which the phone shows.
 */

export type WatchResult = "pending" | "ok" | "changed" | "error";

/** The part of a watch that travels through sync: which page, how often, paused, the condition. */
export interface SyncedWatch {
  url: string;
  title: string;
  faviconUrl?: string;
  intervalMinutes: number;
  paused: boolean;
  createdAt: number;
  /** "Notify me when…" is the user's intent too, so it travels with the watch. */
  condition?: string;
}

export function isSyncedWatch(value: unknown): value is SyncedWatch {
  const v = value as Partial<SyncedWatch> | null;
  return (
    typeof v?.url === "string" &&
    typeof v.title === "string" &&
    typeof v.intervalMinutes === "number" &&
    typeof v.paused === "boolean" &&
    typeof v.createdAt === "number" &&
    (v.faviconUrl === undefined || typeof v.faviconUrl === "string") &&
    (v.condition === undefined || typeof v.condition === "string")
  );
}

/** What one computer last saw of one watched page. */
export interface WatchStatus {
  url: string;
  lastCheckedAt: number | null;
  lastChangedAt: number | null;
  result: WatchResult;
  /** Short AI summary of the most recent change. */
  summary: string;
  /** Whether the "Notify me when…" condition held at the last check (null: not known yet). */
  conditionMet?: boolean | null;
  /** What on the page decided it ("Price: 139 €"), or why it could not be checked. */
  conditionDetail?: string;
  error?: string;
}

export interface DeviceWatchStatus {
  device: string;
  platform: string;
  /** When this status last changed (not when it was last published). */
  updatedAt: number;
  watches: WatchStatus[];
}

export const MAX_WATCH_STATUS = 500;
const RESULTS: readonly string[] = ["pending", "ok", "changed", "error"];

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const time = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const text = (v: unknown, max: number): string => (typeof v === "string" ? v.slice(0, max) : "");

/** Validate a status record received from another device; invalid entries are dropped. */
export function parseDeviceWatchStatus(raw: unknown): DeviceWatchStatus | null {
  if (!isObject(raw) || typeof raw.device !== "string" || typeof raw.updatedAt !== "number" || !Array.isArray(raw.watches)) return null;
  const watches: WatchStatus[] = [];
  for (const w of raw.watches.slice(0, MAX_WATCH_STATUS)) {
    if (!isObject(w) || typeof w.url !== "string" || !/^https?:\/\//i.test(w.url)) continue;
    const met = w.conditionMet;
    watches.push({
      url: w.url,
      lastCheckedAt: time(w.lastCheckedAt),
      lastChangedAt: time(w.lastChangedAt),
      result: RESULTS.includes(w.result as string) ? (w.result as WatchResult) : "pending",
      summary: text(w.summary, 600),
      ...(met === true || met === false || met === null ? { conditionMet: met } : {}),
      ...(typeof w.conditionDetail === "string" && w.conditionDetail ? { conditionDetail: text(w.conditionDetail, 300) } : {}),
      ...(typeof w.error === "string" && w.error ? { error: text(w.error, 300) } : {}),
    });
  }
  return { device: raw.device.slice(0, 64), platform: text(raw.platform, 32), updatedAt: raw.updatedAt, watches };
}
