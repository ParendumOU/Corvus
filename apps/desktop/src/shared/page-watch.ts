/**
 * Page-change monitoring ("Watch this page"): the durable watch model, text normalization and
 * change detection, the watchable-URL guard (mirrors ai-engine deep mode's public-URL check) and
 * the scheduler that decides which watches are due while honouring the interval and a concurrency
 * cap. Pure (no node/Electron imports) so it is unit tested and safe for both tsconfig projects.
 */
import type { SyncedWatch, WatchResult, WatchStatus } from "@corvus/shared";

export type { WatchResult } from "@corvus/shared";

export interface Watch {
  id: string;
  url: string;
  title: string;
  faviconUrl?: string;
  /** Re-check cadence in minutes (>= MIN_INTERVAL_MINUTES). */
  intervalMinutes: number;
  createdAt: number;
  paused: boolean;
  lastCheckedAt: number | null;
  lastChangedAt: number | null;
  lastResult: WatchResult;
  lastError?: string;
  /** Fingerprint of the last successfully fetched, normalized content (null before first fetch). */
  fingerprint: string | null;
  /** Capped normalized text kept to diff the next fetch and feed the AI summary. */
  baseline: string;
  /** Short AI summary of the most recent detected change, in the user's language. */
  changeSummary: string;
  /** True when a change was detected that the user has not acknowledged yet (drives the badge). */
  unseen: boolean;
  /**
   * "Notify me when…", in the user's words ("the price is under 150 €"): the AI checks it whenever
   * the page changes, and only its becoming true notifies. None = notify on every change.
   */
  condition?: string;
  /** Whether the condition held at the last check (null/absent = not known yet). */
  conditionMet?: boolean | null;
  /** What on the page decided it ("Price: 139 €"), or why it could not be checked. */
  conditionDetail?: string;
}

export const MIN_INTERVAL_MINUTES = 5;
export const CONDITION_CHARS = 300;

/** A condition as stored: whitespace collapsed and capped; "" means none. */
export function cleanCondition(raw: unknown): string {
  return typeof raw === "string" ? raw.replace(/\s+/g, " ").trim().slice(0, CONDITION_CHARS) : "";
}

/** A condition notifies when it becomes true, not again while it stays true. */
export function conditionNotifies(previous: boolean | null | undefined, met: boolean): boolean {
  return met && previous !== true;
}
export const BASELINE_CHARS = 8000;
export const SUMMARY_CHARS = 280;
export const DEFAULT_MAX_CONCURRENT = 3;

export function clampInterval(minutes: number, min: number = MIN_INTERVAL_MINUTES): number {
  if (!Number.isFinite(minutes)) return min;
  return Math.max(min, Math.min(10080, Math.round(minutes)));
}

/**
 * The part of a watch that travels through sync: the user's intent (which page, how often, paused).
 * Per-device monitoring state (fingerprint, baseline, last result, unseen badge) stays on each device
 * because every device runs its own monitor; syncing it would churn constantly and never converge.
 * Watches are keyed by URL across devices, like history.
 */
export { isSyncedWatch, type SyncedWatch } from "@corvus/shared";

export function toSyncedWatch(w: Watch): SyncedWatch {
  return {
    url: w.url,
    title: w.title,
    ...(w.faviconUrl ? { faviconUrl: w.faviconUrl } : {}),
    intervalMinutes: w.intervalMinutes,
    paused: w.paused,
    createdAt: w.createdAt,
    ...(w.condition ? { condition: w.condition } : {}),
  };
}

/** What this device last saw of a watch, published for the phone (sync collection `watch_status`). */
export function toWatchStatus(w: Watch): WatchStatus {
  return {
    url: w.url,
    lastCheckedAt: w.lastCheckedAt,
    lastChangedAt: w.lastChangedAt,
    result: w.lastResult,
    summary: w.changeSummary,
    ...(w.condition ? { conditionMet: w.conditionMet ?? null } : {}),
    ...(w.condition && w.conditionDetail ? { conditionDetail: w.conditionDetail } : {}),
    ...(w.lastError ? { error: w.lastError } : {}),
  };
}

// --------------------------------------------------------------- watchable URL guard (SSRF)

function isPrivateIPv4Literal(host: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

/** Dotted-decimal IPv4 embedded in an IPv4-mapped IPv6 literal (dotted or hex-compressed), if any. */
function mappedIPv4(host: string): string | null {
  const m = /^::ffff:(.+)$/.exec(host);
  if (!m?.[1]) return null;
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(m[1])) return m[1];
  const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(m[1]);
  if (!hex) return null;
  const hi = parseInt(hex[1]!, 16);
  const lo = parseInt(hex[2]!, 16);
  return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
}

/**
 * Whether a URL may be watched: http(s) only, and never a loopback/private/link-local literal or a
 * `.local`/`.internal`/`.localhost` name. Hostnames that resolve to a private address are rejected
 * at fetch time by the main-process monitor (DNS check), the same way ai-engine deep mode does.
 */
