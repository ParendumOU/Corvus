import type { SyncCollection, SyncItem } from "@corvus/shared";
import { SYNC_COLLECTIONS, SyncEngine, SyncError, createSyncClient, type CorvusSyncClient, type SyncAdapter, type SyncConflict } from "@corvus/sync-core";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PHRASE_A, PHRASE_B, makeServer, memoryStorage } from "./helpers.js";

interface Bookmark {
  title: string;
  url: string;
}

let app: FastifyInstance;
let serverUrl: string;
const wire: string[] = [];

/** fetch wrapper that records everything sent to or received from the server. */
const recordingFetch: typeof fetch = async (input, init) => {
  if (init?.body) wire.push(new TextDecoder().decode(init.body as Uint8Array));
  wire.push(String(input), JSON.stringify(init?.headers ?? {}));
  const res = await fetch(input, init);
  wire.push(await res.clone().text());
  return res;
};

function client(phrase: string, name: string, storage = memoryStorage()): CorvusSyncClient {
  return createSyncClient({ serverUrl, phrase, deviceName: name, platform: "test", storage, fetch: recordingFetch });
}

function bookmarkStore(): SyncAdapter<Bookmark> & { items: Map<string, Bookmark> } {
  const items = new Map<string, Bookmark>();
  return {
    items,
    list: () => [...items].map(([id, payload]) => ({ id, payload })),
    apply: (changes: SyncItem<Bookmark>[]) => {
      for (const c of changes) {
        if (c.deleted) items.delete(c.id);
        else items.set(c.id, c.payload!);
      }
    },
  };
}

beforeAll(async () => {
  app = await makeServer();
  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.server.address();
  if (!addr || typeof addr === "string") throw new Error("no address");
  serverUrl = `http://127.0.0.1:${addr.port}/`;
});

afterAll(async () => {
  await app.close();
});

