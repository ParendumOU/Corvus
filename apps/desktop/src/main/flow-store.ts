import crypto from "node:crypto";
import path from "node:path";
import { MAX_FLOWS, MAX_FLOW_BYTES, MAX_STEPS_PER_FLOW, clampName, emptyUsage, type FlowOrigin, type FlowStep, type FlowUsage, type SavedFlow } from "../shared/flow";
import {
  MAX_DESCRIPTION,
  recordUsage,
  reviveParams,
  reviveSites,
  reviveSteps,
  reviveUsage,
  sitesForSteps,
  type WorkflowEdit,
  type WorkflowOutcome,
} from "../shared/workflow";
import {
  WORKFLOW_TOMBSTONE_TTL_MS,
  combineUsage,
  mergeSyncedWorkflow,
  reviveUsageSlots,
  toSyncedWorkflow,
  usageSlots,
  workflowFromSynced,
  workflowTombstone,
  type SyncedWorkflow,
} from "../shared/workflow-sync";
import { JsonFile } from "./json-file";
import { replicaId } from "./replica-id";

type Listener = () => void;

/** Deleted workflows, remembered so the deletion syncs and beats older edits (flows-sync.json). */
interface FlowSyncFile {
  deleted: Record<string, { at: number; usage: Record<string, FlowUsage> }>;
}

function reviveSyncFile(raw: unknown): FlowSyncFile {
  const deleted: FlowSyncFile["deleted"] = {};
  const r = raw as Partial<FlowSyncFile> | null;
  const cutoff = Date.now() - WORKFLOW_TOMBSTONE_TTL_MS;
  for (const [id, t] of Object.entries(r && typeof r.deleted === "object" && r.deleted ? r.deleted : {})) {
    if (typeof t?.at === "number" && t.at > cutoff) deleted[id] = { at: t.at, usage: reviveUsageSlots(t.usage) ?? {} };
  }
  return { deleted };
}

function isFlowRaw(v: unknown): v is Partial<SavedFlow> {
  const f = v as Partial<SavedFlow> | null;
  return typeof f?.id === "string" && Array.isArray(f.steps);
}

/**
 * Revive a stored flow. Flows saved before workflows existed have no origin/sites/params/usage:
 * they load as "recorded" flows that apply to their start page's host, with empty usage.
 */
function reviveFlow(f: Partial<SavedFlow>, now: number): SavedFlow {
  const startUrl = typeof f.startUrl === "string" ? f.startUrl.slice(0, 4096) : "";
  const steps = reviveSteps(f.steps);
  const sites = reviveSites(f.sites);
  const usageBy = reviveUsageSlots(f.usageBy);
  return {
    id: f.id as string,
    name: clampName(typeof f.name === "string" ? f.name : ""),
    startUrl,
    steps,
    createdAt: typeof f.createdAt === "number" ? f.createdAt : now,
    updatedAt: typeof f.updatedAt === "number" ? f.updatedAt : now,
    description: typeof f.description === "string" ? f.description.slice(0, MAX_DESCRIPTION) : "",
    origin: f.origin === "agent" ? "agent" : "recorded",
    sourceRunId: typeof f.sourceRunId === "string" ? f.sourceRunId.slice(0, 128) : null,
    sites: sites.length > 0 ? sites : sitesForSteps(startUrl, steps),
    params: reviveParams(f.params),
    usage: usageBy ? combineUsage(usageBy) : reviveUsage(f.usage),
    ...(usageBy ? { usageBy } : {}),
  };
}

function revive(raw: unknown): SavedFlow[] {
  if (!Array.isArray(raw)) return [];
  const now = Date.now();
  return raw
    .filter(isFlowRaw)
    .map((f) => reviveFlow(f, now))
    .slice(0, MAX_FLOWS);
}

/** Over-size a flow would be once stored (used to reject pathological recordings). */
function flowBytes(flow: SavedFlow): number {
  return Buffer.byteLength(JSON.stringify(flow), "utf8");
}

export interface CreateFlowOptions {
  origin?: FlowOrigin;
  description?: string;
  sourceRunId?: string | null;
  sites?: string[];
  params?: SavedFlow["params"];
}

/**
 * Recorded flows and workflows for one profile. Durable; replay/recording state is held by the service.
 * Synced end to end as the `workflows` collection (syncList / applyRemote, see shared/workflow-sync.ts).
 */
export class FlowStore {
  private readonly file: JsonFile<SavedFlow[]>;
  private readonly syncFile: JsonFile<FlowSyncFile>;
  private readonly listeners = new Set<Listener>();
  /** This profile on this install, for per-device usage counters. */
  readonly replica: string;

  constructor(dir: string) {
    this.file = JsonFile.load(path.join(dir, "flows.json"), () => [], revive, 0);
    this.syncFile = JsonFile.load(path.join(dir, "flows-sync.json"), () => ({ deleted: {} }), reviveSyncFile, 0);
    this.replica = replicaId(dir);
  }

