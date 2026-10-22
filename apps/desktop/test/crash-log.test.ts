import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ shell: { openPath: async () => "" } }));

import { CrashReporter } from "../src/main/crash-log";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "corvus-crash-log-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const logFile = (d: string): string => path.join(d, "crash-logs", "crash.log");

describe("CrashReporter", () => {
  it("writes nothing to disk while logging is off", () => {
    const reporter = new CrashReporter(dir, () => false);
    reporter.record("tab-renderer-gone", { url: "https://example.com" });
    expect(fs.existsSync(logFile(dir))).toBe(false);
  });

  it("appends one JSON line per record when enabled", () => {
    const reporter = new CrashReporter(dir, () => true);
    reporter.record("a", { url: "u1" });
    reporter.record("b", { url: "u2" });
    const lines = fs.readFileSync(logFile(dir), "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0]!) as { kind: string; url: string; at: string };
    expect(first.kind).toBe("a");
    expect(first.url).toBe("u1");
    expect(typeof first.at).toBe("string");
  });

  it("rotates and caps the number of files", () => {
    const reporter = new CrashReporter(dir, () => true, 200, 3);
    for (let i = 0; i < 60; i++) reporter.record("spin", { i, pad: "x".repeat(40) });
    expect(fs.existsSync(logFile(dir))).toBe(true);
    expect(fs.existsSync(`${logFile(dir)}.1`)).toBe(true);
    expect(fs.existsSync(`${logFile(dir)}.2`)).toBe(true);
    expect(fs.existsSync(`${logFile(dir)}.3`)).toBe(false);
    expect(fs.statSync(logFile(dir)).size).toBeLessThanOrEqual(200);
  });

  it("never throws from record even if the path is unwritable", () => {
    const reporter = new CrashReporter(path.join(dir, "nope\0bad"), () => true);
    expect(() => reporter.record("x", {})).not.toThrow();
  });
});
