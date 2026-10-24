import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WatchStore } from "../src/main/watch-store";
import { CONDITION_CHARS, cleanCondition, conditionNotifies, isSyncedWatch, toSyncedWatch } from "../src/shared/page-watch";

const dirs: string[] = [];
const store = (): WatchStore => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "corvus-watch-"));
  dirs.push(dir);
  return new WatchStore(dir, () => 50);
};
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("watch conditions: rules", () => {
  it("cleans and caps a condition; blank means none", () => {
    expect(cleanCondition("  price   under\n150 € ")).toBe("price under 150 €");
    expect(cleanCondition("   ")).toBe("");
    expect(cleanCondition(42)).toBe("");
    expect(cleanCondition("x".repeat(500))).toHaveLength(CONDITION_CHARS);
  });

  it("notifies when the condition becomes true, not while it stays true", () => {
    expect(conditionNotifies(undefined, true)).toBe(true);
    expect(conditionNotifies(null, true)).toBe(true);
    expect(conditionNotifies(false, true)).toBe(true);
    expect(conditionNotifies(true, true)).toBe(false);
    expect(conditionNotifies(true, false)).toBe(false);
    expect(conditionNotifies(undefined, false)).toBe(false);
  });
});

describe("watch conditions: store and sync", () => {
  it("sets a condition (its state starting over) and clears it", () => {
    const s = store();
    const w = s.add({ url: "https://shop.example/p", title: "P", intervalMinutes: 30 })!;
    s.update(w.id, { conditionMet: true, conditionDetail: "Price: 9 €" });
    s.setCondition(w.id, "  the price is under 10 € ");
    expect(s.get(w.id)).toMatchObject({ condition: "the price is under 10 €" });
    expect(s.get(w.id)?.conditionMet).toBeUndefined();
    expect(s.views()[0]?.condition).toBe("the price is under 10 €");
    s.setCondition(w.id, "");
    expect(s.get(w.id)?.condition).toBeUndefined();
  });

  it("syncs the condition with the watch, and a changed one starts over on this device", () => {
    const s = store();
    const w = s.add({ url: "https://shop.example/p", title: "P", intervalMinutes: 30 })!;
    s.setCondition(w.id, "in stock");
    s.update(w.id, { conditionMet: false, conditionDetail: "Out of stock" });
    const synced = toSyncedWatch(s.get(w.id)!);
    expect(synced.condition).toBe("in stock");
    expect(isSyncedWatch(synced)).toBe(true);
    expect(isSyncedWatch({ ...synced, condition: 5 })).toBe(false);

    s.applyRemote([{ url: w.url, def: { ...synced, title: "Renamed" } }]);
    expect(s.get(w.id)).toMatchObject({ title: "Renamed", condition: "in stock", conditionMet: false });
    s.applyRemote([{ url: w.url, def: { ...synced, condition: "under 10 €" } }]);
    expect(s.get(w.id)).toMatchObject({ condition: "under 10 €" });
    expect(s.get(w.id)?.conditionMet).toBeUndefined();
    s.applyRemote([{ url: "https://other.example/", def: { ...synced, url: "https://other.example/", condition: "back in stock" } }]);
    expect(s.list().find((x) => x.url === "https://other.example/")?.condition).toBe("back in stock");
  });
});
