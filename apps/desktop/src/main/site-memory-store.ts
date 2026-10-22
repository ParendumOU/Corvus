import path from "node:path";
import {
  MAX_HOSTS,
  evictHosts,
  extractLessons,
  hintCount,
  hintKey,
  mergeLessons,
  noteTargetFailure,
  removeHint,
  reviveEntry,
  type MemoryHintKind,
  type SiteMemoryEntry,
  type TrailEvent,
} from "../shared/site-memory";
import {
  MARKER_TTL_MS,
  WIPE_RECORD_ID,
  entryFromSynced,
  isMemoryHost,
  mergeSiteMemory,
  removalKey,
  toSyncedSiteMemory,
  type HostMarkers,
  type MergeContext,
  type SiteMemoryWipe,
  type SyncedSiteMemory,
} from "../shared/site-memory-sync";
import { JsonFile } from "./json-file";
import { replicaId } from "./replica-id";

type Listener = () => void;

function revive(raw: unknown): SiteMemoryEntry[] {
  if (!Array.isArray(raw)) return [];
  const now = Date.now();
  const seen = new Set<string>();
  const out: SiteMemoryEntry[] = [];
  for (const r of raw) {
    const e = reviveEntry(r, now);
    if (!e || seen.has(e.host)) continue;
    seen.add(e.host);
    out.push(e);
  }
  return evictHosts(out, MAX_HOSTS);
}

/**
 * Tombstones of forgets, so they reach the other devices and beat stale copies there
 * (`site-memory-sync.json`): "Forget everything" (wipedAt), "Forget this site" (cleared) and
 * "Forget this hint" (removed). Expire after MARKER_TTL_MS, when what they cover has expired anyway.
 */
interface MemoryMarkers {
  wipedAt: number;
  cleared: Record<string, number>;
  removed: Record<string, Record<string, number>>;
}

const emptyMarkers = (): MemoryMarkers => ({ wipedAt: 0, cleared: {}, removed: {} });

function pruneMarkers(m: MemoryMarkers, now: number): MemoryMarkers {
  const cutoff = now - MARKER_TTL_MS;
  const live = (at: unknown): at is number => typeof at === "number" && Number.isFinite(at) && at > cutoff;
  // A site cleared by "Forget everything" keeps its marker (at the wipe time) so its server copy is
  // overwritten; an older one is covered by the wipe.
  const cleared: Record<string, number> = {};
  for (const [host, at] of Object.entries(m.cleared ?? {})) if (live(at) && at >= m.wipedAt) cleared[host] = at;
  const removed: Record<string, Record<string, number>> = {};
  for (const [host, keys] of Object.entries(m.removed ?? {})) {
    const floor = Math.max(cleared[host] ?? 0, m.wipedAt);
    const kept = Object.fromEntries(Object.entries(keys ?? {}).filter(([, at]) => live(at) && at > floor));
    if (Object.keys(kept).length > 0) removed[host] = kept;
  }
  return { wipedAt: typeof m.wipedAt === "number" && m.wipedAt > cutoff ? m.wipedAt : 0, cleared, removed };
}

function reviveMarkers(raw: unknown): MemoryMarkers {
  const r = raw as Partial<MemoryMarkers> | null;
  if (!r || typeof r !== "object") return emptyMarkers();
  const wipedAt = typeof r.wipedAt === "number" ? r.wipedAt : 0;
  const cleared = r.cleared && typeof r.cleared === "object" ? (r.cleared as Record<string, number>) : {};
  const removed = r.removed && typeof r.removed === "object" ? (r.removed as Record<string, Record<string, number>>) : {};
  return pruneMarkers({ wipedAt, cleared, removed }, Date.now());
}

/** A synced record of the `site_memory` collection: a host record, or the wipe marker. */
export type SiteMemoryRecord = { id: string; payload: SyncedSiteMemory | SiteMemoryWipe };

/**
 * What Corvus learned about sites, for one profile (`site-memory.json`). Bounded: MAX_ENTRY_BYTES
 * per host (compacted on every merge) and MAX_HOSTS hosts, least recently seen evicted first.
 * Synced end to end as the `site_memory` collection when the user keeps that category on
 * (syncList / applyRemote, merge rules in shared/site-memory-sync.ts).
 */
