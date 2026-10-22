/**
 * Site memory across devices: the `site_memory` sync collection. Pure (no Node/Electron) and unit
 * tested; the store (main/site-memory-store.ts) only feeds it local state and keeps its results.
 *
 * RECORDS: one per host (record id = host) plus one `*` record for "Forget everything". A host
 * record carries the hint items, each with per-device counters (replica id -> [ok, fail, last
 * success]), per-device run counters (replica id -> [runs, fails, first seen, last seen]) and the
 * tombstones: `removed` (hint key -> when that hint was forgotten) and `clearedAt` ("Forget this
 * site"). The `*` record carries `wipedAt`.
 *
 * MERGE (idempotent and commutative; associative up to the caps, see the tests):
 * - tombstones merge by maximum;
 * - every per-device slot at or before the tombstone that covers it (the wipe, the site clear or
 *   the hint removal) is dropped from both sides BEFORE merging, so a stale device that syncs old
 *   data back cannot undo a forget;
 * - per-device slots are united by replica id; for the same replica the newest slot wins (a device
 *   only ever advances its own counters), so receiving the same data again never counts twice;
 * - totals are sums over devices, `last` is the newest, then the local decay rules and caps run
 *   (tidyEntry: failing targets, 180-day expiry, list caps, 2 KB per host) in a fixed order, so
 *   every device keeps the same items. The 200-host LRU is applied by the store.
 *
 * PRIVACY: items are re-checked going out and coming in. Only what local learning may keep can be
 * in a record: safe roles, short non-personal names, no secret / one-time code / card fields, no
 * typed-into fields that look like credentials (user name, e-mail, login, phone, codes: whatever
 * tool typed into them, fill_login and fill_totp included), URL shapes without values. Typed values
 * are never part of site memory at all.
 */
import {
  INTENTS,
  MAX_ITEM_AGE_MS,
  SAFE_ROLES,
  SENSITIVE_FIELD,
  hintKey,
  safeName,
  settleHost,
  settleItem,
  tidyEntry,
  urlPattern,
  type HostCounts,
  type ItemCounts,
  type MemoryHintKind,
  type MemoryIntent,
  type MemoryObstacle,
  type MemorySequence,
  type MemoryTarget,
  type MemoryUrl,
  type SiteMemoryEntry,
} from "./site-memory";
import { REPLICA_RE, reviveSlots } from "./site-memory";

/** Record id of the "Forget everything" marker (never a valid host). */
export const WIPE_RECORD_ID = "*";
/**
 * How long tombstones are kept. Anything a stale device could bring back from before a tombstone
 * this old has expired under the decay rules anyway (MAX_ITEM_AGE_MS).
 */
export const MARKER_TTL_MS = MAX_ITEM_AGE_MS;

type Slots<T> = Record<string, T>;

export interface SyncedTarget {
  intent: MemoryIntent;
  act: "click" | "type";
  role: string;
  name: string;
  by: Slots<ItemCounts>;
}
export interface SyncedUrl {
  label: string;
  pattern: string;
  by: Slots<ItemCounts>;
}
export interface SyncedObstacle {
  kind: string;
  how: string;
  by: Slots<ItemCounts>;
}
export interface SyncedSequence {
  steps: MemoryIntent[];
  by: Slots<ItemCounts>;
}

export interface SyncedSiteMemory {
  v: 1;
  host: string;
  /** Per-device run counters: replica id -> [runs, fails, first seen, last seen]. */
  runs: Slots<HostCounts>;
  targets: SyncedTarget[];
  urls: SyncedUrl[];
  obstacles: SyncedObstacle[];
  sequences: SyncedSequence[];
  /** "Forget this hint": `kind:key` -> when. */
  removed: Record<string, number>;
  /** "Forget this site": everything learned up to this moment is gone. 0 = never. */
  clearedAt: number;
}

export interface SiteMemoryWipe {
  v: 1;
  /** "Forget everything": everything learned up to this moment is gone on every device. */
  wipedAt: number;
}

/** Tombstones kept locally for one host. */
export interface HostMarkers {
  clearedAt: number;
  removed: Record<string, number>;
}

export const NO_MARKERS: HostMarkers = { clearedAt: 0, removed: {} };

export interface MergeContext {
  now: number;
  /** The newest "Forget everything" this device knows. */
  wipedAt: number;
}

/** Key of a hint in `removed`: the kind plus the hint key the UI already uses. */
export function removalKey(kind: MemoryHintKind, key: string): string {
  return `${kind}:${key}`;
}

// ------------------------------------------------------------------ privacy

