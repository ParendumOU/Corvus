import { describe, expect, it } from "vitest";
import { dayLabel, groupByDay, historyList, searchHistory, timeOfDay } from "../src/lib/history";

// Local times, so the checks hold in any time zone.
const at = (month: number, day: number, hour: number, minute = 0, year = 2026) => new Date(year, month - 1, day, hour, minute).getTime();
const NOW = at(10, 24, 15);

describe("history from your devices", () => {
  const records: Record<string, unknown> = {
    "https://news.example/a": { url: "https://news.example/a", title: "Morning news", visitedAt: at(10, 24, 9, 5), visitCount: 3 },
    "https://docs.example/b": { url: "https://docs.example/b", title: "Docs page", visitedAt: at(10, 23, 22), visitCount: 1 },
    "https://shop.example/c": { url: "https://shop.example/c", title: "A shop", visitedAt: at(10, 20, 12), visitCount: 1 },
    "https://old.example/d": { url: "https://old.example/d", title: "Last year", visitedAt: at(12, 31, 8, 0, 2025), visitCount: 1 },
    "corvus://settings": { url: "corvus://settings", title: "Settings", visitedAt: at(10, 24, 14) },
    broken: { url: "https://x.example/" },
  };

  it("lists web pages only, most recent first", () => {
    expect(historyList(records).map((e) => e.title)).toEqual(["Morning news", "Docs page", "A shop", "Last year"]);
  });

  it("groups by day with friendly labels", () => {
    expect(dayLabel(at(10, 24, 1), NOW)).toBe("Today");
    expect(dayLabel(at(10, 23, 23, 59), NOW)).toBe("Yesterday");
    expect(dayLabel(at(10, 20, 12), NOW)).toBe("Tuesday 20 October");
    expect(dayLabel(at(12, 31, 8, 0, 2025), NOW)).toBe("Wednesday 31 December 2025");
    const days = groupByDay(historyList(records), NOW);
    expect(days.map((d) => [d.label, d.entries.length])).toEqual([
      ["Today", 1],
      ["Yesterday", 1],
      ["Tuesday 20 October", 1],
      ["Wednesday 31 December 2025", 1],
    ]);
    expect(timeOfDay(at(10, 24, 9, 5))).toBe("09:05");
  });

  it("searches titles and addresses", () => {
    const list = historyList(records);
    expect(searchHistory(list, "docs").map((e) => e.url)).toEqual(["https://docs.example/b"]);
    expect(searchHistory(list, "EXAMPLE shop").map((e) => e.url)).toEqual(["https://shop.example/c"]);
    expect(searchHistory(list, "  ")).toHaveLength(4);
  });
});
