import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CleanExitTracker } from "../src/main/clean-exit";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "corvus-clean-exit-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("CleanExitTracker", () => {
  it("treats a first-ever launch as clean", () => {
    expect(new CleanExitTracker(dir).wasUnclean()).toBe(false);
  });

  it("flags an unclean shutdown when the previous run never marked a clean exit", () => {
    const first = new CleanExitTracker(dir);
    expect(first.wasUnclean()).toBe(false);
    first.markRunning();
    // Simulate a crash: a new process starts without the previous one calling markCleanExit().
    const next = new CleanExitTracker(dir);
    expect(next.wasUnclean()).toBe(true);
  });

  it("clears the flag on a clean exit", () => {
    const first = new CleanExitTracker(dir);
    first.markRunning();
    first.markCleanExit();
    expect(new CleanExitTracker(dir).wasUnclean()).toBe(false);
  });

  it("re-arms on every launch", () => {
    new CleanExitTracker(dir).markRunning();
    expect(new CleanExitTracker(dir).wasUnclean()).toBe(true);
    const run2 = new CleanExitTracker(dir);
    run2.markRunning();
    run2.markCleanExit();
    expect(new CleanExitTracker(dir).wasUnclean()).toBe(false);
  });
});
