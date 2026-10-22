import type { SyncItem, SyncStateStorage } from "@corvus/shared";
import { SyncEngine, createSyncClient, type CorvusSyncClient, type SyncAdapter } from "@corvus/sync-core";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PHRASE_A, makeServer, memoryStorage } from "./helpers.js";

/**
 * Collections joining and leaving independently: clients that do not know a collection (Corvus
 * 0.2.0 has the same skip in SyncEngine.applyRemote), clients upgrading to one, a category turned
 * off and on again, local-only removals (`retain`), and servers that do not know a collection yet.
 */

let app: FastifyInstance;
let serverUrl: string;

beforeAll(async () => {
  app = await makeServer();
  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.server.address();
  if (!addr || typeof addr === "string") throw new Error("no address");
  serverUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await app.close();
});

beforeEach(async () => {
  // Every test starts from an empty chain.
  const c = createSyncClient({ serverUrl, phrase: PHRASE_A, deviceName: "Reset", platform: "test", storage: memoryStorage() });
  await c.register();
  await c.wipeChain();
});

interface Item {
  title: string;
}

type MapAdapter = SyncAdapter<Item> & { items: Map<string, Item>; joins: number };

function mapAdapter(extra: Partial<SyncAdapter<Item>> = {}): MapAdapter {
  const items = new Map<string, Item>();
  const adapter: MapAdapter = {
    items,
    joins: 0,
    list: () => [...items].map(([id, payload]) => ({ id, payload })),
    apply: (changes: SyncItem<Item>[]) => {
      for (const c of changes) {
        if (c.deleted) items.delete(c.id);
        else items.set(c.id, c.payload!);
      }
    },
    join: () => {
      adapter.joins++;
    },
    ...extra,
  };
  return adapter;
}

/** A device: one client + engine storage that survive "restarts" with a different adapter set. */
class Device {
  readonly clientStorage: SyncStateStorage = memoryStorage();
  readonly engineStorage: SyncStateStorage = memoryStorage();
  readonly client: CorvusSyncClient;

  constructor(name: string, fetchImpl?: typeof fetch) {
    this.client = createSyncClient({ serverUrl, phrase: PHRASE_A, deviceName: name, platform: "test", storage: this.clientStorage, ...(fetchImpl ? { fetch: fetchImpl } : {}) });
  }

  engine(adapters: ConstructorParameters<typeof SyncEngine>[0]["adapters"]): SyncEngine {
    return new SyncEngine({ client: this.client, storage: this.engineStorage, adapters });
  }
}

const QUIET = { applied: 0, pushed: 0, deleted: 0, conflicts: 0 };