/** Names of fields that hold credentials or codes: never remembered as a typed-into target. */
const CREDENTIAL_FIELD =
  /\b(user ?names?|usernames?|user ?ids?|logins?|log ?in|sign ?in|e-?mails?|email address|correo|usuario|accounts?|account (number|name|id)|phone|mobile|tel[eé]fono|codes?|c[oó]digo|member(ship)? (id|number)|customer (id|number))\b/i;

/** Labels local learning gives URL shapes. */
const URL_LABELS = new Set(["opened", "search results", "next page", "after add to cart", "after sign-in", "checkout", "after submit"]);
const OBSTACLE_KINDS = new Set(["cookie banner", "popup"]);
const OBSTACLE_HOW = /^click ([a-z]+) "(.+)"$/;

/** Whether a target may travel: the local learning filters, plus no credential-like typed fields. */
export function syncSafeTarget(t: { intent: string; act: string; role: string; name: string }): boolean {
  if (!INTENTS.includes(t.intent as MemoryIntent) || (t.act !== "click" && t.act !== "type") || !SAFE_ROLES.has(t.role)) return false;
  if (safeName(t.name) !== t.name || SENSITIVE_FIELD.test(t.name)) return false;
  return t.act !== "type" || !CREDENTIAL_FIELD.test(t.name);
}

/** A URL shape is safe when re-deriving it changes nothing (no values, no sensitive keys). */
export function syncSafeUrl(u: { label: string; pattern: string }): boolean {
  return URL_LABELS.has(u.label) && u.pattern.startsWith("/") && u.pattern.length <= 200 && urlPattern(`https://host.invalid${u.pattern}`) === u.pattern;
}

export function syncSafeObstacle(o: { kind: string; how: string }): boolean {
  const m = OBSTACLE_HOW.exec(o.how);
  return OBSTACLE_KINDS.has(o.kind) && !!m && syncSafeTarget({ intent: "other", act: "click", role: m[1]!, name: m[2]! });
}

function syncSafeSequence(q: { steps: readonly string[] }): boolean {
  return q.steps.length >= 2 && q.steps.length <= 12 && q.steps.every((i) => INTENTS.includes(i as MemoryIntent));
}

// ------------------------------------------------------------------ slots

/** The newer of two slots of the same device: newest `last`, then the larger counts. */
function newer<T extends number[]>(a: T, b: T, lastAt: number): T {
  if (a[lastAt]! !== b[lastAt]!) return a[lastAt]! > b[lastAt]! ? a : b;
  for (let i = 0; i < a.length; i++) if (a[i]! !== b[i]!) return a[i]! > b[i]! ? a : b;
  return a;
}

function floorSlots<T extends number[]>(slots: Slots<T> | undefined, floor: number, lastAt: number): Slots<T> {
  const out: Slots<T> = {};
  for (const [replica, counts] of Object.entries(slots ?? {})) if (counts[lastAt]! > floor) out[replica] = [...counts] as T;
  return out;
}

function uniteSlots<T extends number[]>(a: Slots<T>, b: Slots<T>, lastAt: number): Slots<T> {
  const out: Slots<T> = { ...a };
  for (const [replica, counts] of Object.entries(b)) out[replica] = out[replica] ? newer(out[replica]!, counts, lastAt) : counts;
  return out;
}

const ITEM_LAST = 2;
const HOST_LAST = 3;

// ------------------------------------------------------------------ conversion

const sortBy = <T>(list: T[], key: (item: T) => string): T[] => [...list].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));

/** A record with no knowledge in it: only its tombstones (canonical form). */
export function markerRecord(host: string, markers: HostMarkers): SyncedSiteMemory {
  return { v: 1, host, runs: {}, targets: [], urls: [], obstacles: [], sequences: [], removed: { ...markers.removed }, clearedAt: markers.clearedAt };
}

/**
 * This device's entry (and its tombstones) as a record. Counts from before per-device counters
 * existed are this device's own. The result is canonical (merged with nothing).
 */
export function toSyncedSiteMemory(entry: SiteMemoryEntry | undefined, host: string, markers: HostMarkers, replica: string, ctx: MergeContext): SyncedSiteMemory {
  if (!entry) return mergeSiteMemory(markerRecord(host, markers), null, ctx);
  const slots = (i: { ok: number; fail?: number; last: number; by?: Slots<ItemCounts> }): Slots<ItemCounts> =>
    i.by ? i.by : { [replica]: [i.ok, i.fail ?? 0, i.last] };
  const raw: SyncedSiteMemory = {
    v: 1,
    host,
    runs: entry.by ?? (entry.runs + entry.fails > 0 ? { [replica]: [entry.runs, entry.fails, entry.firstSeen, entry.lastSeen] } : {}),
    targets: entry.targets.map((t) => ({ intent: t.intent, act: t.act, role: t.role, name: t.name, by: slots(t) })),
    urls: entry.urls.map((u) => ({ label: u.label, pattern: u.pattern, by: slots(u) })),
    obstacles: entry.obstacles.map((o) => ({ kind: o.kind, how: o.how, by: slots(o) })),
    sequences: entry.sequences.map((q) => ({ steps: [...q.steps], by: slots(q) })),
    removed: { ...markers.removed },
    clearedAt: markers.clearedAt,
  };
  return mergeSiteMemory(raw, null, ctx);
}

