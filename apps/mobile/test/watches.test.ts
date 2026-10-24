import { parseDeviceWatchStatus, type DeviceInfo } from "@corvus/shared";
import { describe, expect, it } from "vitest";
import { changedRecently, describeInterval, watchFor, watchList } from "../src/lib/watches";

const shop = "https://shop.example/item";
const news = "https://news.example/";
const def = (url: string, over: Record<string, unknown> = {}) => ({ url, title: url, intervalMinutes: 60, paused: false, createdAt: 1, ...over });
const status = (device: string, watches: unknown[]) => ({ device, platform: "win32", updatedAt: 1, watches });

describe("watched pages on the phone", () => {
  const devices: DeviceInfo[] = ["desk-0000000001", "laptop-00000001"].map((id) => ({ id, name: id, platform: "win32", lastSeen: 0 }));

  it("shows the freshest check of any computer, the most recently changed first", () => {
    const watches = { [shop]: def(shop, { condition: "price under 100" }), [news]: def(news, { title: "News" }), bad: { url: 1 } };
    const statuses = {
      "desk-0000000001": status("Desk", [
        { url: shop, lastCheckedAt: 50, lastChangedAt: 40, result: "changed", summary: "Old price", conditionMet: false },
        { url: news, lastCheckedAt: 10, lastChangedAt: 5, result: "ok", summary: "" },
      ]),
      "laptop-00000001": status("Laptop", [{ url: shop, lastCheckedAt: 90, lastChangedAt: 80, result: "changed", summary: "Price 89", conditionMet: true, conditionDetail: "Price: 89" }]),
      "gone-0000000001": status("Old PC", [{ url: news, lastCheckedAt: 999, lastChangedAt: 999, result: "changed", summary: "stale" }]),
    };
    const list = watchList(watches, statuses, devices);
    expect(list.map((w) => [w.url, w.status?.device, w.status?.summary])).toEqual([
      [shop, "Laptop", "Price 89"],
      [news, "Desk", ""],
    ]);
    expect(list[0]?.status).toMatchObject({ conditionMet: true, conditionDetail: "Price: 89" });
    // A day after the news page changed (at 5), the shop (at 80) still counts.
    expect(changedRecently(list, 86_400_000 + 30)).toBe(1);
    // Offline (no device list yet): every computer's status counts.
    expect(watchList(watches, statuses, []).find((w) => w.url === news)?.status?.device).toBe("Old PC");
  });

  it("makes a watch, or changes an existing one, from the phone", () => {
    expect(watchFor(shop, "", 15, "  the price   is under 100 ", 7)).toEqual({
      url: shop,
      title: "",
      intervalMinutes: 15,
      paused: false,
      createdAt: 7,
      condition: "the price is under 100",
    });
    const existing = { ...def(shop, { title: "Shop item", paused: true, condition: "old" }), createdAt: 3 };
    expect(watchFor(shop, "", 1440, "", 9, existing)).toEqual({ url: shop, title: "Shop item", intervalMinutes: 1440, paused: false, createdAt: 3 });
    expect(watchFor(shop, "", 60, "x".repeat(400), 9).condition).toHaveLength(300);
  });

  it("describes how often a page is checked", () => {
    expect([15, 60, 360, 1440, 2880].map(describeInterval)).toEqual(["every 15 min", "every hour", "every 6 hours", "every day", "every 2 days"]);
  });

  it("only trusts web pages and known results in a computer's status", () => {
    const parsed = parseDeviceWatchStatus(status("Desk", [{ url: "file:///x" }, { url: shop, result: "weird", lastCheckedAt: "now", summary: 5 }]));
    expect(parsed?.watches).toEqual([{ url: shop, lastCheckedAt: null, lastChangedAt: null, result: "pending", summary: "" }]);
    expect(parseDeviceWatchStatus({ device: "x" })).toBeNull();
  });
});
