import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CommandHistoryStore } from "../src/main/command-history-store";
import { MAX_COMMAND_RECENTS, mergeRecents, parseCommandRecent, recentKey, type CommandRecent } from "../src/shared/command-history";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
const tmp = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "corvus-cmdhist-"));
  dirs.push(dir);
  return dir;
};
const recent = (id: string, text: string, at: number, kind: CommandRecent["kind"] = "agent"): CommandRecent => ({ id, kind, text, at });

describe("Command Bar recents", () => {
  it("parses what storage and other devices send, and nothing else", () => {
    expect(parseCommandRecent({ kind: "search", text: "  ravens  ", at: 5.4 }, "r1")).toEqual({ id: "r1", kind: "search", text: "ravens", at: 5 });
    expect(parseCommandRecent({ kind: "shell", text: "rm", at: 1 }, "r1")).toBeNull();
    expect(parseCommandRecent({ kind: "agent", text: "   ", at: 1 }, "r1")).toBeNull();
    expect(parseCommandRecent({ kind: "agent", text: "x", at: "now" }, "r1")).toBeNull();
    expect(parseCommandRecent({ kind: "agent", text: "x", at: 1 }, "")).toBeNull();
    expect(parseCommandRecent({ kind: "url", text: "y".repeat(5000), at: 1 }, "r1")!.text).toHaveLength(2000);
  });

  it("keeps the newest of each kind and text, newest first, up to the cap", () => {
    expect(recentKey("agent", "  Find  Flights ")).toBe(recentKey("agent", "find flights"));
    expect(recentKey("agent", "x")).not.toBe(recentKey("search", "x"));
    const merged = mergeRecents([recent("a", "Find flights", 1), recent("b", "find  flights", 3), recent("c", "find flights", 2, "search")]);
    expect(merged.map((r) => r.id)).toEqual(["b", "c"]);
    const many = Array.from({ length: MAX_COMMAND_RECENTS + 5 }, (_, i) => recent(`r${i}`, `task ${i}`, i));
    const capped = mergeRecents(many);
    expect(capped).toHaveLength(MAX_COMMAND_RECENTS);
    expect(capped[0]!.id).toBe(`r${MAX_COMMAND_RECENTS + 4}`);
  });
});

describe("CommandHistoryStore", () => {
  it("remembers runs, moves a repeat to the top, forgets and clears, across restarts", () => {
    const dir = tmp();
    let now = 100;
    const store = new CommandHistoryStore(dir, () => now++);
    store.add("agent", "Book a table for two");
    store.add("search", "raven facts");
    store.add("agent", "book a table  for two");
    expect(store.add("url", "   ")).toBeNull();
    expect(store.list().map((r) => [r.kind, r.text])).toEqual([
      ["agent", "book a table  for two"],
      ["search", "raven facts"],
    ]);
    store.flush();
    const again = new CommandHistoryStore(dir);
    expect(again.list()).toHaveLength(2);
    again.remove(again.list()[1]!.id);
    expect(again.list().map((r) => r.text)).toEqual(["book a table  for two"]);
    again.clear();
    expect(again.list()).toEqual([]);
  });

  it("applies other devices' entries and deletions, staying deduplicated and capped", () => {
    const store = new CommandHistoryStore(tmp(), () => 50);
    const mine = store.add("agent", "Compare umbrellas")!;
    let changes = 0;
    store.onChange(() => changes++);
    store.applyRemote([
      { id: "x1", recent: recent("x1", "compare umbrellas", 10) },
      { id: "x2", recent: recent("x2", "Track my parcel", 60) },
    ]);
    // The same task from the other device is older: this device's entry stays.
    expect(store.list().map((r) => r.id)).toEqual(["x2", mine.id]);
    store.applyRemote([{ id: "x2", recent: null }]);
    expect(store.list().map((r) => r.id)).toEqual([mine.id]);
    expect(changes).toBe(2);
    store.applyRemote(Array.from({ length: MAX_COMMAND_RECENTS + 3 }, (_, i) => ({ id: `y${i}`, recent: recent(`y${i}`, `remote ${i}`, 1000 + i) })));
    expect(store.list()).toHaveLength(MAX_COMMAND_RECENTS);
    expect(store.syncList()[0]).toEqual({ id: `y${MAX_COMMAND_RECENTS + 2}`, payload: { kind: "agent", text: `remote ${MAX_COMMAND_RECENTS + 2}`, at: 1000 + MAX_COMMAND_RECENTS + 2 } });
  });
});