  onChange(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const l of this.listeners) l();
  }

  list(): SavedFlow[] {
    return this.file.get();
  }

  get(id: string): SavedFlow | undefined {
    return this.file.get().find((f) => f.id === id);
  }

  private commit(list: SavedFlow[]): void {
    this.file.set(list);
    this.emit();
  }

  /** Create a flow from a step list. Returns null on the per-profile cap, empty or over-size. */
  create(name: string, startUrl: string, steps: FlowStep[], opts: CreateFlowOptions = {}): SavedFlow | null {
    const list = this.file.get();
    if (list.length >= MAX_FLOWS) return null;
    const bounded = steps.slice(0, MAX_STEPS_PER_FLOW);
    if (bounded.length === 0) return null;
    const now = Date.now();
    const start = startUrl.slice(0, 4096);
    const sites = reviveSites(opts.sites);
    const flow: SavedFlow = {
      id: crypto.randomUUID(),
      name: clampName(name),
      startUrl: start,
      steps: bounded,
      createdAt: now,
      updatedAt: now,
      description: (opts.description ?? "").slice(0, MAX_DESCRIPTION),
      origin: opts.origin ?? "recorded",
      sourceRunId: opts.sourceRunId ?? null,
      sites: sites.length > 0 ? sites : sitesForSteps(start, bounded),
      params: reviveParams(opts.params),
      usage: emptyUsage(),
    };
    if (flowBytes(flow) > MAX_FLOW_BYTES) return null;
    this.commit([...list, flow]);
    return flow;
  }

  /** Save a reviewed workflow edit (from the editor) as a new flow. */
  createFromEdit(edit: WorkflowEdit, origin: FlowOrigin, sourceRunId: string | null): SavedFlow | null {
    return this.create(edit.name, edit.startUrl, edit.steps, { origin, description: edit.description, sourceRunId, sites: edit.sites, params: edit.params });
  }

  /** Apply an edit (rename, description, sites, reordered/removed steps, parameters). False when rejected. */
  update(id: string, edit: WorkflowEdit): boolean {
    const list = this.file.get();
    const current = list.find((f) => f.id === id);
    if (!current) return false;
    const next: SavedFlow = {
      ...current,
      name: clampName(edit.name, current.name),
      description: edit.description.slice(0, MAX_DESCRIPTION),
      startUrl: edit.startUrl.slice(0, 4096),
      steps: edit.steps.slice(0, MAX_STEPS_PER_FLOW),
      sites: edit.sites.length > 0 ? reviveSites(edit.sites) : sitesForSteps(edit.startUrl, edit.steps),
      params: reviveParams(edit.params),
      updatedAt: Date.now(),
    };
    if (next.steps.length === 0 || flowBytes(next) > MAX_FLOW_BYTES) return false;
    this.commit(list.map((f) => (f.id === id ? next : f)));
    return true;
  }

  /**
   * Count a run and remember how it ended (stale workflows show their last failure). Only this
   * device's own counters move; the shown usage is the total over devices.
   */
  recordRun(id: string, outcome: WorkflowOutcome): void {
    const list = this.file.get();
    if (!list.some((f) => f.id === id)) return;
    this.commit(
      list.map((f) => {
        if (f.id !== id) return f;
        const slots = usageSlots(f, this.replica);
        const usageBy = { ...slots, [this.replica]: recordUsage(slots[this.replica] ?? emptyUsage(), outcome) };
        return { ...f, usageBy, usage: combineUsage(usageBy) };
      }),
    );
  }

  rename(id: string, name: string): void {
    const list = this.file.get();
    if (!list.some((f) => f.id === id)) return;
    this.commit(list.map((f) => (f.id === id ? { ...f, name: clampName(name, f.name), updatedAt: Date.now() } : f)));
  }

  remove(id: string): void {
    const flow = this.get(id);
    if (flow) this.markDeleted(id, Date.now(), usageSlots(flow, this.replica));
    this.commit(this.file.get().filter((f) => f.id !== id));
  }

  private markDeleted(id: string, at: number, usage: Record<string, FlowUsage>): void {
    this.syncFile.update((s) => ({ deleted: { ...s.deleted, [id]: { at, usage } } }));
  }

  // -------------------------------------------------------------------- sync

  /** Every workflow and every remembered deletion, as `workflows` records. */
  syncList(now = Date.now()): SyncedWorkflow[] {
    const out = this.file.get().flatMap((f) => toSyncedWorkflow(f, this.replica) ?? []);
    const live = new Set(out.map((w) => w.id));
    for (const [id, t] of Object.entries(this.syncFile.get().deleted)) {
      // An expired deletion leaves the list: the engine then deletes the record on the server.
      if (!live.has(id) && now - t.at < WORKFLOW_TOMBSTONE_TTL_MS) out.push(workflowTombstone(id, t.at, t.usage));
    }
    return out;
  }

  /**
   * Merge remote records (null = the record was deleted on the server). A remote workflow that would
   * pass the per-profile cap or the size limit is declined (left out, so the engine forgets it).
   */
  applyRemote(changes: ReadonlyArray<{ id: string; record: SyncedWorkflow | null }>): void {
    if (changes.length === 0) return;
    let list = [...this.file.get()];
    const deleted = { ...this.syncFile.get().deleted };
    for (const { id, record } of changes) {
      const idx = list.findIndex((f) => f.id === id);
      if (!record) {
        if (idx >= 0) list.splice(idx, 1);
        delete deleted[id];
        continue;
      }
      const local = idx >= 0 ? toSyncedWorkflow(list[idx]!, this.replica) : deleted[id] ? workflowTombstone(id, deleted[id]!.at, deleted[id]!.usage) : null;
      // (A local flow that cannot travel is replaced by the remote one.)
      const merged = local ? mergeSyncedWorkflow(local, record) : record;
      const flow = workflowFromSynced(merged);
      if (!flow) {
        if (idx >= 0) list.splice(idx, 1);
        deleted[id] = { at: merged.updatedAt, usage: merged.usage };
        continue;
      }
      delete deleted[id];
      if (flowBytes(flow) > MAX_FLOW_BYTES || (idx < 0 && list.length >= MAX_FLOWS)) continue;
      if (idx >= 0) list[idx] = flow;
      else list = [...list, flow];
    }
    this.syncFile.set({ deleted });
    this.commit(list);
  }

  /** Joining a chain: deletions recorded while this collection was not syncing stay local. */
  resetSyncMarkers(): void {
    this.syncFile.set({ deleted: {} });
  }

  flush(): void {
    this.file.flush();
    this.syncFile.flush();
  }
}