export function isWatchableUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "" || host === "localhost") return false;
  if (host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return false;
  if (isPrivateIPv4Literal(host)) return false;
  // IPv6 loopback / unique-local / link-local literals.
  if (host.includes(":")) {
    if (host === "::1" || host === "::" || /^f[cd]/.test(host) || /^fe[89ab]/.test(host) || /^ff/.test(host)) return false;
    const mapped = mappedIPv4(host);
    if (mapped && isPrivateIPv4Literal(mapped)) return false;
  }
  return true;
}

// --------------------------------------------------------------- normalization + diff

const VOLATILE_PATTERNS: RegExp[] = [
  /\b\d{4}-\d{2}-\d{2}t\d{2}:\d{2}(:\d{2})?(\.\d+)?(z|[+-]\d{2}:?\d{2})?\b/g, // ISO timestamps
  /\b\d{1,2}:\d{2}(:\d{2})?\s?(am|pm)?\b/g, // clock times
  /\b\d+\s+(second|minute|hour|day|week|month|year)s?\s+ago\b/g, // relative times
  /\bupdated?\s+(just now|today|yesterday)\b/g,
];

/**
 * Normalize extracted main text for stable comparison: lower-case, strip volatile time strings,
 * collapse whitespace per line and drop blank lines. Reordering-insensitive comparison is left to
 * the diff; this only removes noise that would otherwise flag a change on every poll.
 */
export function normalizeWatchText(raw: string): string {
  let text = raw.toLowerCase().replace(/ /g, " ");
  for (const re of VOLATILE_PATTERNS) text = text.replace(re, " ");
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line.length > 0)
    .join("\n");
}

/** cyrb53 string hash (pure, deterministic) rendered as hex. Good enough to detect content changes. */
export function fingerprint(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const n = 4294967296 * (2097151 & h2) + (h1 >>> 0);
  return n.toString(16).padStart(14, "0");
}

export interface WatchDiff {
  changed: boolean;
  added: string[];
  removed: string[];
}

const MAX_DIFF_LINES = 40;

/**
 * Line-level diff of two already-normalized texts. `changed` is true only when a non-empty line was
 * added or removed, so identical content (or a pure reprint) never counts as a change.
 */
export function diffNormalized(oldText: string, newText: string): WatchDiff {
  if (oldText === newText) return { changed: false, added: [], removed: [] };
  const oldLines = oldText ? oldText.split("\n") : [];
  const newLines = newText ? newText.split("\n") : [];
  const oldCount = countLines(oldLines);
  const newCount = countLines(newLines);
  const added: string[] = [];
  const removed: string[] = [];
  for (const [line, n] of newCount) {
    const extra = n - (oldCount.get(line) ?? 0);
    for (let i = 0; i < extra && added.length < MAX_DIFF_LINES; i++) added.push(line);
  }
  for (const [line, n] of oldCount) {
    const gone = n - (newCount.get(line) ?? 0);
    for (let i = 0; i < gone && removed.length < MAX_DIFF_LINES; i++) removed.push(line);
  }
  return { changed: added.length > 0 || removed.length > 0, added, removed };
}

function countLines(lines: string[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const line of lines) map.set(line, (map.get(line) ?? 0) + 1);
  return map;
}

/** Compact the diff into a token-cheap prompt body for the AI change summary. */
export function diffForPrompt(diff: WatchDiff, maxChars = 2000): string {
  const lines: string[] = [];
  for (const a of diff.added) lines.push(`+ ${a}`);
  for (const r of diff.removed) lines.push(`- ${r}`);
  let out = "";
  for (const line of lines) {
    if (out.length + line.length + 1 > maxChars) break;
    out += (out ? "\n" : "") + line;
  }
  return out;
}

// --------------------------------------------------------------- scheduling

export interface ScheduleOptions {
  now: number;
  /** Ids currently being fetched (not eligible again). */
  running: ReadonlySet<string>;
  maxConcurrent?: number;
}

/** Whether a single watch is due for a re-check right now. */
export function isDue(watch: Watch, now: number): boolean {
  if (watch.paused) return false;
  if (watch.lastCheckedAt === null) return true;
  return now - watch.lastCheckedAt >= watch.intervalMinutes * 60_000;
}

/**
 * Pick the watches to start now: those that are due and not already running, oldest-checked first,
 * limited so that `running.size + picked.length <= maxConcurrent`.
 */
export function selectDue(watches: readonly Watch[], opts: ScheduleOptions): Watch[] {
  const max = opts.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
  const free = Math.max(0, max - opts.running.size);
  if (free === 0) return [];
  return watches
    .filter((w) => !opts.running.has(w.id) && isDue(w, opts.now))
    .sort((a, b) => (a.lastCheckedAt ?? 0) - (b.lastCheckedAt ?? 0))
    .slice(0, free);
}