describe("collections joining and leaving", () => {
  it("an older client ignores collections it does not know, without errors", async () => {
    const fresh = new Device("New");
    const old = new Device("Old 0.2.0");
    await fresh.client.register();
    await old.client.register();
    const newBookmarks = mapAdapter();
    const workflows = mapAdapter();
    const memory = mapAdapter();
    workflows.items.set("wf-1", { title: "Buy again" });
    memory.items.set("shop.example", { title: "hints" });
    newBookmarks.items.set("b1", { title: "Shared bookmark" });
    await fresh.engine({ bookmarks: newBookmarks, workflows, site_memory: memory }).sync();

    // The old client only knows bookmarks: the new records are pulled, decrypted and skipped.
    const oldBookmarks = mapAdapter();
    const oldEngine = old.engine({ bookmarks: oldBookmarks });
    const first = await oldEngine.sync();
    expect(first).toMatchObject({ applied: 1, conflicts: 0 });
    expect([...oldBookmarks.items.keys()]).toEqual(["b1"]);
    expect(await oldEngine.sync()).toEqual(QUIET);
    // And its own changes still sync both ways.
    oldBookmarks.items.set("b2", { title: "From the old client" });
    await oldEngine.sync();
    await fresh.engine({ bookmarks: newBookmarks, workflows, site_memory: memory }).sync();
    expect([...newBookmarks.items.keys()].sort()).toEqual(["b1", "b2"]);
  });

  it("a client upgrading to a collection catches up on records its older version skipped", async () => {
    const writer = new Device("Writer");
    const laggard = new Device("Laggard");
    await writer.client.register();
    await laggard.client.register();
    const wfWriter = mapAdapter();
    wfWriter.items.set("wf-1", { title: "Pushed while the laggard was old" });
    const writerEngine = writer.engine({ bookmarks: mapAdapter(), workflows: wfWriter });
    await writerEngine.sync();

    // The laggard runs the old version: it pulls (cursor moves past the workflow) and skips it.
    const bookmarks = mapAdapter();
    await laggard.engine({ bookmarks }).sync();
    expect(await laggard.client.cursor()).toBeGreaterThan(0);

    // After the upgrade, the new collection joins with a catch-up pull, then pushes its own.
    const wfLaggard = mapAdapter();
    wfLaggard.items.set("wf-2", { title: "Made on the laggard" });
    const upgraded = laggard.engine({ bookmarks, workflows: wfLaggard });
    await upgraded.sync();
    expect(wfLaggard.joins).toBe(1);
    expect([...wfLaggard.items.keys()].sort()).toEqual(["wf-1", "wf-2"]);
    await writerEngine.sync();
    expect([...wfWriter.items.keys()].sort()).toEqual(["wf-1", "wf-2"]);
    expect(await upgraded.sync()).toEqual(QUIET);
    expect(wfLaggard.joins).toBe(1);
  });

  it("a category turned off keeps local data; turned on again it merges like a new device", async () => {
    const a = new Device("A");
    const b = new Device("B");
    await a.client.register();
    await b.client.register();
    const wfA = mapAdapter();
    const wfB = mapAdapter();
    wfA.items.set("wf-1", { title: "One" });
    wfA.items.set("wf-2", { title: "Two" });
    const engineA = a.engine({ workflows: wfA });
    await engineA.sync();
    await b.engine({ workflows: wfB, bookmarks: mapAdapter() }).sync();
    expect(wfB.items.size).toBe(2);

    // B turns the category off: nothing of it moves, its local copy stays.
    const bOff = b.engine({ bookmarks: mapAdapter() });
    wfB.items.delete("wf-2"); // a local delete while off
    wfB.items.set("wf-3", { title: "Made while off" });
    await bOff.sync();
    wfA.items.set("wf-1", { title: "One, edited on A" });
    await engineA.sync();
    await bOff.sync();
    expect(wfB.items.get("wf-1")).toEqual({ title: "One" });
    await engineA.sync();
    expect([...wfA.items.keys()].sort()).toEqual(["wf-1", "wf-2"]);

    // Back on: a full merge. The remote edit arrives, the local addition goes up, and the delete
    // made while off stays local (the chain still has wf-2, so it comes back).
    const bOn = b.engine({ workflows: wfB, bookmarks: mapAdapter() });
    await bOn.sync();
    expect(wfB.items.get("wf-1")).toEqual({ title: "One, edited on A" });
    expect([...wfB.items.keys()].sort()).toEqual(["wf-1", "wf-2", "wf-3"]);
    await engineA.sync();
    expect([...wfA.items.keys()].sort()).toEqual(["wf-1", "wf-2", "wf-3"]);
    expect(await bOn.sync()).toEqual(QUIET);
    expect(await engineA.sync()).toEqual(QUIET);
  });

  it("an id dropped only locally (retain) is not deleted on the chain", async () => {
    const a = new Device("A");
    const b = new Device("B");
    await a.client.register();
    await b.client.register();
    const evicting = mapAdapter({ retain: (id) => id.startsWith("evict") });
    evicting.items.set("evict-1", { title: "Old host" });
    evicting.items.set("keep-1", { title: "Kept" });
    const engineA = a.engine({ site_memory: evicting });
    await engineA.sync();
    evicting.items.delete("evict-1"); // local cap
    evicting.items.delete("keep-1"); // a real deletion
    expect(await engineA.sync()).toMatchObject({ deleted: 1 });
    const other = mapAdapter();
    await b.engine({ site_memory: other }).sync();
    expect([...other.items.keys()]).toEqual(["evict-1"]);
  });
});

