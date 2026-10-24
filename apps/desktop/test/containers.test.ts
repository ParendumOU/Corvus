import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ContainerStore } from "../src/main/containers";
import { DEFAULT_CONTAINERS, cleanContainerName, containerIdFor, containerPartition, reviveContainers } from "../src/shared/containers";
import { reviveSession, serializeWindow } from "../src/shared/session-state";

const dirs: string[] = [];
const tempDir = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "corvus-containers-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("container rules", () => {
  it("gives each container a partition of its profile's own", () => {
    expect(containerPartition("persist:profile-a", "work")).toBe("persist:profile-a-ctr-work");
    expect(containerPartition("persist:profile-a", "work")).not.toBe(containerPartition("persist:profile-b", "work"));
  });

  it("derives unique, partition-safe ids from names", () => {
    expect(containerIdFor("Side project", new Set())).toBe("side-project");
    expect(containerIdFor("Trabajo ñandú", new Set())).toBe("trabajo-nandu");
    expect(containerIdFor("Work", new Set(["work", "work-2"]))).toBe("work-3");
    expect(containerIdFor("!!!", new Set())).toBe("container");
  });

  it("cleans names and revives only well-formed containers", () => {
    expect(cleanContainerName("  Two   words ")).toBe("Two words");
    expect(cleanContainerName("   ")).toBeNull();
    expect(cleanContainerName("x".repeat(80))).toHaveLength(40);
    expect(reviveContainers(undefined)).toEqual(DEFAULT_CONTAINERS);
    expect(
      reviveContainers([
        { id: "work", name: "Work", color: "orange" },
        { id: "work", name: "Again", color: "red" },
        { id: "Bad Id", name: "Bad", color: "red" },
        { id: "odd", name: "Odd colour", color: "magenta" },
        { id: "noname", name: " " },
      ]),
    ).toEqual([
      { id: "work", name: "Work", color: "orange" },
      { id: "odd", name: "Odd colour", color: "grey" },
    ]);
  });
});

describe("container store", () => {
  it("starts with the default containers, and adds, renames, recolours and removes", () => {
    const dir = tempDir();
    const store = new ContainerStore(dir);
    expect(store.list().map((c) => c.id)).toEqual(["personal", "work", "shopping", "banking"]);
    let changes = 0;
    store.onChange(() => (changes += 1));
    const added = store.add("Side project", "purple");
    expect(added).toEqual({ id: "side-project", name: "Side project", color: "purple" });
    expect(store.update("side-project", { name: "Client A", color: "cyan" })).toEqual({ id: "side-project", name: "Client A", color: "cyan" });
    expect(() => store.update("side-project", { name: "  " })).toThrow();
    expect(() => store.add("", "blue")).toThrow();
    expect(store.remove("shopping")).toBe(true);
    expect(store.remove("shopping")).toBe(false);
    expect(changes).toBe(3);
    store.flush();
    expect(new ContainerStore(dir).list().map((c) => `${c.id}:${c.name}:${c.color}`)).toEqual([
      "personal:Personal:blue",
      "work:Work:orange",
      "banking:Banking:green",
      "side-project:Client A:cyan",
    ]);
  });
});

describe("container tabs in a saved session", () => {
  it("keep their container across a restart", () => {
    const saved = serializeWindow({
      profileId: "p",
      maximized: false,
      groups: [],
      tabs: [
        { url: "https://a.example/", title: "A", pinned: false, containerId: "work", active: true },
        { url: "https://b.example/", title: "B", pinned: false, active: false },
        { url: "https://c.example/", title: "C", pinned: false, containerId: "../evil", active: false },
      ],
    });
    expect(saved?.tabs.map((t) => t.containerId)).toEqual(["work", undefined, undefined]);
    const revived = reviveSession({ version: 1, savedAt: 1, windows: [saved] });
    expect(revived?.windows[0]?.tabs.map((t) => t.containerId)).toEqual(["work", undefined, undefined]);
  });
});
