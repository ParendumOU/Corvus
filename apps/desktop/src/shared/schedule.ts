/**
 * Scheduled AI agent tasks: the durable schedule model, a small 5-field cron parser, next-run
 * computation and the due-selection that decides which schedules fire now (mirroring page-watch.ts's
 * selectDue, so both lean on the same single poll timer). Pure (no node/Electron imports) so it is
 * unit tested and safe for both tsconfig projects.
 */

export type ScheduleKind = "cron" | "interval";

export type RunStatus = "running" | "awaiting-approval" | "done" | "error" | "stopped" | "cancelled";

/** One finished (or in-flight) execution of a schedule, kept for the history list. */
export interface ScheduleRunRecord {
  id: string;
  startedAt: number;
  endedAt: number | null;
  status: RunStatus;
  /** The agent's closing summary (or a synthesized one). */
  summary: string;
  error: string | null;
  steps: number;
  inputTokens: number;
  outputTokens: number;
}

export interface AgentSchedule {
  id: string;
  /** Short label for the list. */
  name: string;
  /** The natural-language task handed to the agent. */
  task: string;
  kind: ScheduleKind;
  /** 5-field cron expression when kind === "cron". */
  cron: string;
  /** Minutes between runs when kind === "interval". */
  intervalMinutes: number;
  paused: boolean;
  createdAt: number;
  /** Epoch ms of the next planned run; null means "compute on load". */
  nextRunAt: number | null;
  /** Hard step cap for this schedule (clamped to the global cap at run time). */
  maxSteps: number;
  /** Most recent run (also the live one while running). */
  lastRun: ScheduleRunRecord | null;
  /** Recent runs, newest first, capped. */
  history: ScheduleRunRecord[];
}

export const MIN_INTERVAL_MINUTES = 5;
export const MAX_INTERVAL_MINUTES = 10080; // one week
export const DEFAULT_INTERVAL_MINUTES = 1440; // daily
export const HISTORY_LIMIT = 20;
export const DEFAULT_MAX_STEPS = 12;
export const MAX_SCHEDULES = 50;
/** One scheduled agent runs at a time across all profiles (heavy, foregrounds its tab on approval). */
export const MAX_CONCURRENT_RUNS = 1;

export function clampInterval(minutes: number): number {
  if (!Number.isFinite(minutes)) return DEFAULT_INTERVAL_MINUTES;
  return Math.max(MIN_INTERVAL_MINUTES, Math.min(MAX_INTERVAL_MINUTES, Math.round(minutes)));
}

export function clampMaxSteps(steps: number, cap = 50): number {
  if (!Number.isFinite(steps)) return DEFAULT_MAX_STEPS;
  return Math.max(1, Math.min(cap, Math.round(steps)));
}

// --------------------------------------------------------------------- cron

interface CronFields {
  minute: Set<number>;
  hour: Set<number>;
  dom: Set<number>;
  month: Set<number>;
  dow: Set<number>;
  /** Both day-of-month and day-of-week were restricted (cron OR quirk). */
  domRestricted: boolean;
  dowRestricted: boolean;
}