/** The entry a record holds (null when it holds no hints, only tombstones). */
export function entryFromSynced(record: SyncedSiteMemory): SiteMemoryEntry | null {
  if (record.targets.length + record.urls.length + record.obstacles.length + record.sequences.length === 0) return null;
  const item = <T extends { by: Slots<ItemCounts> }>(i: T) => {
    const out = { ...i, by: { ...i.by }, ok: 0, fail: 0, last: 0 };
    settleItem(out);
    return out;
  };
  const e: SiteMemoryEntry = {
    host: record.host,
    runs: 0,
    fails: 0,
    firstSeen: 0,
    lastSeen: 0,
    targets: record.targets.map((t) => item(t) as MemoryTarget),
    urls: record.urls.map((u) => {
      const { fail: _fail, ...rest } = item(u);
      return rest as MemoryUrl;
    }),
    obstacles: record.obstacles.map((o) => {
      const { fail: _fail, ...rest } = item(o);
      return rest as MemoryObstacle;
    }),
    sequences: record.sequences.map((q) => {
      const { fail: _fail, ...rest } = item(q);
      return { ...rest, steps: [...q.steps] } as MemorySequence;
    }),
    by: { ...record.runs },
  };
  settleHost(e);
  const lastItem = Math.max(0, ...[...e.targets, ...e.urls, ...e.obstacles, ...e.sequences].map((i) => i.last));
  if (Object.keys(record.runs).length === 0) {
    delete e.by;
    e.firstSeen = lastItem;
    e.lastSeen = lastItem;
  }
  return e;
}

// ------------------------------------------------------------------ merge

/**
 * Merge two records of the same host (b may be null: canonicalize a alone). See the module
 * comment for the rules. A result without hints is a pure tombstone record.
 */
export function mergeSiteMemory(a: SyncedSiteMemory, b: SyncedSiteMemory | null, ctx: MergeContext): SyncedSiteMemory {
  const host = a.host;
  const clearedAt = Math.max(a.clearedAt, b?.clearedAt ?? 0);
  const hostFloor = Math.max(clearedAt, ctx.wipedAt);
  const removed: Record<string, number> = {};
  for (const src of [a.removed, b?.removed ?? {}]) {
    for (const [key, at] of Object.entries(src)) if (at > hostFloor && at > (removed[key] ?? 0)) removed[key] = at;
  }
  const floorOf = (kind: MemoryHintKind, key: string): number => Math.max(hostFloor, removed[removalKey(kind, key)] ?? 0);

  const unite = <T extends { by: Slots<ItemCounts> }>(kind: MemoryHintKind, keyOf: (i: T) => string, safe: (i: T) => boolean, x: T[], y: T[]): T[] => {
    const out = new Map<string, T>();
    for (const item of [...x, ...y]) {
      if (!safe(item)) continue;
      const key = keyOf(item);
      const floor = floorOf(kind, key);
      const by = floorSlots(item.by, floor, ITEM_LAST);
      const prev = out.get(key);
      out.set(key, { ...item, by: prev ? uniteSlots(prev.by, by, ITEM_LAST) : by });
    }
    return [...out.values()].filter((i) => Object.keys(i.by).length > 0);
  };
  const targetKey = (t: SyncedTarget) => hintKey("target", t as unknown as MemoryTarget);
  const urlKey = (u: SyncedUrl) => hintKey("url", u as unknown as MemoryUrl);
  const obstacleKey = (o: SyncedObstacle) => hintKey("obstacle", o as unknown as MemoryObstacle);
  const sequenceKey = (q: SyncedSequence) => hintKey("sequence", q as unknown as MemorySequence);

  const merged: SyncedSiteMemory = {
    v: 1,
    host,
    runs: uniteSlots(floorSlots(a.runs, hostFloor, HOST_LAST), floorSlots(b?.runs, hostFloor, HOST_LAST), HOST_LAST),
    targets: unite("target", targetKey, syncSafeTarget, a.targets, b?.targets ?? []),
    urls: unite("url", urlKey, syncSafeUrl, a.urls, b?.urls ?? []),
    obstacles: unite("obstacle", obstacleKey, syncSafeObstacle, a.obstacles, b?.obstacles ?? []),
    sequences: unite("sequence", sequenceKey, syncSafeSequence, a.sequences, b?.sequences ?? []),
    removed,
    clearedAt,
  };

  // The decay rules and caps run on the merged knowledge, exactly as after local learning.
  const entry = entryFromSynced(merged);
  const kept = entry ? tidyEntry(entry, ctx.now) : null;
  if (!kept || kept.targets.length + kept.urls.length + kept.obstacles.length + kept.sequences.length === 0) {
    return markerRecord(host, { clearedAt, removed });
  }
  const by = <T extends { by?: Slots<ItemCounts> }>(i: T): Slots<ItemCounts> => i.by ?? {};
  return {
    ...merged,
    targets: sortBy(
      kept.targets.map((t) => ({ intent: t.intent, act: t.act, role: t.role, name: t.name, by: by(t) })),
      targetKey,
    ),
    urls: sortBy(
      kept.urls.map((u) => ({ label: u.label, pattern: u.pattern, by: by(u) })),
      urlKey,
    ),
    obstacles: sortBy(
      kept.obstacles.map((o) => ({ kind: o.kind, how: o.how, by: by(o) })),
      obstacleKey,
    ),
    sequences: sortBy(
      kept.sequences.map((q) => ({ steps: [...q.steps], by: by(q) })),
      sequenceKey,
    ),
  };
}