describe("end-to-end sync through a real server", () => {
  it("syncs bookmarks between two devices of one chain and isolates other chains", async () => {
    const laptop = client(PHRASE_A, "Laptop");
    const phone = client(PHRASE_A, "Phone");
    const stranger = client(PHRASE_B, "Stranger");
    expect(phone.chainId).toBe(laptop.chainId);
    expect(stranger.chainId).not.toBe(laptop.chainId);

    await laptop.register();
    await phone.register();
    await stranger.register();
    await laptop.register(); // idempotent

    const secretUrl = "https://very-private.example/diary?id=42";
    await laptop.push([
      { collection: "bookmarks", id: "bm-1", payload: { title: "Secret diary", url: secretUrl }, deleted: false },
      { collection: "history", id: secretUrl, payload: { visits: 3 }, deleted: false },
    ]);

    const received = await phone.pull();
    expect(received).toHaveLength(2);
    expect(received).toContainEqual({ collection: "bookmarks", id: "bm-1", payload: { title: "Secret diary", url: secretUrl }, deleted: false });
    expect(received).toContainEqual({ collection: "history", id: secretUrl, payload: { visits: 3 }, deleted: false });
    expect(await phone.pull()).toEqual([]); // cursor persisted
    expect(await laptop.pull()).toEqual([]); // own writes are not echoed back

    expect(await stranger.pull()).toEqual([]);

    // Delete on the phone, observe tombstone on the laptop.
    await phone.push([{ collection: "bookmarks", id: "bm-1", payload: null, deleted: true }]);
    expect(await laptop.pull()).toEqual([{ collection: "bookmarks", id: "bm-1", payload: null, deleted: true }]);

    // The server never saw plaintext titles, URLs or the phrase.
    const transcript = wire.join("\n");
    expect(transcript).not.toContain("Secret diary");
    expect(transcript).not.toContain("very-private");
    expect(transcript).not.toContain("abandon");

    const devices = await laptop.listDevices();
    expect(devices.map((d) => d.name).sort()).toEqual(["Laptop", "Phone"]);
    expect((await stranger.listDevices()).map((d) => d.name)).toEqual(["Stranger"]);
  });

  it("resolves concurrent edits last-writer-wins and surfaces conflicts", async () => {
    const a = client(PHRASE_B, "A");
    const b = client(PHRASE_B, "B");
    await a.register();
    await b.register();
    const item = (title: string): SyncItem => ({ collection: "settings", id: "theme", payload: { title }, deleted: false });

    expect((await a.push([item("dark")])).conflicts).toEqual([]); // v1 by A
    // B has not pulled, so it also writes v1; the tie is broken by deviceId.
    const bResult = await b.push([item("light")]);
    const [aId, bId] = [await a.getDeviceId(), await b.getDeviceId()];
    if (bId > aId) {
      expect(bResult.conflicts).toEqual([]);
    } else {
      expect(bResult.conflicts).toEqual([item("dark")]);
    }
    const winner = bId > aId ? "light" : "dark";
    expect((await a.pull()).concat(await b.pull()).every((i) => (i.payload as { title: string }).title === winner)).toBe(true);

    // Both now know v1; the next write is v2 and wins everywhere.
    await b.pull();
    await b.push([item("solarized")]);
    expect(await a.pull()).toEqual([item("solarized")]);
  });

  it("a delete pushed ahead wins over a device still writing the record, whatever the device ids", async () => {
    for (let round = 0; round < 6; round++) {
      const writer = client(PHRASE_B, `Writer ${round}`);
      const remover = client(PHRASE_B, `Remover ${round}`);
      await writer.register();
      await remover.register();
      const id = `answer-${round}`;
      const write = (answer: string): SyncItem => ({ collection: "asks", id, payload: { answer }, deleted: false });
      await writer.push([write("a")]);
      await remover.pull();
      // The remover saw the first write; the writer keeps writing without having seen the delete.
      await writer.push([write("ab")]);
      expect((await remover.push([{ collection: "asks", id, payload: null, deleted: true }], { deleteAhead: 1000 })).conflicts).toEqual([]);
      const late = await writer.push([write("abc")]);
      expect(late.conflicts).toEqual([{ collection: "asks", id, payload: null, deleted: true }]);
      expect((await remover.pull()).filter((i) => i.id === id)).toEqual([]);
    }
  });

  it("runs full SyncEngine cycles across devices, including restore on a new device", async () => {
    const phrase = PHRASE_A;
    const storeA = bookmarkStore();
    const storeB = bookmarkStore();
    const clientA = client(phrase, "Engine A");
    const clientB = client(phrase, "Engine B");
    await clientA.register();
    await clientA.wipeChain(); // start from an empty chain
    await clientA.register();
    await clientB.register();
    const engineA = new SyncEngine({ client: clientA, storage: memoryStorage(), adapters: { bookmarks: storeA } });
    const engineB = new SyncEngine({ client: clientB, storage: memoryStorage(), adapters: { bookmarks: storeB } });

    storeA.items.set("g1", { title: "Corvus", url: "https://corvus.example/" });
    storeA.items.set("g2", { title: "News", url: "https://news.example/" });
    expect(await engineA.sync()).toMatchObject({ pushed: 2, deleted: 0, applied: 0 });
    expect(await engineA.sync()).toEqual({ applied: 0, pushed: 0, deleted: 0, conflicts: 0 });

    expect(await engineB.sync()).toMatchObject({ applied: 2, pushed: 0 });
    expect([...storeB.items.keys()].sort()).toEqual(["g1", "g2"]);

    storeB.items.set("g1", { title: "Corvus (renamed)", url: "https://corvus.example/" });
    storeB.items.delete("g2");
    storeB.items.set("g3", { title: "Docs", url: "https://docs.example/" });
    expect(await engineB.sync()).toMatchObject({ pushed: 2, deleted: 1 });

    expect(await engineA.sync()).toMatchObject({ applied: 3, pushed: 0 });
    expect(Object.fromEntries(storeA.items)).toEqual(Object.fromEntries(storeB.items));

    // Restore: a brand-new device with only the phrase gets everything.
    const storeC = bookmarkStore();
    const clientC = client(phrase, "Restored");
    await clientC.register();
    await new SyncEngine({ client: clientC, storage: memoryStorage(), adapters: { bookmarks: storeC } }).sync();
    expect(Object.fromEntries(storeC.items)).toEqual(Object.fromEntries(storeA.items));
  });

  it("reports local changes that a remote change replaced (remote wins), and only those", async () => {
    const clientA = client(PHRASE_A, "Conflict A");
    const clientB = client(PHRASE_A, "Conflict B");
    await clientA.register();
    await clientA.wipeChain();
    await clientA.register();
    await clientB.register();
    const storeA = bookmarkStore();
    const storeB = bookmarkStore();
    const lostOnB: SyncConflict[] = [];
    const engineA = new SyncEngine({ client: clientA, storage: memoryStorage(), adapters: { bookmarks: storeA } });
    const engineB = new SyncEngine({
      client: clientB,
      storage: memoryStorage(),
      adapters: { bookmarks: storeB },
      conflictCollections: ["bookmarks"],
      onConflict: (c) => void lostOnB.push(c),
    });
    storeA.items.set("k1", { title: "One", url: "https://one.example/" });
    storeA.items.set("k2", { title: "Two", url: "https://two.example/" });
    storeA.items.set("k3", { title: "Three", url: "https://three.example/" });
    await engineA.sync();
    await engineB.sync();
    expect(lostOnB).toEqual([]);

    // Both change k1; B deletes k2 while A edits it; only A changes k3 (no conflict).
    storeA.items.set("k1", { title: "One (A)", url: "https://one.example/" });
    storeA.items.set("k2", { title: "Two (A)", url: "https://two.example/" });
    storeA.items.set("k3", { title: "Three (A)", url: "https://three.example/" });
    await engineA.sync();
    storeB.items.set("k1", { title: "One (B)", url: "https://one.example/" });
    storeB.items.delete("k2");
    await engineB.sync();

    expect(lostOnB.sort((x, y) => x.id.localeCompare(y.id))).toEqual([
      { collection: "bookmarks", id: "k1", local: { title: "One (B)", url: "https://one.example/" }, remote: { title: "One (A)", url: "https://one.example/" } },
      { collection: "bookmarks", id: "k2", local: null, remote: { title: "Two (A)", url: "https://two.example/" } },
    ]);
    // The remote versions won on B, and nothing B lost reached the chain.
    expect(storeB.items.get("k1")?.title).toBe("One (A)");
    expect(storeB.items.get("k2")?.title).toBe("Two (A)");
    await engineA.sync();
    expect(Object.fromEntries(storeA.items)).toEqual(Object.fromEntries(storeB.items));

    // Bringing B's version back is an ordinary local change: it syncs and wins on A.
    storeB.items.set("k1", lostOnB[0]!.local as Bookmark);
    await engineB.sync();
    await engineA.sync();
    expect(storeA.items.get("k1")?.title).toBe("One (B)");
    expect(lostOnB).toHaveLength(2);
  });

  it("converges every collection between two engines and never deletes items an adapter declines", async () => {
    const clientA = client(PHRASE_B, "Converge A");
    const clientB = client(PHRASE_B, "Converge B");
    await clientA.register();
    await clientA.wipeChain();
    await clientA.register();
    await clientB.register();

    const storesA = Object.fromEntries(SYNC_COLLECTIONS.map((c) => [c, bookmarkStore()])) as Record<SyncCollection, ReturnType<typeof bookmarkStore>>;
    const storesB = Object.fromEntries(SYNC_COLLECTIONS.map((c) => [c, bookmarkStore()])) as Record<SyncCollection, ReturnType<typeof bookmarkStore>>;
    // B runs an "older version" that does not know the setting "future.flag" and declines it.
    const settingsB = storesB.settings;
    const declining: SyncAdapter<Bookmark> = {
      list: settingsB.list,
      apply: (changes) => settingsB.apply(changes.filter((c) => c.id !== "future.flag")),
    };
    const engineA = new SyncEngine({ client: clientA, storage: memoryStorage(), adapters: storesA });
    const engineB = new SyncEngine({ client: clientB, storage: memoryStorage(), adapters: { ...storesB, settings: declining } });

    for (const c of SYNC_COLLECTIONS) storesA[c].items.set(`${c}-a`, { title: `A ${c}`, url: `https://a.example/${c}` });
    storesA.settings.items.set("future.flag", { title: "on", url: "" });
    for (const c of SYNC_COLLECTIONS) storesB[c].items.set(`${c}-b`, { title: `B ${c}`, url: `https://b.example/${c}` });

    await engineA.sync();
    await engineB.sync();
    await engineA.sync();
    // Quiescent: nothing left to exchange in either direction.
    expect(await engineB.sync()).toEqual({ applied: 0, pushed: 0, deleted: 0, conflicts: 0 });
    expect(await engineA.sync()).toEqual({ applied: 0, pushed: 0, deleted: 0, conflicts: 0 });

    for (const c of SYNC_COLLECTIONS) {
      const expected = c === "settings" ? [`${c}-a`, `${c}-b`, "future.flag"] : [`${c}-a`, `${c}-b`];
      expect([...storesA[c].items.keys()].sort()).toEqual(expected.sort());
    }
    expect([...settingsB.items.keys()].sort()).toEqual(["settings-a", "settings-b"]);
    expect(Object.fromEntries(storesB.bookmarks.items)).toEqual(Object.fromEntries(storesA.bookmarks.items));

    // The declined setting survives B's cycles and still reaches a fresh device.
    const storeC = bookmarkStore();
    const clientC = client(PHRASE_B, "Converge C");
    await clientC.register();
    await new SyncEngine({ client: clientC, storage: memoryStorage(), adapters: { settings: storeC } }).sync();
    expect(storeC.items.get("future.flag")).toEqual({ title: "on", url: "" });
  });

  it("locks out removed devices and wiped chains", async () => {
    const main = client(PHRASE_A, "Main");
    const lost = client(PHRASE_A, "Lost phone");
    await main.register();
    await lost.register();

    await main.removeDevice(await lost.getDeviceId());
    expect((await main.listDevices()).map((d) => d.name)).not.toContain("Lost phone");
    await expect(lost.pull()).rejects.toMatchObject({ status: 403, code: "device_removed" });
    await expect(lost.register()).rejects.toBeInstanceOf(SyncError);

    await main.push([{ collection: "profiles", id: "p1", payload: { name: "Work" }, deleted: false }]);
    await main.wipeChain();
    await expect(main.pull()).rejects.toMatchObject({ status: 404, code: "chain_not_found" });

    // Starting over on the same phrase yields an empty chain.
    await main.register();
    expect(await main.pull()).toEqual([]);
  });
});
