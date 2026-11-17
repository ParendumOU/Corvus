import type { SyncPullResponse, SyncStateStorage } from "@corvus/shared";
import { describe, expect, it } from "vitest";
import { SyncError, createSyncClient, generateRecoveryPhrase } from "../src/index.js";

const phrase = generateRecoveryPhrase();

function memory(): SyncStateStorage {
  const map = new Map<string, string>();
  return { get: async (k) => map.get(k), set: async (k, v) => void map.set(k, v) };
}

/** A server that answers every pull with the same empty page that claims there is more. */
function stuckServer(cursor: number) {
  let calls = 0;
  const fetch = (async () => {
    calls++;
    if (calls > 10) throw new Error("pulled the same page over and over");
    const page: SyncPullResponse = { records: [], cursor, hasMore: true };
    return new Response(JSON.stringify(page));
  }) as typeof globalThis.fetch;
  return { fetch, calls: () => calls };
}

const client = (fetch: typeof globalThis.fetch) =>
  createSyncClient({ serverUrl: "https://sync.invalid", phrase, deviceName: "Phone", platform: "android", storage: memory(), fetch });

describe("pull cursor", () => {
  it("stops a pull whose pages never move the cursor", async () => {
    const server = stuckServer(0);
    const err = await client(server.fetch).pullPages(() => undefined).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SyncError);
    expect((err as SyncError).code).toBe("bad_cursor");
    expect(server.calls()).toBe(1);
  });

  it("stops a collection pull whose pages never move the cursor", async () => {
    const server = stuckServer(5);
    const err = await client(server.fetch).pullCollectionSince("bookmarks", 5, () => undefined).catch((e: unknown) => e);
    expect((err as SyncError).code).toBe("bad_cursor");
    expect(server.calls()).toBe(1);
  });
});
