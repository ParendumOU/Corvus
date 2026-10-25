import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AgentRunStore } from "../src/main/agent-run-store";

describe("agent run captures", () => {
  it("are kept per step and go with their run", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "corvus-shots-"));
    try {
      const store = new AgentRunStore(dir);
      store.shots.save("run-1", "step-a", Buffer.from([0xff, 0xd8, 0xff]));
      store.shots.save("run-2", "step-b", Buffer.from([0xff, 0xd8, 0xff]));
      store.shots.save("../evil", "x", Buffer.from([1]));
      expect(Object.keys(store.shots.list("run-1"))).toEqual(["step-a"]);
      expect(store.shots.list("run-1")["step-a"]).toMatch(/^data:image\/jpeg;base64,/);
      store.remove("run-1");
      expect(store.shots.list("run-1")).toEqual({});
      expect(fs.existsSync(path.join(dir, "evil"))).toBe(false);
      // A new start drops captures of runs no longer in the history.
      new AgentRunStore(dir);
      expect(store.shots.list("run-2")).toEqual({});
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
