/**
 * Recorded browser flows (record/replay macros for the user's own browsing): the durable step model,
 * the per-profile caps, and the pure helpers that turn a recorded step into the same tool call the
 * agent uses (so replay reuses the exact action primitives and the exact risky-action approval gate)
 * and that resolve a recorded target to a live element ref from a fresh page snapshot.
 *
 * Pure (no node/Electron imports) so it is unit-tested and safe for both tsconfig projects.
 */

export type FlowStepKind = "navigate" | "click" | "type";

/**
 * A robust, snapshot-independent handle on an element. role/name are computed exactly as
 * page_snapshot computes them, so on replay the recorded target matches by (role, name) among the
 * live snapshot elements; `index` disambiguates repeats; `selector`/`tag` are display/debug hints.
 */
export interface FlowTarget {
  role: string;
  name: string;
  /** nth element (0-based) with this (role, name) in page order, as page_snapshot enumerates them. */
  index: number;
  tag: string;
  selector: string;
}

export interface FlowStep {
  kind: FlowStepKind;
  /** URL the step applies to (for navigate, the destination; otherwise the page it was recorded on). */
  url: string;
  /** Short human label shown in the step list and the replay cursor. */
  label: string;
  /** Element target for click/type steps. */
  target?: FlowTarget;
  /** Text typed for a type step (never stored for a secret field). */
  value?: string;
  /** A type step that also submits the form (Enter / requestSubmit). */
  submit?: boolean;
  /** The target was a password/secret field: no value is stored and replay hands it to the user. */
  secret?: boolean;
}

/** Where a saved flow came from: the user's own recording, or the successful steps of an agent run. */
export type FlowOrigin = "recorded" | "agent";

/**
 * A named value a workflow step uses as `{{name}}` (in a type step's value or a navigate URL).
 * Asked for at run time (prefilled with `default`), or filled by the agent from its task. Secret
 * fields are never parameters: they stay `secret: true` steps with no value, handed to the user.
 */
export interface FlowParam {
  name: string;
  /** Human label shown in the run form. */
  label: string;
  /** Prefilled value; "" means the value must be given at run time. */
  default: string;
}

export type FlowRunStatus = "ok" | "failed" | "stopped";

/** How a workflow has fared, so stale ones (targets that stopped matching) are visible. */
export interface FlowUsage {
  runs: number;
  ok: number;
  failed: number;
  lastRunAt: number | null;
  lastStatus: FlowRunStatus | null;
  lastError: string | null;
  /** 0-based index of the step that broke on the last failed run. */
  lastBrokenStep: number | null;
  /** Who ran it last: a person (replay) or an agent (run_workflow / MCP). */
  lastRunBy: "user" | "agent" | null;
}

export interface SavedFlow {
  id: string;
  name: string;
  /** Where replay begins; the first navigate. */
  startUrl: string;
  steps: FlowStep[];
  createdAt: number;
  updatedAt: number;
  /** What the workflow does, shown to people and (fenced, as data) to the agent. */
  description: string;
  origin: FlowOrigin;
  /** The agent run it was saved from, when origin is "agent". */
  sourceRunId: string | null;
  /** Hosts it applies to (lowercase, no "www."); subdomains match too. */
  sites: string[];
  params: FlowParam[];
  usage: FlowUsage;
}

export function emptyUsage(): FlowUsage {
  return { runs: 0, ok: 0, failed: 0, lastRunAt: null, lastStatus: null, lastError: null, lastBrokenStep: null, lastRunBy: null };
}

export const MAX_FLOWS = 50;
export const MAX_STEPS_PER_FLOW = 200;
export const MAX_FLOW_NAME = 120;
export const MAX_STEP_VALUE = 2000;
export const MAX_LABEL = 160;
export const MAX_SELECTOR = 400;
/** Safety ceiling on one flow's serialized size, to bound the per-profile store. */
export const MAX_FLOW_BYTES = 256 * 1024;

export function clampName(name: string, fallback = "Recorded flow"): string {
  const trimmed = (name || "").replace(/\s+/g, " ").trim().slice(0, MAX_FLOW_NAME);
  return trimmed || fallback;
}

function clampIndex(index: number, length: number): number {
  if (!Number.isFinite(index) || index < 0) return 0;
  return Math.min(Math.floor(index), length - 1);
}

/** Minimal shape of a page_snapshot element needed to resolve a recorded target. */
export interface SnapElement {
  ref: string;
  role: string;
  name: string;
}

/**
 * Resolve a recorded target to a live element ref from a fresh snapshot, or null when nothing on the
 * page matches. Exact (role, name) first, then (name only) as a fallback for pages whose role
 * computation drifted; `index` picks among repeats and is clamped so a shrunk list still resolves.
 */
export function resolveTargetRef(elements: readonly SnapElement[], target: FlowTarget): string | null {
  // Stored names are clamped to 120 chars, so compare the live names the same way.
  const nameOf = (e: SnapElement): string => e.name.slice(0, 120);
  const exact = elements.filter((e) => e.role === target.role && nameOf(e) === target.name);
  if (exact.length > 0) return exact[clampIndex(target.index, exact.length)]!.ref;
  if (target.name) {
    const byName = elements.filter((e) => nameOf(e) === target.name);
    if (byName.length > 0) return byName[clampIndex(target.index, byName.length)]!.ref;
  }
  return null;
}

/** The tool call a step maps to, used for the risky-action classification and for execution. */
export function stepToToolCall(step: FlowStep): { tool: string; input: unknown; elementName: string } {
  if (step.kind === "navigate") return { tool: "navigate", input: { url: step.url }, elementName: "" };
  const elementName = step.target?.name ?? "";
  if (step.kind === "type") return { tool: "type", input: { ref: "e0", text: step.value ?? "", submit: step.submit === true }, elementName };
  return { tool: "click", input: { ref: "e0" }, elementName };
}

function hostOf(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

/** A human label for a recorded target ("Buy now button", "Search textbox"). */
export function describeTarget(target: FlowTarget): string {
  const name = target.name ? `“${target.name}”` : `a ${target.role || target.tag}`;
  return `${name}`;
}

/** Build the display label for a step (also used as the fallback when the recorder omits one). */
export function labelForStep(step: Pick<FlowStep, "kind" | "url" | "target" | "value" | "submit" | "secret">): string {
  if (step.kind === "navigate") return `Go to ${hostOf(step.url)}`;
  if (step.kind === "type") {
    const where = step.target ? describeTarget(step.target) : "a field";
    if (step.secret) return `Enter your secret into ${where}${step.submit ? " and submit" : ""}`;
    const value = step.value ? ` "${step.value.slice(0, 40)}"` : "";
    return `Type${value} into ${where}${step.submit ? " and submit" : ""}`;
  }
  return `Click ${step.target ? describeTarget(step.target) : "an element"}`;
}