describe("servers that do not know a collection yet", () => {
  const LATE = new Set(["workflows", "site_memory"]);

  /** Answers like a 0.2.0 server: its zod enum rejects the whole request over one collection. */
  const oldServerFetch: typeof fetch = async (input, init) => {
    const url = String(input);
    const reject = (message: string) =>
      new Response(JSON.stringify({ error: "invalid_request", message }), { status: 400, headers: { "content-type": "application/json" } });
    const filter = /[?&]collection=([a-z_]+)/.exec(url)?.[1];
    if (filter && LATE.has(filter)) return reject(`collection: Invalid enum value. Expected 'bookmarks' | 'history', received '${filter}'`);
    if (init?.method === "POST" && url.endsWith("/records") && init.body) {
      const body = JSON.parse(new TextDecoder().decode(init.body as Uint8Array)) as { records: Array<{ collection: string }> };
      const idx = body.records.findIndex((r) => LATE.has(r.collection));
      if (idx >= 0) return reject(`records.${idx}.collection: Invalid enum value. Expected 'bookmarks' | 'history', received '${body.records[idx]!.collection}'`);
    }
    return fetch(input, init);
  };

  it("keeps syncing everything else and leaves the new collections local", async () => {
    const a = new Device("New client", oldServerFetch);
    const b = new Device("Other", oldServerFetch);
    await a.client.register();
    await b.client.register();
    // An existing device (already pulled once) so the joining collections try a catch-up pull too.
    const bookmarksA = mapAdapter();
    bookmarksA.items.set("b0", { title: "Before" });
    await a.engine({ bookmarks: bookmarksA }).sync();
    await a.engine({ bookmarks: bookmarksA }).sync();
    expect(await a.client.cursor()).toBeGreaterThan(0);

    const workflows = mapAdapter();
    const memory = mapAdapter();
    workflows.items.set("wf-1", { title: "Local only for now" });
    memory.items.set("shop.example", { title: "hints" });
    bookmarksA.items.set("b1", { title: "Still syncs" });
    const engineA = a.engine({ bookmarks: bookmarksA, workflows, site_memory: memory });
    expect(await engineA.sync()).toMatchObject({ pushed: 1, conflicts: 0 });
    expect([...a.client.unsupported()].sort()).toEqual(["site_memory", "workflows"]);
    expect(await engineA.sync()).toEqual(QUIET);
    expect(workflows.items.size).toBe(1);

    const bookmarksB = mapAdapter();
    const wfB = mapAdapter();
    wfB.items.set("wf-b", { title: "Also local" });
    bookmarksB.items.set("b-b", { title: "Pushed in the same batch as a workflow" });
    // A fresh device pushes both in one batch: the server refuses it, the client retries without workflows.
    expect(await b.engine({ bookmarks: bookmarksB, workflows: wfB }).sync()).toMatchObject({ pushed: 1 });
    expect([...bookmarksB.items.keys()].sort()).toEqual(["b-b", "b0", "b1"]);
    expect([...b.client.unsupported()]).toEqual(["workflows"]);

    // Once the server knows them (an upgraded server), a restarted client syncs them.
    const upgraded = createSyncClient({ serverUrl, phrase: PHRASE_A, deviceName: "New client", platform: "test", storage: a.clientStorage });
    await new SyncEngine({ client: upgraded, storage: a.engineStorage, adapters: { bookmarks: bookmarksA, workflows, site_memory: memory } }).sync();
    const reader = new Device("Reader");
    await reader.client.register();
    const wfReader = mapAdapter();
    await reader.engine({ workflows: wfReader }).sync();
    expect([...wfReader.items.keys()]).toEqual(["wf-1"]);
  });
});
