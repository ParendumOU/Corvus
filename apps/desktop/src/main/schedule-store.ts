import crypto from "node:crypto";
import path from "node:path";
import {
  type AgentSchedule,
  type ScheduleRunRecord,
  HISTORY_LIMIT,
  clampInterval,
  clampMaxSteps,
  isValidCron,
  nextRun,
} from "../shared/schedule";
import type { ScheduleInput } from "../shared/schedule-ipc";
import { JsonFile } from "./json-file";

type Listener = () => void;

function reviveRun(raw: unknown): ScheduleRunRecord | null {
  const r = raw as Partial<ScheduleRunRecord> | null;
  if (!r || typeof r.id !== "string" || typeof r.startedAt !== "number") return null;
  const status = (["running", "awaiting-approval", "done", "error", "stopped", "cancelled"] as const).includes(r.status as never)
    ? (r.status as ScheduleRunRecord["status"])
    : "done";
  return {
    id: r.id,
    startedAt: r.startedAt,
    endedAt: typeof r.endedAt === "number" ? r.endedAt : null,
    status,
    summary: typeof r.summary === "string" ? r.summary : "",
    error: typeof r.error === "string" ? r.error : null,
    steps: typeof r.steps === "number" ? r.steps : 0,
    inputTokens: typeof r.inputTokens === "number" ? r.inputTokens : 0,
    outputTokens: typeof r.outputTokens === "number" ? r.outputTokens : 0,
  };
}

function isSchedule(v: unknown): v is AgentSchedule {
  const s = v as Partial<AgentSchedule> | null;
  return typeof s?.id === "string" && typeof s.task === "string" && (s.kind === "cron" || s.kind === "interval");
}

function revive(raw: unknown): AgentSchedule[] {
  if (!Array.isArray(raw)) return [];
  const now = Date.now();
  return raw.filter(isSchedule).map((s) => {
    const kind = s.kind === "interval" ? "interval" : "cron";
    const cron = typeof s.cron === "string" ? s.cron : "0 9 * * *";
    const intervalMinutes = clampInterval(typeof s.intervalMinutes === "number" ? s.intervalMinutes : 1440);
    const history = (Array.isArray(s.history) ? s.history : []).map(reviveRun).filter((r): r is ScheduleRunRecord => r !== null).slice(0, HISTORY_LIMIT);
    const paused = s.paused === true;
    const stored = typeof s.nextRunAt === "number" ? s.nextRunAt : null;
    return {
      id: s.id,
      name: typeof s.name === "string" && s.name ? s.name : "Scheduled task",
      task: s.task,
      kind,
      cron,
      intervalMinutes,
      paused,
      createdAt: typeof s.createdAt === "number" ? s.createdAt : now,
      // Recompute a missing next-run on load; keep a stored one (a past time fires once on the next tick).
      nextRunAt: paused ? stored : (stored ?? nextRun({ kind, cron, intervalMinutes }, now)),
      maxSteps: clampMaxSteps(typeof s.maxSteps === "number" ? s.maxSteps : 12),
      lastRun: s.lastRun ? reviveRun(s.lastRun) : null,
      history,
    };
  });
}

/** Scheduled agent tasks for one profile. Durable; the live run status is held by the runner. */
export class ScheduleStore {
  private readonly file: JsonFile<AgentSchedule[]>;
  private readonly listeners = new Set<Listener>();

  constructor(
    dir: string,
    private readonly maxSchedules: () => number,
  ) {
    this.file = JsonFile.load(path.join(dir, "schedules.json"), () => [], revive, 0);
  }

  onChange(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const l of this.listeners) l();
  }

  list(): AgentSchedule[] {
    return this.file.get();
  }

  get(id: string): AgentSchedule | undefined {
    return this.file.get().find((s) => s.id === id);
  }

  private commit(list: AgentSchedule[]): void {
    this.file.set(list);
    this.emit();
  }

  private mutate(id: string, fn: (s: AgentSchedule) => AgentSchedule): void {
    const list = this.file.get();
    if (!list.some((s) => s.id === id)) return;
    this.commit(list.map((s) => (s.id === id ? fn(s) : s)));
  }

  private normalizeInput(input: ScheduleInput): { kind: "cron" | "interval"; cron: string; intervalMinutes: number; name: string; task: string; maxSteps: number } {
    const kind = input.kind === "interval" ? "interval" : "cron";
    const cron = typeof input.cron === "string" && isValidCron(input.cron) ? input.cron.trim() : "0 9 * * *";
    return {
      kind,
      cron,
      intervalMinutes: clampInterval(input.intervalMinutes ?? 1440),
      name: (input.name || "Scheduled task").slice(0, 120),
      task: (input.task || "").slice(0, 4000),
      maxSteps: clampMaxSteps(input.maxSteps ?? 12),
    };
  }

  /** Create a schedule. Returns null when the per-profile cap is reached or the task is empty. */
  add(input: ScheduleInput): AgentSchedule | null {
    const list = this.file.get();
    if (list.length >= this.maxSchedules()) return null;
    const n = this.normalizeInput(input);
    if (!n.task.trim()) return null;
    const now = Date.now();
    const schedule: AgentSchedule = {
      id: crypto.randomUUID(),
      ...n,
      paused: false,
      createdAt: now,
      nextRunAt: nextRun(n, now),
      lastRun: null,
      history: [],
    };
    this.commit([...list, schedule]);
    return schedule;
  }

  update(id: string, input: ScheduleInput): void {
    const n = this.normalizeInput(input);
    this.mutate(id, (s) => ({ ...s, ...n, nextRunAt: s.paused ? s.nextRunAt : nextRun(n, Date.now()) }));
  }

  remove(id: string): void {
    this.commit(this.file.get().filter((s) => s.id !== id));
  }

  pause(id: string, paused: boolean): void {
    this.mutate(id, (s) => ({ ...s, paused, nextRunAt: paused ? s.nextRunAt : nextRun(s, Date.now()) }));
  }

  /** Mark due right now (corvus://schedules "Run now"). */
  runNow(id: string): void {
    this.mutate(id, (s) => ({ ...s, nextRunAt: Date.now() - 1 }));
  }

  /** Advance to the next planned run (called after a run completes). */
  reschedule(id: string): void {
    this.mutate(id, (s) => ({ ...s, nextRunAt: nextRun(s, Date.now()) }));
  }

  /** Set the live/last run record without touching history (while the run is in flight). */
  setLastRun(id: string, record: ScheduleRunRecord): void {
    this.mutate(id, (s) => ({ ...s, lastRun: record }));
  }

  /** Persist a completed run: store it as last, prepend to history and plan the next run. */
  finishRun(id: string, record: ScheduleRunRecord): void {
    this.mutate(id, (s) => ({
      ...s,
      lastRun: record,
      history: [record, ...s.history].slice(0, HISTORY_LIMIT),
      nextRunAt: s.paused ? s.nextRunAt : nextRun(s, Date.now()),
    }));
  }

  flush(): void {
    this.file.flush();
  }
}