export function mergeWipe(a: SiteMemoryWipe | null, b: SiteMemoryWipe | null): SiteMemoryWipe {
  return { v: 1, wipedAt: Math.max(a?.wipedAt ?? 0, b?.wipedAt ?? 0) };
}

// ------------------------------------------------------------------ parsing (incoming)

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);
const str = (v: unknown, max: number): string => (typeof v === "string" ? v.slice(0, max) : "");
const list = (v: unknown, max: number): unknown[] => (Array.isArray(v) ? v.slice(0, max) : []);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** A host as site memory keys it (lowercase, no "www.", optional port). */
export function isMemoryHost(host: string): boolean {
  return /^[a-z0-9.-]{1,253}(:\d{1,5})?$/.test(host) && !host.startsWith("www.");
}

/** Validate and privacy-filter a remote host record; null when unusable or from a newer format. */
export function parseSyncedSiteMemory(raw: unknown, host: string): SyncedSiteMemory | null {
  const r = obj(raw);
  if (r.v !== 1 || r.host !== host || !isMemoryHost(host)) return null;
  const by = (v: unknown): Slots<ItemCounts> => reviveSlots<ItemCounts>(v, 3) ?? {};
  const removed: Record<string, number> = {};
  for (const [key, at] of Object.entries(obj(r.removed)).slice(0, 512)) {
    if (/^(target|url|obstacle|sequence):/.test(key) && key.length <= 300 && num(at) > 0) removed[key] = num(at);
  }
  const record: SyncedSiteMemory = {
    v: 1,
    host,
    runs: reviveSlots<HostCounts>(r.runs, 4) ?? {},
    targets: list(r.targets, 64).flatMap((x) => {
      const t = obj(x);
      const target = { intent: str(t.intent, 20) as MemoryIntent, act: t.act as "click" | "type", role: str(t.role, 40), name: str(t.name, 80), by: by(t.by) };
      return syncSafeTarget(target) ? [target] : [];
    }),
    urls: list(r.urls, 64).flatMap((x) => {
      const u = obj(x);
      const url = { label: str(u.label, 40), pattern: str(u.pattern, 200), by: by(u.by) };
      return syncSafeUrl(url) ? [url] : [];
    }),
    obstacles: list(r.obstacles, 32).flatMap((x) => {
      const o = obj(x);
      const obstacle = { kind: str(o.kind, 40), how: str(o.how, 120), by: by(o.by) };
      return syncSafeObstacle(obstacle) ? [obstacle] : [];
    }),
    sequences: list(r.sequences, 16).flatMap((x) => {
      const q = obj(x);
      const steps = list(q.steps, 12).filter((i): i is MemoryIntent => INTENTS.includes(i as MemoryIntent));
      return steps.length >= 2 ? [{ steps, by: by(q.by) }] : [];
    }),
    removed,
    clearedAt: num(r.clearedAt),
  };
  return record;
}

export function parseSiteMemoryWipe(raw: unknown): SiteMemoryWipe | null {
  const r = obj(raw);
  return r.v === 1 && num(r.wipedAt) > 0 ? { v: 1, wipedAt: num(r.wipedAt) } : null;
}

export { REPLICA_RE };