function parseField(spec: string, min: number, max: number): Set<number> | null {
  const out = new Set<number>();
  for (const partRaw of spec.split(",")) {
    const part = partRaw.trim();
    if (part === "") return null;
    let range = part;
    let step = 1;
    const slash = part.indexOf("/");
    if (slash !== -1) {
      range = part.slice(0, slash);
      step = Number(part.slice(slash + 1));
      if (!Number.isInteger(step) || step <= 0) return null;
    }
    let lo: number;
    let hi: number;
    if (range === "*") {
      lo = min;
      hi = max;
    } else {
      const dash = range.indexOf("-");
      if (dash === -1) {
        lo = hi = Number(range);
      } else {
        lo = Number(range.slice(0, dash));
        hi = Number(range.slice(dash + 1));
      }
      if (!Number.isInteger(lo) || !Number.isInteger(hi)) return null;
    }
    if (lo < min || hi > max || lo > hi) return null;
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out.size ? out : null;
}

/** Parse a standard 5-field cron expression, or null when malformed. */
export function parseCron(expr: string): CronFields | null {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [m, h, dom, mon, dowRaw] = parts as [string, string, string, string, string];
  const minute = parseField(m, 0, 59);
  const hour = parseField(h, 0, 23);
  const domSet = parseField(dom, 1, 31);
  const month = parseField(mon, 1, 12);
  // Day-of-week: 0-7 with both 0 and 7 meaning Sunday.
  const dowSet = parseField(dowRaw.replace(/7/g, "0"), 0, 6);
  if (!minute || !hour || !domSet || !month || !dowSet) return null;
  return {
    minute,
    hour,
    dom: domSet,
    month,
    dow: dowSet,
    domRestricted: dom.trim() !== "*",
    dowRestricted: dowRaw.trim() !== "*",
  };
}

export function isValidCron(expr: string): boolean {
  return parseCron(expr) !== null;
}

function matches(f: CronFields, d: Date): boolean {
  if (!f.minute.has(d.getMinutes())) return false;
  if (!f.hour.has(d.getHours())) return false;
  if (!f.month.has(d.getMonth() + 1)) return false;
  const domOk = f.dom.has(d.getDate());
  const dowOk = f.dow.has(d.getDay());
  // When both day fields are restricted, cron fires if EITHER matches; otherwise require the
  // restricted one (or any, when both are "*").
  if (f.domRestricted && f.dowRestricted) return domOk || dowOk;
  if (f.domRestricted) return domOk;
  if (f.dowRestricted) return dowOk;
  return true;
}

const MINUTE_MS = 60_000;

/** Next epoch-ms matching the cron expression strictly after `fromMs` (local time, minute precision). */
export function nextCronAfter(fields: CronFields, fromMs: number): number | null {
  const d = new Date(fromMs);
  d.setSeconds(0, 0);
  d.setTime(d.getTime() + MINUTE_MS);
  // Search up to ~366 days of minutes; enough for any valid 5-field schedule.
  for (let i = 0; i < 366 * 24 * 60; i++) {
    if (matches(fields, d)) return d.getTime();
    d.setTime(d.getTime() + MINUTE_MS);
  }
  return null;
}

/** Next planned run for a schedule after `from`, or null when a cron expression is invalid. */
export function nextRun(schedule: Pick<AgentSchedule, "kind" | "cron" | "intervalMinutes">, from: number): number | null {
  if (schedule.kind === "interval") return from + clampInterval(schedule.intervalMinutes) * MINUTE_MS;
  const fields = parseCron(schedule.cron);
  return fields ? nextCronAfter(fields, from) : null;
}

// --------------------------------------------------------------------- scheduling

export interface SelectOptions {
  now: number;
  /** Schedule ids currently running (not eligible again). */
  running: ReadonlySet<string>;
  maxConcurrent?: number;
}

/** Whether a schedule is due to fire now. */
export function isDue(schedule: AgentSchedule, now: number): boolean {
  if (schedule.paused) return false;
  if (schedule.nextRunAt === null) return false;
  return schedule.nextRunAt <= now;
}

/**
 * Pick the schedules to start now: those due and not already running, soonest-planned first, limited
 * so that running.size + picked.length <= maxConcurrent.
 */
export function selectDueSchedules(schedules: readonly AgentSchedule[], opts: SelectOptions): AgentSchedule[] {
  const max = opts.maxConcurrent ?? MAX_CONCURRENT_RUNS;
  const free = Math.max(0, max - opts.running.size);
  if (free === 0) return [];
  return schedules
    .filter((s) => !opts.running.has(s.id) && isDue(s, opts.now))
    .sort((a, b) => (a.nextRunAt ?? 0) - (b.nextRunAt ?? 0))
    .slice(0, free);
}

/** Human-readable cadence for the UI (does not throw on bad cron). */
export function describeSchedule(schedule: Pick<AgentSchedule, "kind" | "cron" | "intervalMinutes">): string {
  if (schedule.kind === "interval") {
    const m = clampInterval(schedule.intervalMinutes);
    if (m % 1440 === 0) return m === 1440 ? "Every day" : `Every ${m / 1440} days`;
    if (m % 60 === 0) return m === 60 ? "Every hour" : `Every ${m / 60} hours`;
    return `Every ${m} minutes`;
  }
  return isValidCron(schedule.cron) ? `Cron: ${schedule.cron.trim()}` : "Invalid cron";
}
