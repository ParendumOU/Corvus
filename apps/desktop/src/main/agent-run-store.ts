import path from "node:path";
import type { AgentMessage } from "@corvus/ai-engine";
import type { AgentRunStep } from "../shared/command-bar-ipc";
import {
  type AgentRunRecord,
  type AgentRunSource,
  type AgentRunStopReason,
  type StoredRunStatus,
  MAX_STORED_RUNS,
  isResumableStatus,
  statusOnLoad,
} from "../shared/agent-run";
import { reviveStep as reviveFlowStep } from "../shared/workflow";
import type { RunSiteHints } from "../shared/site-memory";
import { boundTranscript } from "./agent-transcript";
import { JsonFile } from "./json-file";

type Listener = () => void;

/** A persisted run plus the model transcript kept for resume (transcript never leaves the main process). */
export interface StoredAgentRun {
  id: string;
  task: string;
  source: AgentRunSource;
  status: StoredRunStatus;
  stopReason: AgentRunStopReason;
  steps: AgentRunStep[];
  finalText: string;
  error: string | null;
  stepCount: number;
  maxSteps: number;
  inputTokens: number;
  outputTokens: number;
  provider: string;
  model: string;
  startedAt: number;
  endedAt: number | null;
  transcript: AgentMessage[];
  siteHints?: RunSiteHints;
}

const STATUSES: readonly StoredRunStatus[] = ["running", "paused", "awaiting-approval", "done", "error", "stopped", "interrupted"];
const STOP_REASONS: readonly NonNullable<AgentRunStopReason>[] = ["done", "max_steps", "aborted", "error", "budget"];

function num(v: unknown, dflt: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : dflt;
}

function reviveSteps(raw: unknown): AgentRunStep[] {
  if (!Array.isArray(raw)) return [];
  const out: AgentRunStep[] = [];
  for (const s of raw) {
    const r = s as Partial<AgentRunStep> | null;
    if (!r || typeof r.id !== "string" || typeof r.kind !== "string") continue;
    out.push({
      id: r.id,
      kind: r.kind,
      summary: typeof r.summary === "string" ? r.summary : "",
      ...(typeof r.detail === "string" ? { detail: r.detail } : {}),
      status: r.status === "running" || r.status === "error" || r.status === "skipped" ? r.status : "ok",
      ...(typeof r.resultChars === "number" ? { resultChars: r.resultChars } : {}),
      at: num(r.at, 0),
      ...reviveAction(r.action),
    });
  }
  return out;
}

/** A captured workflow action survives a reload only if it is still a valid flow step. */
function reviveAction(raw: unknown): Pick<AgentRunStep, "action"> {
  if (!raw) return {};
  const step = reviveFlowStep({ ...(raw as object), label: "" });
  return step ? { action: step } : {};
}

function reviveTranscript(raw: unknown): AgentMessage[] {
  if (!Array.isArray(raw)) return [];
  const out: AgentMessage[] = [];
  for (const m of raw) {
    const r = m as Partial<AgentMessage> | null;
    if (!r || (r.role !== "user" && r.role !== "assistant") || !Array.isArray(r.content)) continue;
    const content = r.content.filter((c) => c && typeof (c as { type?: unknown }).type === "string");
    if (content.length) out.push({ role: r.role, content: content as AgentMessage["content"] });
  }
  return boundTranscript(out);
}

function reviveRun(raw: unknown): StoredAgentRun | null {
  const r = raw as Partial<StoredAgentRun> | null;
  if (!r || typeof r.id !== "string" || typeof r.task !== "string") return null;
  const status = STATUSES.includes(r.status as never) ? (r.status as StoredRunStatus) : "done";
  return {
    id: r.id,
    task: r.task,
    source: r.source === "scheduled" || r.source === "assist" ? r.source : "command-bar",
    status: statusOnLoad(status),
    stopReason: STOP_REASONS.includes(r.stopReason as never) ? (r.stopReason as AgentRunStopReason) : null,
    steps: reviveSteps(r.steps),
    finalText: typeof r.finalText === "string" ? r.finalText : "",
    error: typeof r.error === "string" ? r.error : null,
    stepCount: num(r.stepCount, 0),
    maxSteps: num(r.maxSteps, 0),
    inputTokens: num(r.inputTokens, 0),
    outputTokens: num(r.outputTokens, 0),
    provider: typeof r.provider === "string" ? r.provider : "",
    model: typeof r.model === "string" ? r.model : "",
    startedAt: num(r.startedAt, Date.now()),
    endedAt: typeof r.endedAt === "number" ? r.endedAt : null,
    transcript: reviveTranscript(r.transcript),
    ...reviveSiteHints(r.siteHints),
  };
}

function reviveSiteHints(raw: unknown): Pick<StoredAgentRun, "siteHints"> {
  const h = raw as Partial<RunSiteHints> | null;
  if (!h || typeof h !== "object" || typeof h.host !== "string") return {};
  return { siteHints: { host: h.host.slice(0, 253), hints: num(h.hints, 0), workflows: num(h.workflows, 0) } };
}

function revive(raw: unknown): StoredAgentRun[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(reviveRun).filter((r): r is StoredAgentRun => r !== null).slice(0, MAX_STORED_RUNS);
}

export function toRecordView(run: StoredAgentRun): AgentRunRecord {
  return {
    id: run.id,
    task: run.task,
    source: run.source,
    status: run.status,
    stopReason: run.stopReason,
    steps: run.steps,
    finalText: run.finalText,
    error: run.error,
    stepCount: run.stepCount,
    maxSteps: run.maxSteps,
    inputTokens: run.inputTokens,
    outputTokens: run.outputTokens,
    provider: run.provider,
    model: run.model,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    resumable: run.transcript.length > 0 && isResumableStatus(run.status, run.stopReason),
    ...(run.siteHints ? { siteHints: run.siteHints } : {}),
  };
}

/** Durable history of in-browser agent runs for one profile, newest first. Bounded in count and size. */
export class AgentRunStore {
  private readonly file: JsonFile<StoredAgentRun[]>;
  private readonly listeners = new Set<Listener>();

  constructor(dir: string) {
    this.file = JsonFile.load(path.join(dir, "agent-runs.json"), () => [], revive, 400);
  }

  onChange(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const l of this.listeners) l();
  }

  list(): StoredAgentRun[] {
    return this.file.get();
  }

  get(id: string): StoredAgentRun | undefined {
    return this.file.get().find((r) => r.id === id);
  }

  views(): AgentRunRecord[] {
    return this.file.get().map(toRecordView);
  }

  /** Insert or replace a run by id, keeping the list newest-first and capped. */
  private write(run: StoredAgentRun): void {
    const bounded: StoredAgentRun = { ...run, transcript: boundTranscript(run.transcript) };
    const rest = this.file.get().filter((r) => r.id !== bounded.id);
    const list = [bounded, ...rest].sort((a, b) => b.startedAt - a.startedAt).slice(0, MAX_STORED_RUNS);
    this.file.set(list);
  }

  /** Persist without notifying listeners (used for high-frequency mid-run updates). */
  save(run: StoredAgentRun): void {
    this.write(run);
  }

  /** Persist and notify listeners (used on meaningful transitions: start, tool steps, finish). */
  commit(run: StoredAgentRun): void {
    this.write(run);
    this.emit();
  }

  remove(id: string): AgentRunRecord[] {
    this.file.set(this.file.get().filter((r) => r.id !== id));
    this.emit();
    return this.views();
  }

  clear(): AgentRunRecord[] {
    this.file.set([]);
    this.emit();
    return this.views();
  }

  flush(): void {
    this.file.flush();
  }
}