export class SiteMemoryStore {
  private readonly file: JsonFile<SiteMemoryEntry[]>;
  private readonly markersFile: JsonFile<MemoryMarkers>;
  private readonly listeners = new Set<Listener>();
  /** This profile on this install, for per-device counters. */
  readonly replica: string;

  constructor(dir: string) {
    this.file = JsonFile.load(path.join(dir, "site-memory.json"), () => [], revive, 500);
    this.markersFile = JsonFile.load(path.join(dir, "site-memory-sync.json"), emptyMarkers, reviveMarkers, 0);
    this.replica = replicaId(dir);
  }

  onChange(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private commit(list: SiteMemoryEntry[]): void {
    this.file.set(evictHosts(list, MAX_HOSTS));
    for (const l of this.listeners) l();
  }

  private markers(): MemoryMarkers {
    return this.markersFile.get();
  }

  private setMarkers(next: MemoryMarkers): void {
    this.markersFile.set(next);
  }

  /** Newest first. */
  list(): SiteMemoryEntry[] {
    return [...this.file.get()].sort((a, b) => b.lastSeen - a.lastSeen);
  }

  get(host: string): SiteMemoryEntry | undefined {
    return this.file.get().find((e) => e.host === host);
  }

  get size(): number {
    return this.file.get().length;
  }

  /**
   * Fold a finished run into memory. A successful run adds what worked; any run counts its failed
   * targets against remembered ones. A failed run never creates a new host entry. Returns the hosts
   * that changed.
   */
  learn(trail: readonly TrailEvent[], runOk: boolean, now = Date.now()): string[] {
    const lessons = extractLessons(trail);
    if (lessons.length === 0) return [];
    const list = [...this.file.get()];
    const changed: string[] = [];
    for (const l of lessons) {
      const idx = list.findIndex((e) => e.host === l.host);
      const existing = idx >= 0 ? list[idx] : undefined;
      const hasKnowledge = l.targets.length + l.urls.length + l.obstacles.length > 0;
      if (!existing && (!runOk || !hasKnowledge)) continue;
      if (existing && !runOk && l.failures.length === 0) continue;
      const merged = mergeLessons(existing, l, runOk, now, this.replica);
      if (!existing && hintCount(merged) === 0) continue;
      if (idx >= 0) list[idx] = merged;
      else list.push(merged);
      changed.push(l.host);
    }
    if (changed.length) this.commit(list);
    return changed;
  }

  /** A remembered target failed outside a run (e.g. a workflow step broke on it). */
  noteFailure(host: string, role: string, name: string, now = Date.now()): void {
    const list = this.file.get();
    const e = list.find((x) => x.host === host);
    if (!e || !e.targets.some((t) => t.role === role && t.name === name)) return;
    this.commit(list.map((x) => (x.host === host ? noteTargetFailure(x, role, name, now, this.replica) : x)));
  }

  /** "Forget this hint" (on every device: the removal is remembered and synced). */
  removeHint(host: string, kind: MemoryHintKind, key: string, now = Date.now()): void {
    const list = this.file.get();
    const entry = list.find((e) => e.host === host);
    if (!entry) return;
    const items: Array<{ kind: MemoryHintKind; key: string }> = [
      ...entry.targets.map((t) => ({ kind: "target" as const, key: hintKey("target", t) })),
      ...entry.urls.map((u) => ({ kind: "url" as const, key: hintKey("url", u) })),
      ...entry.obstacles.map((o) => ({ kind: "obstacle" as const, key: hintKey("obstacle", o) })),
      ...entry.sequences.map((q) => ({ kind: "sequence" as const, key: hintKey("sequence", q) })),
    ];
    if (items.some((i) => i.kind === kind && i.key === key)) {
      const m = this.markers();
      this.setMarkers({ ...m, removed: { ...m.removed, [host]: { ...(m.removed[host] ?? {}), [removalKey(kind, key)]: now } } });
    }
    this.commit(list.map((e) => (e.host === host ? removeHint(e, kind, key) : e)));
  }

  /** "Forget this site" (on every device). */
  forget(host: string, now = Date.now()): void {
    const m = this.markers();
    const removed = { ...m.removed };
    delete removed[host];
    this.setMarkers({ ...m, cleared: { ...m.cleared, [host]: now }, removed });
    this.commit(this.file.get().filter((e) => e.host !== host));
  }

  /**
   * "Forget everything" (on every device): a wipe marker covers whatever any device learned up to
   * now, and each host this device knows is also cleared so its copy on the server is overwritten.
   */
  forgetAll(now = Date.now()): void {
    const m = this.markers();
    const cleared: Record<string, number> = {};
    for (const host of [...this.file.get().map((e) => e.host), ...Object.keys(m.cleared), ...Object.keys(m.removed)]) cleared[host] = now;
    this.setMarkers({ wipedAt: now, cleared, removed: {} });
    this.commit([]);
  }

  // -------------------------------------------------------------------- sync

  private hostMarkers(host: string, m = this.markers()): HostMarkers {
    return { clearedAt: m.cleared[host] ?? 0, removed: m.removed[host] ?? {} };
  }

  /** Every host this device knows (or forgot), plus the wipe marker, as `site_memory` records. */
  syncList(now = Date.now()): SiteMemoryRecord[] {
    const m = pruneMarkers(this.markers(), now);
    const ctx: MergeContext = { now, wipedAt: m.wipedAt };
    const out: SiteMemoryRecord[] = [];
    const listed = new Set<string>();
    for (const entry of this.file.get()) {
      if (!isMemoryHost(entry.host)) continue;
      listed.add(entry.host);
      out.push({ id: entry.host, payload: toSyncedSiteMemory(entry, entry.host, this.hostMarkers(entry.host, m), this.replica, ctx) });
    }
    for (const host of new Set([...Object.keys(m.cleared), ...Object.keys(m.removed)])) {
      if (!listed.has(host) && isMemoryHost(host)) out.push({ id: host, payload: toSyncedSiteMemory(undefined, host, this.hostMarkers(host, m), this.replica, ctx) });
    }
    if (m.wipedAt > 0) out.push({ id: WIPE_RECORD_ID, payload: { v: 1, wipedAt: m.wipedAt } });
    return out;
  }

  /**
   * Merge remote records. A wipe marker applies first (it can cover hosts in the same batch). A
   * host record merges with this device's copy and tombstones; the result replaces both. `null`
   * means the server deleted the record: the local copy goes too.
   */
  applyRemote(changes: ReadonlyArray<{ id: string; record: SyncedSiteMemory | SiteMemoryWipe | null }>, now = Date.now()): void {
    if (changes.length === 0) return;
    let m = this.markers();
    let list = [...this.file.get()];
    let wipedAt = m.wipedAt;
    for (const { id, record } of changes) {
      if (id === WIPE_RECORD_ID && record && "wipedAt" in record) wipedAt = Math.max(wipedAt, record.wipedAt);
    }
    if (wipedAt > m.wipedAt) {
      // A newer "Forget everything": drop whatever it covers from every local entry.
      const ctx: MergeContext = { now, wipedAt };
      list = list.flatMap((e) => {
        const kept = entryFromSynced(toSyncedSiteMemory(e, e.host, this.hostMarkers(e.host, m), this.replica, ctx));
        return kept ? [kept] : [];
      });
      m = pruneMarkers({ ...m, wipedAt }, now);
    }
    const ctx: MergeContext = { now, wipedAt: m.wipedAt };
    for (const { id, record } of changes) {
      if (id === WIPE_RECORD_ID || !isMemoryHost(id)) continue;
      const idx = list.findIndex((e) => e.host === id);
      if (!record) {
        if (idx >= 0) list.splice(idx, 1);
        continue;
      }
      if ("wipedAt" in record) continue;
      const local = toSyncedSiteMemory(idx >= 0 ? list[idx] : undefined, id, this.hostMarkers(id, m), this.replica, ctx);
      const merged = mergeSiteMemory(local, record, ctx);
      const cleared = { ...m.cleared };
      const removed = { ...m.removed };
      if (merged.clearedAt > 0) cleared[id] = merged.clearedAt;
      else delete cleared[id];
      if (Object.keys(merged.removed).length > 0) removed[id] = merged.removed;
      else delete removed[id];
      m = { ...m, cleared, removed };
      const entry = entryFromSynced(merged);
      if (idx >= 0) list.splice(idx, 1);
      if (entry) list.push(entry);
    }
    this.setMarkers(m);
    this.commit(list);
  }

  /** Joining a chain: forgets made while this collection was not syncing stay local. */
  resetSyncMarkers(): void {
    this.setMarkers(emptyMarkers());
  }

  flush(): void {
    this.file.flush();
    this.markersFile.flush();
  }
}
