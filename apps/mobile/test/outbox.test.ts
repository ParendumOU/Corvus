import type { SyncStateStorage } from "@corvus/shared";
import { describe, expect, it } from "vitest";
import { Outbox, startOver } from "../src/lib/outbox";
import { Replica } from "../src/lib/replica";

function memory(): SyncStateStorage & { clear(): void } {
  const map = new Map<string, string>();
  return { get: async (k) => map.get(k), set: async (k, v) => void map.set(k, v), clear: () => map.clear() };
}

const ITEM = { id: "r1", url: "https://example.com/a", title: "A", addedAt: 1, readAt: 5 };

describe("changes waiting to be pushed", () => {
  it("pushes what the replica holds, and a record gone from it as a deletion", async () => {
    const replica = new Replica(memory(), "chain/");
    const outbox = new Outbox(memory(), "outbox");
    await replica.put("reading", ITEM.url, ITEM);
    await outbox.add("reading", ITEM.url);
    await outbox.add("bookmarks", "gone");
    expect(await outbox.items(replica)).toEqual([
      { collection: "reading", id: ITEM.url, payload: ITEM, deleted: false },
      { collection: "bookmarks", id: "gone", payload: null, deleted: true },
    ]);
  });

  it("keeps them as they were when the replica starts over empty, never turning them into deletions", async () => {
    const data = memory();
    let replica = new Replica(data, "chain/");
    const outbox = new Outbox(memory(), "outbox");
    // Marked read offline, and a bookmark removed offline.
    await replica.put("reading", ITEM.url, ITEM);
    await outbox.add("reading", ITEM.url);
    await outbox.add("bookmarks", "removed");

    await startOver(outbox, replica, async () => {
      data.clear();
      replica = new Replica(data, "chain/");
      return replica;
    });

    expect(await outbox.items(replica)).toEqual([
      { collection: "reading", id: ITEM.url, payload: ITEM, deleted: false },
      { collection: "bookmarks", id: "removed", payload: null, deleted: true },
    ]);
    // Saved, not only in the new replica's memory.
    expect((await new Replica(data, "chain/").records("reading"))[ITEM.url]).toEqual(ITEM);
  });

  it("never pushes a deletion for a record of a saved copy that cannot be read", async () => {
    const data = memory();
    const outbox = new Outbox(memory(), "outbox");
    await new Replica(data, "chain/").put("reading", ITEM.url, ITEM);
    await outbox.add("reading", ITEM.url);
    await data.set("chain/data/reading", '{"https://example.com/a": {"id":'); // cut short

    const replica = new Replica(data, "chain/");
    expect(await outbox.items(replica)).toEqual([]);
    expect(await outbox.size()).toBe(1);
    expect(await replica.unreadable("reading")).toBe(true);
  });

  it("drops, when starting over, a change whose record could not be read", async () => {
    const data = memory();
    const outbox = new Outbox(memory(), "outbox");
    await outbox.add("reading", ITEM.url);
    await data.set("chain/data/reading", "not json");
    let replica = new Replica(data, "chain/");

    await startOver(outbox, replica, async () => {
      data.clear();
      replica = new Replica(data, "chain/");
      return replica;
    });

    expect(await outbox.size()).toBe(0);
    expect(await outbox.items(replica)).toEqual([]);
  });
});
