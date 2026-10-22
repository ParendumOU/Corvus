/**
 * Workflows across devices: the `workflows` sync collection. Pure (no Node/Electron) and unit
 * tested; main/flow-store.ts feeds it local state and keeps its results.
 *
 * RECORD: one per workflow (record id = the workflow's stable id): `{v, id, updatedAt, flow,
 * usage}`. `flow` is the definition (name, description, start page, steps, sites, parameters,
 * origin, source run, creation time) or null for a deletion made at `updatedAt`. `usage` holds
 * each device's own run counters (replica id -> FlowUsage).
 *
 * MERGE (idempotent, commutative, associative):
 * - definition: last writer wins by `updatedAt`; a deletion is a write at its own time, so a later
 *   edit beats an older delete and a later delete beats an older edit. Ties go to the deletion,
 *   then to the larger canonical JSON, so every device picks the same;
 * - usage: united by device; for the same device the newest slot wins (a device only advances its
 *   own counters), so the same data coming back never counts twice. The workflow shows the sum of
 *   runs / ok / failed over devices and the last status of the most recent run anywhere.
 *
 * PRIVACY: secrets are never stored in workflows. On the way out and in, a typed step into a
 * field that looks secret (password, one-time code, card...) is forced to a secret step without a
 * value, and a parameter default no remaining step uses is cleared.
 */
import { MAX_STEP_VALUE, clampName, emptyUsage, type FlowParam, type FlowStep, type FlowUsage, type SavedFlow } from "./flow";
import { REPLICA_RE, SENSITIVE_FIELD } from "./site-memory";
import { MAX_DESCRIPTION, reviveParams, reviveSites, reviveSteps, reviveUsage, sitesForSteps, stepParamNames } from "./workflow";

/** Deletions are kept this long; after that the record is simply deleted on the server. */
export const WORKFLOW_TOMBSTONE_TTL_MS = 180 * 24 * 3600_000;
const MAX_USAGE_SLOTS = 32;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** Field names whose typed value is a secret (on top of the site memory list). */
const SECRET_FIELD = /\b(password|passcode|pin|cvv|cvc|card\s?number|credit\s?card|security\s?code|otp|2fa)\b/i;

export interface SyncedWorkflowDef {
  name: string;
  description: string;
  startUrl: string;
  steps: FlowStep[];
  sites: string[];
  params: FlowParam[];
  origin: SavedFlow["origin"];
  sourceRunId: string | null;
  createdAt: number;
}

export interface SyncedWorkflow {
  v: 1;
  id: string;
  /** The last edit, or when it was deleted. */
  updatedAt: number;
  /** The definition; null when the workflow was deleted at updatedAt. */
  flow: SyncedWorkflowDef | null;
  /** Each device's own counters: replica id -> usage. */
  usage: Record<string, FlowUsage>;
}

// ------------------------------------------------------------------ canonical JSON

/** JSON with sorted object keys, for deterministic tie-breaks. */
export function canonicalJson(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(v).sort()) out[key] = sort((v as Record<string, unknown>)[key]);
      return out;
    }
    return v;
  };
  return JSON.stringify(sort(value)) ?? "null";
}

// ------------------------------------------------------------------ privacy

function secretField(step: FlowStep): boolean {
  const name = step.target?.name ?? "";
  return SENSITIVE_FIELD.test(name) || SECRET_FIELD.test(name);
}

/** Steps with every secret-looking typed field turned into a secret step (no value). */
export function sanitizeSteps(steps: readonly FlowStep[]): FlowStep[] {
  return steps.map((s) => {
    if (s.kind !== "type" || (!s.secret && !secretField(s))) return s;
    const { value: _value, ...rest } = s;
    return { ...rest, secret: true };
  });
}

/** A parameter default is kept only while a non-secret step still uses the parameter. */
function sanitizeParams(params: readonly FlowParam[], startUrl: string, steps: readonly FlowStep[]): FlowParam[] {
  const used = new Set(stepParamNames(startUrl, steps));
  return params.map((p) => (used.has(p.name) ? p : { ...p, default: "" }));
}

// ------------------------------------------------------------------ usage

const lastRun = (u: FlowUsage): number => u.lastRunAt ?? -1;

/** The newer of two slots of the same device. */
function newerUsage(a: FlowUsage, b: FlowUsage): FlowUsage {
  if (lastRun(a) !== lastRun(b)) return lastRun(a) > lastRun(b) ? a : b;
  if (a.runs !== b.runs) return a.runs > b.runs ? a : b;
  return canonicalJson(a) >= canonicalJson(b) ? a : b;
}

export function uniteUsage(a: Readonly<Record<string, FlowUsage>>, b: Readonly<Record<string, FlowUsage>>): Record<string, FlowUsage> {
  const out: Record<string, FlowUsage> = { ...a };
  for (const [replica, slot] of Object.entries(b)) out[replica] = out[replica] ? newerUsage(out[replica]!, slot) : slot;
  return out;
}

/** What the workflow shows: totals over devices, and how the most recent run anywhere ended. */
export function combineUsage(slots: Readonly<Record<string, FlowUsage>> | undefined): FlowUsage {
  const entries = Object.entries(slots ?? {}).sort(([a], [b]) => (a < b ? -1 : 1));
  if (entries.length === 0) return emptyUsage();
  let latest: FlowUsage | null = null;
  for (const [, u] of entries) if (u.lastRunAt !== null && (!latest || lastRun(u) >= lastRun(latest))) latest = u;
  return {
    runs: entries.reduce((n, [, u]) => n + u.runs, 0),
    ok: entries.reduce((n, [, u]) => n + u.ok, 0),
    failed: entries.reduce((n, [, u]) => n + u.failed, 0),
    lastRunAt: latest?.lastRunAt ?? null,
    lastStatus: latest?.lastStatus ?? null,
    lastError: latest?.lastError ?? null,
    lastBrokenStep: latest?.lastBrokenStep ?? null,
    lastRunBy: latest?.lastRunBy ?? null,
  };
}

