import crypto from "node:crypto";
import path from "node:path";
import { MAX_FLOWS, MAX_FLOW_BYTES, MAX_STEPS_PER_FLOW, clampName, emptyUsage, type FlowOrigin, type FlowStep, type SavedFlow } from "../shared/flow";
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
import { JsonFile } from "./json-file";

type Listener = () => void;

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
    usage: reviveUsage(f.usage),
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

/** Recorded flows and workflows for one profile. Durable; replay/recording state is held by the service. */
export class FlowStore {
  private readonly file: JsonFile<SavedFlow[]>;
  private readonly listeners = new Set<Listener>();

  constructor(dir: string) {
    this.file = JsonFile.load(path.join(dir, "flows.json"), () => [], revive, 0);
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

  /** Count a run and remember how it ended (stale workflows show their last failure). */
  recordRun(id: string, outcome: WorkflowOutcome): void {
    const list = this.file.get();
    if (!list.some((f) => f.id === id)) return;
    this.commit(list.map((f) => (f.id === id ? { ...f, usage: recordUsage(f.usage, outcome) } : f)));
  }

  rename(id: string, name: string): void {
    const list = this.file.get();
    if (!list.some((f) => f.id === id)) return;
    this.commit(list.map((f) => (f.id === id ? { ...f, name: clampName(name, f.name), updatedAt: Date.now() } : f)));
  }

  remove(id: string): void {
    this.commit(this.file.get().filter((f) => f.id !== id));
  }

  flush(): void {
    this.file.flush();
  }
}
