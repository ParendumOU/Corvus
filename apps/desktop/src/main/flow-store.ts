import crypto from "node:crypto";
import path from "node:path";
import {
  MAX_FLOWS,
  MAX_FLOW_BYTES,
  MAX_LABEL,
  MAX_SELECTOR,
  MAX_STEPS_PER_FLOW,
  MAX_STEP_VALUE,
  clampName,
  labelForStep,
  type FlowStep,
  type FlowTarget,
  type SavedFlow,
} from "../shared/flow";
import { JsonFile } from "./json-file";

type Listener = () => void;

function reviveTarget(raw: unknown): FlowTarget | undefined {
  const t = raw as Partial<FlowTarget> | null;
  if (!t || typeof t.role !== "string" || typeof t.name !== "string") return undefined;
  return {
    role: t.role.slice(0, 80),
    name: t.name.slice(0, 120),
    index: typeof t.index === "number" && Number.isFinite(t.index) && t.index >= 0 ? Math.floor(t.index) : 0,
    tag: typeof t.tag === "string" ? t.tag.slice(0, 40) : "",
    selector: typeof t.selector === "string" ? t.selector.slice(0, MAX_SELECTOR) : "",
  };
}

function reviveStep(raw: unknown): FlowStep | null {
  const s = raw as Partial<FlowStep> | null;
  if (!s || (s.kind !== "navigate" && s.kind !== "click" && s.kind !== "type")) return null;
  const url = typeof s.url === "string" ? s.url.slice(0, 4096) : "";
  const target = s.kind === "navigate" ? undefined : reviveTarget(s.target);
  if (s.kind !== "navigate" && !target) return null;
  const step: FlowStep = {
    kind: s.kind,
    url,
    label: (typeof s.label === "string" ? s.label : "").slice(0, MAX_LABEL),
    ...(target ? { target } : {}),
  };
  if (s.kind === "type") {
    step.secret = s.secret === true;
    step.submit = s.submit === true;
    if (!step.secret && typeof s.value === "string") step.value = s.value.slice(0, MAX_STEP_VALUE);
  }
  if (!step.label) step.label = labelForStep(step);
  return step;
}

function isFlowRaw(v: unknown): v is Partial<SavedFlow> {
  const f = v as Partial<SavedFlow> | null;
  return typeof f?.id === "string" && Array.isArray(f.steps);
}

function revive(raw: unknown): SavedFlow[] {
  if (!Array.isArray(raw)) return [];
  const now = Date.now();
  return raw
    .filter(isFlowRaw)
    .map((f) => {
      const steps = (Array.isArray(f.steps) ? f.steps : [])
        .map(reviveStep)
        .filter((s): s is FlowStep => s !== null)
        .slice(0, MAX_STEPS_PER_FLOW);
      return {
        id: f.id as string,
        name: clampName(typeof f.name === "string" ? f.name : ""),
        startUrl: typeof f.startUrl === "string" ? f.startUrl.slice(0, 4096) : "",
        steps,
        createdAt: typeof f.createdAt === "number" ? f.createdAt : now,
        updatedAt: typeof f.updatedAt === "number" ? f.updatedAt : now,
      };
    })
    .slice(0, MAX_FLOWS);
}

/** Over-size a flow would be once stored (used to reject pathological recordings). */
function flowBytes(flow: SavedFlow): number {
  return Buffer.byteLength(JSON.stringify(flow), "utf8");
}

/** Recorded flows for one profile. Durable; replay/recording state is held by the service. */
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

  /** Create a flow from a recorded step list. Returns null on the per-profile cap, empty or over-size. */
  create(name: string, startUrl: string, steps: FlowStep[]): SavedFlow | null {
    const list = this.file.get();
    if (list.length >= MAX_FLOWS) return null;
    const bounded = steps.slice(0, MAX_STEPS_PER_FLOW);
    if (bounded.length === 0) return null;
    const now = Date.now();
    const flow: SavedFlow = {
      id: crypto.randomUUID(),
      name: clampName(name),
      startUrl: startUrl.slice(0, 4096),
      steps: bounded,
      createdAt: now,
      updatedAt: now,
    };
    if (flowBytes(flow) > MAX_FLOW_BYTES) return null;
    this.commit([...list, flow]);
    return flow;
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
