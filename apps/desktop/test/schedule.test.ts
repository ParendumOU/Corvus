import { describe, expect, it } from "vitest";
import {
  type AgentSchedule,
  clampInterval,
  describeSchedule,
  isDue,
  isValidCron,
  nextCronAfter,
  nextRun,
  parseCron,
  selectDueSchedules,
} from "../src/shared/schedule";

function at(y: number, mo: number, d: number, h: number, mi: number): number {
  return new Date(y, mo - 1, d, h, mi, 0, 0).getTime();
}

function schedule(partial: Partial<AgentSchedule>): AgentSchedule {
  return {
    id: "s1",
    name: "Test",
    task: "do thing",
    kind: "cron",
    cron: "0 9 * * *",
    intervalMinutes: 1440,
    paused: false,
    createdAt: 0,
    nextRunAt: null,
    maxSteps: 12,
    lastRun: null,
    history: [],
    ...partial,
  };
}

describe("parseCron", () => {
  it("accepts a standard daily expression", () => {
    expect(isValidCron("0 9 * * *")).toBe(true);
  });

  it("rejects malformed expressions", () => {
    for (const bad of ["", "0 9 * *", "0 9 * * * *", "60 9 * * *", "0 24 * * *", "0 9 32 * *", "0 9 * 13 *", "a b c d e", "*/0 * * * *"]) {
      expect(isValidCron(bad), bad).toBe(false);
    }
  });

  it("parses lists, ranges and steps", () => {
    const f = parseCron("0,30 9-17/2 * * 1-5");
    expect(f).not.toBeNull();
    expect([...f!.minute].sort((a, b) => a - b)).toEqual([0, 30]);
    expect([...f!.hour].sort((a, b) => a - b)).toEqual([9, 11, 13, 15, 17]);
    expect([...f!.dow].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
  });

  it("treats dow 7 as Sunday", () => {
    const f = parseCron("0 0 * * 7");
    expect(f!.dow.has(0)).toBe(true);
  });
});

describe("nextCronAfter", () => {
  it("finds the next daily 9am", () => {
    const from = at(2026, 3, 10, 8, 0);
    const next = nextCronAfter(parseCron("0 9 * * *")!, from);
    expect(next).toBe(at(2026, 3, 10, 9, 0));
  });

  it("rolls to the next day when past the time", () => {
    const from = at(2026, 3, 10, 9, 30);
    const next = nextCronAfter(parseCron("0 9 * * *")!, from);
    expect(next).toBe(at(2026, 3, 11, 9, 0));
  });

  it("is strictly after the from instant (no immediate re-fire)", () => {
    const from = at(2026, 3, 10, 9, 0);
    const next = nextCronAfter(parseCron("0 9 * * *")!, from);
    expect(next).toBe(at(2026, 3, 11, 9, 0));
  });

  it("honours the day-of-week restriction", () => {
    // 2026-03-10 is a Tuesday; next Monday 9am is 2026-03-16.
    const from = at(2026, 3, 10, 12, 0);
    const next = nextCronAfter(parseCron("0 9 * * 1")!, from);
    expect(next).toBe(at(2026, 3, 16, 9, 0));
  });

  it("fires on either day field when both are restricted (cron OR quirk)", () => {
    // Run on the 1st OR on Mondays. 2026-03-10 (Tue) -> next match is Mon 2026-03-16, not Apr 1.
    const from = at(2026, 3, 10, 12, 0);
    const next = nextCronAfter(parseCron("0 0 1 * 1")!, from);
    expect(next).toBe(at(2026, 3, 16, 0, 0));
  });
});

describe("nextRun", () => {
  it("adds the interval for interval schedules", () => {
    const from = at(2026, 3, 10, 9, 0);
    expect(nextRun({ kind: "interval", cron: "", intervalMinutes: 60 }, from)).toBe(from + 60 * 60_000);
  });

  it("returns null for an invalid cron", () => {
    expect(nextRun({ kind: "cron", cron: "nope", intervalMinutes: 0 }, 0)).toBeNull();
  });
});

describe("isDue / selectDueSchedules", () => {
  it("is due only when nextRunAt has passed and not paused", () => {
    const now = at(2026, 3, 10, 9, 0);
    expect(isDue(schedule({ nextRunAt: now - 1 }), now)).toBe(true);
    expect(isDue(schedule({ nextRunAt: now + 1 }), now)).toBe(false);
    expect(isDue(schedule({ nextRunAt: now - 1, paused: true }), now)).toBe(false);
    expect(isDue(schedule({ nextRunAt: null }), now)).toBe(false);
  });

  it("respects the concurrency cap and skips running ids", () => {
    const now = at(2026, 3, 10, 9, 0);
    const a = schedule({ id: "a", nextRunAt: now - 10 });
    const b = schedule({ id: "b", nextRunAt: now - 5 });
    const picked = selectDueSchedules([a, b], { now, running: new Set(), maxConcurrent: 1 });
    expect(picked.map((s) => s.id)).toEqual(["a"]);
    expect(selectDueSchedules([a, b], { now, running: new Set(["a"]), maxConcurrent: 1 })).toEqual([]);
  });
});

describe("clampInterval / describeSchedule", () => {
  it("clamps intervals to the allowed window", () => {
    expect(clampInterval(1)).toBe(5);
    expect(clampInterval(999999)).toBe(10080);
    expect(clampInterval(Number.NaN)).toBe(1440);
  });

  it("describes cadences", () => {
    expect(describeSchedule({ kind: "interval", cron: "", intervalMinutes: 1440 })).toBe("Every day");
    expect(describeSchedule({ kind: "interval", cron: "", intervalMinutes: 120 })).toBe("Every 2 hours");
    expect(describeSchedule({ kind: "cron", cron: "0 9 * * *", intervalMinutes: 0 })).toBe("Cron: 0 9 * * *");
    expect(describeSchedule({ kind: "cron", cron: "bad", intervalMinutes: 0 })).toBe("Invalid cron");
  });
});