/** This device's view of a flow's per-device usage; runs from before sync existed are its own. */
export function usageSlots(flow: Pick<SavedFlow, "usage" | "usageBy">, replica: string): Record<string, FlowUsage> {
  if (flow.usageBy) return flow.usageBy;
  return flow.usage.runs > 0 || flow.usage.lastRunAt !== null ? { [replica]: flow.usage } : {};
}

export function reviveUsageSlots(raw: unknown): Record<string, FlowUsage> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const out: Record<string, FlowUsage> = {};
  let count = 0;
  for (const [replica, u] of Object.entries(raw as Record<string, unknown>)) {
    if (!REPLICA_RE.test(replica)) continue;
    out[replica] = reviveUsage(u);
    if (++count >= MAX_USAGE_SLOTS) break;
  }
  return out;
}

// ------------------------------------------------------------------ records

/**
 * A local flow as a record, in exactly the form a receiving device rebuilds from it (validated,
 * clamped, privacy-filtered), so a record never changes on its way round. Null when the flow
 * cannot travel (nothing runnable).
 */
export function toSyncedWorkflow(flow: SavedFlow, replica: string): SyncedWorkflow | null {
  const def = parseDef({
    name: flow.name,
    description: flow.description,
    startUrl: flow.startUrl,
    steps: flow.steps,
    sites: flow.sites,
    params: flow.params,
    origin: flow.origin,
    sourceRunId: flow.sourceRunId,
    createdAt: flow.createdAt,
  });
  if (!def || !ID_RE.test(flow.id)) return null;
  return { v: 1, id: flow.id, updatedAt: flow.updatedAt, flow: def, usage: { ...usageSlots(flow, replica) } };
}

export function workflowTombstone(id: string, deletedAt: number, usage: Record<string, FlowUsage> = {}): SyncedWorkflow {
  return { v: 1, id, updatedAt: deletedAt, flow: null, usage: { ...usage } };
}

export function workflowFromSynced(record: SyncedWorkflow): SavedFlow | null {
  if (!record.flow) return null;
  const usageBy = Object.keys(record.usage).length > 0 ? { ...record.usage } : undefined;
  return {
    id: record.id,
    ...record.flow,
    updatedAt: record.updatedAt,
    usage: combineUsage(record.usage),
    ...(usageBy ? { usageBy } : {}),
  };
}

/** Positive when `a` wins. */
function compareWrites(a: SyncedWorkflow, b: SyncedWorkflow): number {
  if (a.updatedAt !== b.updatedAt) return a.updatedAt - b.updatedAt;
  if ((a.flow === null) !== (b.flow === null)) return a.flow === null ? 1 : -1;
  const ja = canonicalJson(a.flow);
  const jb = canonicalJson(b.flow);
  return ja === jb ? 0 : ja > jb ? 1 : -1;
}

export function mergeSyncedWorkflow(a: SyncedWorkflow, b: SyncedWorkflow): SyncedWorkflow {
  const winner = compareWrites(a, b) >= 0 ? a : b;
  return { v: 1, id: a.id, updatedAt: winner.updatedAt, flow: winner.flow, usage: uniteUsage(a.usage, b.usage) };
}

// ------------------------------------------------------------------ parsing (incoming)

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);
const str = (v: unknown, max: number): string => (typeof v === "string" ? v.slice(0, max) : "");

function parseDef(raw: unknown): SyncedWorkflowDef | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const d = raw as Record<string, unknown>;
  const startUrl = str(d.startUrl, 4096);
  if (!/^https?:\/\//i.test(startUrl.replace(/\{\{[^}]*\}\}/g, "x"))) return null;
  const steps = sanitizeSteps(reviveSteps(d.steps));
  if (steps.length === 0) return null;
  const sites = reviveSites(d.sites);
  return {
    name: clampName(str(d.name, 400), "Workflow"),
    description: str(d.description, MAX_DESCRIPTION),
    startUrl,
    steps,
    sites: sites.length > 0 ? sites : sitesForSteps(startUrl, steps),
    params: sanitizeParams(
      reviveParams(d.params).map((p) => ({ ...p, default: p.default.slice(0, MAX_STEP_VALUE) })),
      startUrl,
      steps,
    ),
    origin: d.origin === "agent" ? "agent" : "recorded",
    sourceRunId: typeof d.sourceRunId === "string" ? d.sourceRunId.slice(0, 128) : null,
    createdAt: num(d.createdAt),
  };
}

/** Validate a remote record; null when unusable or written by a newer format. */
export function parseSyncedWorkflow(raw: unknown, id: string): SyncedWorkflow | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || !ID_RE.test(id)) return null;
  const r = raw as Record<string, unknown>;
  if (r.v !== 1 || r.id !== id || num(r.updatedAt) <= 0) return null;
  const flow = r.flow === null ? null : parseDef(r.flow);
  if (r.flow !== null && !flow) return null;
  return { v: 1, id, updatedAt: num(r.updatedAt), flow, usage: reviveUsageSlots(r.usage) ?? {} };
}
