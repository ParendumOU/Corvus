import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SyncConflictStore } from "../src/main/sync-conflict-store";
import { CONFLICT_COLLECTIONS, conflictName, conflictVersion, conflictView, freshVersion, isConflictCollection } from "../src/shared/sync-conflicts";

const DAY = 24 * 60 * 60 * 1000;
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
const tmpFile = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "corvus-conflicts-"));
  dirs.push(dir);
  return path.join(dir, "sync-conflicts.json");
};

describe("sync conflicts: what is kept and how it reads", () => {
  it("covers what people edit by hand, never saved logins or machine records", () => {
    expect([...CONFLICT_COLLECTIONS].sort()).toEqual(["annotations", "bookmarks", "reading", "settings", "watches", "workspaces"]);
    for (const c of ["credentials", "history", "open_tabs", "workflows", "site_memory", "asks"]) expect(isConflictCollection(c)).toBe(false);
  });

  it("names each record and sums up each version in one line", () => {
    expect(conflictName("settings", "appearance.theme", { v: "dark" })).toBe("appearance.theme");
    expect(conflictVersion("settings", { v: "dark" })).toBe('"dark"');
    expect(conflictVersion("settings", { v: { a: 1 } })).toBe('{"a":1}');
    expect(conflictName("bookmarks", "b1", { title: "", url: "https://raven.example/" })).toBe("https://raven.example/");
    expect(conflictVersion("bookmarks", { title: "Raven", url: "https://raven.example/" })).toBe("Raven — https://raven.example/");
    expect(conflictVersion("reading", { title: "An Article", url: "https://read.example/a" })).toBe("An Article — read.example");
    expect(conflictVersion("watches", { title: "Price", url: "https://shop.example/", condition: "under 40" })).toBe("Price · under 40");
    expect(conflictVersion("workspaces", { name: "Trip", tabs: [{ title: "Flights" }, { url: "https://hotel.example/x" }, { title: "Map" }, { title: "More" }] })).toBe(
      "Trip · Flights, hotel.example, Map",
    );
    expect(conflictName("annotations", "n1", { pageTitle: "", url: "https://blog.example/post" })).toBe("blog.example");
    expect(conflictVersion("annotations", { note: "", anchor: { quote: "the quoted words" } })).toBe("the quoted words");
    expect(conflictVersion("bookmarks", null)).toBeNull();
    expect(conflictVersion("bookmarks", { title: "x".repeat(400) })!.length).toBe(160);
  });

  it("brings a version back as a new change: a fresh updatedAt where the record has one", () => {
    expect(freshVersion({ title: "Raven", updatedAt: 5 }, 99)).toEqual({ title: "Raven", updatedAt: 99 });
    expect(freshVersion({ v: "dark" }, 99)).toEqual({ v: "dark" });
    expect(freshVersion(null, 99)).toBeNull();
  });

  it("names a record deleted on this device after the version in use", () => {
    const view = conflictView({ id: "c1", collection: "bookmarks", recordId: "b1", local: null, remote: { title: "Raven", url: "https://raven.example/" }, at: 5 });
    expect(view).toEqual({ id: "c1", collection: "bookmarks", name: "Raven", local: null, remote: "Raven — https://raven.example/", at: 5 });
  });
});

describe("SyncConflictStore", () => {
  it("keeps the newest conflict per record, newest first, across restarts", () => {
    const file = tmpFile();
    let now = 1_000_000;
    const store = new SyncConflictStore(file, () => now);
    store.add({ collection: "bookmarks", id: "b1", local: { title: "Mine" }, remote: { title: "Theirs" } });
    now += 10;
    store.add({ collection: "settings", id: "appearance.theme", local: { v: "light" }, remote: { v: "dark" } });
    now += 10;
    store.add({ collection: "bookmarks", id: "b1", local: { title: "Mine again" }, remote: { title: "Theirs again" } });
    store.add({ collection: "credentials", id: "secret", local: { password: "x" }, remote: null });
    const listed = new SyncConflictStore(file, () => now).list();
    expect(listed.map((c) => [c.collection, c.recordId, (c.local as { title?: string }).title ?? null])).toEqual([
      ["bookmarks", "b1", "Mine again"],
      ["settings", "appearance.theme", null],
    ]);
    expect(fs.readFileSync(file, "utf8")).not.toContain("password");
  });

  it("takes a conflict out once the person decides, and forgets old ones", () => {
    let now = 1_000_000;
    const store = new SyncConflictStore(tmpFile(), () => now);
    store.add({ collection: "reading", id: "https://read.example/a", local: null, remote: { title: "A" } });
    store.add({ collection: "watches", id: "https://shop.example/", local: { title: "Price" }, remote: null });
    const [first] = store.list();
    expect(store.take(first!.id)?.collection).toBe("watches");
    expect(store.take(first!.id)).toBeNull();
    expect(store.list()).toHaveLength(1);
    now += 31 * DAY;
    expect(store.list()).toEqual([]);
  });
});
