import { describe, expect, it } from "vitest";
import {
  clampInterval,
  diffNormalized,
  fingerprint,
  isDue,
  isWatchableUrl,
  normalizeWatchText,
  selectDue,
  type Watch,
} from "../src/shared/page-watch";

const watch = (extra: Partial<Watch> = {}): Watch => ({
  id: "w",
  url: "https://example.com",
  title: "Example",
  intervalMinutes: 30,
  createdAt: 0,
  paused: false,
  lastCheckedAt: null,
  lastChangedAt: null,
  lastResult: "pending",
  fingerprint: null,
  baseline: "",
  changeSummary: "",
  unseen: false,
  ...extra,
});

describe("isWatchableUrl (SSRF guard)", () => {
  it("allows public http(s) URLs", () => {
    expect(isWatchableUrl("https://example.com/price")).toBe(true);
    expect(isWatchableUrl("http://shop.example.org/item?id=3")).toBe(true);
    expect(isWatchableUrl("https://8.8.8.8/")).toBe(true);
  });
  it("rejects non-http(s) schemes", () => {
    for (const u of ["ftp://example.com", "file:///etc/passwd", "corvus://settings/", "javascript:alert(1)", "data:text/html,x"]) {
      expect(isWatchableUrl(u), u).toBe(false);
    }
  });
  it("rejects loopback, private and link-local literals", () => {
    for (const u of [
      "http://localhost/",
      "http://localhost:3000/",
      "http://dev.localhost/",
      "http://service.internal/",
      "http://printer.local/",
      "http://127.0.0.1/",
      "http://127.5.5.5/",
      "http://10.0.0.1/",
      "http://192.168.1.1/",
      "http://172.16.9.9/",
      "http://169.254.169.254/latest/meta-data/",
      "http://100.100.0.1/",
      "http://[::1]/",
      "http://[fc00::1]/",
      "http://[fe80::1]/",
      "http://[::ffff:127.0.0.1]/",
    ]) {
      expect(isWatchableUrl(u), u).toBe(false);
    }
  });
  it("rejects garbage", () => {
    expect(isWatchableUrl("not a url")).toBe(false);
    expect(isWatchableUrl("")).toBe(false);
  });
});

describe("normalizeWatchText", () => {
  it("collapses whitespace, lowercases and drops blank lines", () => {
    expect(normalizeWatchText("  Hello   World \n\n\n  FOO  ")).toBe("hello world\nfoo");
  });
  it("strips volatile timestamps so a clock tick is not a change", () => {
    const a = normalizeWatchText("Price 9.99 updated 2024-01-01T10:00:00Z");
    const b = normalizeWatchText("Price 9.99 updated 2024-01-01T10:05:42Z");
    expect(a).toBe(b);
    const c = normalizeWatchText("Posted 3 minutes ago by Alice");
    const d = normalizeWatchText("Posted 8 minutes ago by Alice");
    expect(c).toBe(d);
  });
});

describe("diffNormalized / fingerprint", () => {
  it("reports no change on identical normalized text", () => {
    const text = normalizeWatchText("In stock\nPrice 9.99");
    expect(diffNormalized(text, text)).toEqual({ changed: false, added: [], removed: [] });
    expect(fingerprint(text)).toBe(fingerprint(text));
  });
  it("detects added and removed lines", () => {
    const before = normalizeWatchText("In stock\nPrice 9.99");
    const after = normalizeWatchText("Out of stock\nPrice 12.50");
    const diff = diffNormalized(before, after);
    expect(diff.changed).toBe(true);
    expect(diff.added).toContain("out of stock");
    expect(diff.removed).toContain("in stock");
    expect(fingerprint(before)).not.toBe(fingerprint(after));
  });
  it("whitespace-only / timestamp-only differences are not changes after normalization", () => {
    const before = normalizeWatchText("Release v1.0\nUpdated 2024-01-01T10:00:00Z");
    const after = normalizeWatchText("Release   v1.0\n\nUpdated 2024-01-01T23:59:59Z");
    expect(diffNormalized(before, after).changed).toBe(false);
  });
});

describe("scheduling", () => {
  it("clampInterval enforces the floor", () => {
    expect(clampInterval(1)).toBe(5);
    expect(clampInterval(45)).toBe(45);
    expect(clampInterval(Number.NaN)).toBe(5);
  });
  it("isDue respects paused, first-run and the interval", () => {
    expect(isDue(watch(), 0)).toBe(true);
    expect(isDue(watch({ paused: true }), 0)).toBe(false);
    expect(isDue(watch({ lastCheckedAt: 1_000_000 }), 1_000_000 + 10 * 60_000)).toBe(false);
    expect(isDue(watch({ lastCheckedAt: 1_000_000 }), 1_000_000 + 31 * 60_000)).toBe(true);
  });
  it("selectDue honours the concurrency cap and checks the stalest first", () => {
    const now = 100 * 60_000;
    const a = watch({ id: "a", lastCheckedAt: 0 }); // stalest
    const b = watch({ id: "b", lastCheckedAt: 10 * 60_000 });
    const c = watch({ id: "c", lastCheckedAt: 20 * 60_000 });
    const fresh = watch({ id: "d", lastCheckedAt: now }); // not due
    const picked = selectDue([fresh, c, b, a], { now, running: new Set(), maxConcurrent: 2 });
    expect(picked.map((w) => w.id)).toEqual(["a", "b"]);
    expect(selectDue([a, b, c], { now, running: new Set(["a"]), maxConcurrent: 2 }).map((w) => w.id)).toEqual(["b"]);
    expect(selectDue([a, b, c], { now, running: new Set(["a", "b"]), maxConcurrent: 2 })).toEqual([]);
  });
});
