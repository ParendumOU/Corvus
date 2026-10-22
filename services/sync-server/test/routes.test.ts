import type { EncryptedRecord, SyncCollection, SyncPullResponse, SyncPushResponse } from "@corvus/shared";
import { signRequest, toBase64 } from "@corvus/sync-core";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { DEV_1, DEV_2, KEYS_A, KEYS_B, makeServer, registerChain, signed } from "./helpers.js";

const A = KEYS_A.chainId;
const records = `/v1/chains/${A}/records`;

function rec(id: string, version: number, deviceId = DEV_1, extra: Partial<EncryptedRecord> = {}): EncryptedRecord {
  return { id, collection: "bookmarks", version, deviceId, deleted: false, ciphertext: toBase64(Buffer.from(`ct-${id}-${version}-${deviceId}`)), updatedAt: 0, ...extra };
}

async function push(app: FastifyInstance, recs: EncryptedRecord[], device = DEV_1) {
  const res = await signed(app, KEYS_A, device, "POST", records, { body: { records: recs } });
  return { status: res.statusCode, body: res.json() as SyncPushResponse & { error?: string } };
}

async function pull(app: FastifyInstance, since = 0, collection?: SyncCollection, device = DEV_1) {
  const res = await signed(app, KEYS_A, device, "GET", `${records}?since=${since}${collection ? `&collection=${collection}` : ""}`);
  return { status: res.statusCode, body: res.json() as SyncPullResponse };
}

let app: FastifyInstance;
afterEach(async () => {
  await app?.close();
});

describe("health", () => {
  it("responds without auth", async () => {
    app = await makeServer();
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });
});

describe("authentication", () => {
  it("rejects missing, malformed and foreign-key signatures", async () => {
    app = await makeServer();
    await registerChain(app, KEYS_A, DEV_1);

    const none = await app.inject({ method: "GET", url: records });
    expect(none.statusCode).toBe(401);
    expect(none.json().error).toBe("unauthorized");

    const bearer = await signed(app, KEYS_A, DEV_1, "GET", records, { authorization: "Bearer abc" });
    expect(bearer.statusCode).toBe(401);

    // Signed with chain B's key while claiming chain A.
    const forged = await signed(app, KEYS_A, DEV_1, "GET", records, {
      authorization: signRequest(KEYS_B, DEV_1, { method: "GET", path: records }).replace(KEYS_B.chainId, A),
    });
    expect(forged.statusCode).toBe(401);
    expect(forged.json().error).toBe("bad_signature");
  });

  it("binds the signature to the body and path", async () => {
    app = await makeServer();
    await registerChain(app, KEYS_A, DEV_1);
    const body = JSON.stringify({ records: [rec("r1", 1)] });
    const auth = signRequest(KEYS_A, DEV_1, { method: "POST", path: records, body: new TextEncoder().encode(body) });
    const tampered = await signed(app, KEYS_A, DEV_1, "POST", records, {
      rawBody: body.replace('"version":1', '"version":2'),
      authorization: auth,
    });
    expect(tampered.json().error).toBe("bad_signature");

    const pathAuth = signRequest(KEYS_A, DEV_1, { method: "GET", path: `${records}?since=0` });
    const otherQuery = await signed(app, KEYS_A, DEV_1, "GET", `${records}?since=5`, { authorization: pathAuth });
    expect(otherQuery.json().error).toBe("bad_signature");
  });

  it("enforces the clock skew window", async () => {
    const clock = Date.now();
    app = await makeServer({ now: () => clock });
    await registerChain(app, KEYS_A, DEV_1);

    const old = await signed(app, KEYS_A, DEV_1, "GET", records, { sign: { ts: clock - 5 * 60_000 - 1 } });
    expect(old.statusCode).toBe(401);
    expect(old.json().error).toBe("clock_skew");
    const future = await signed(app, KEYS_A, DEV_1, "GET", records, { sign: { ts: clock + 5 * 60_000 + 1 } });
    expect(future.json().error).toBe("clock_skew");
    const ok = await signed(app, KEYS_A, DEV_1, "GET", records, { sign: { ts: clock - 4 * 60_000 } });
    expect(ok.statusCode).toBe(200);
  });

  it("rejects replayed requests", async () => {
    app = await makeServer();
    await registerChain(app, KEYS_A, DEV_1);
    const authorization = signRequest(KEYS_A, DEV_1, { method: "GET", path: records });
    expect((await signed(app, KEYS_A, DEV_1, "GET", records, { authorization })).statusCode).toBe(200);
    const again = await signed(app, KEYS_A, DEV_1, "GET", records, { authorization });
    expect(again.statusCode).toBe(401);
    expect(again.json().error).toBe("replayed");
  });

  it("requires a registered device for data routes", async () => {
    app = await makeServer();
    await registerChain(app, KEYS_A, DEV_1);
    const res = await signed(app, KEYS_A, DEV_2, "GET", records);
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("device_not_registered");
  });

  it("returns 404 for unknown chains and 401 on chain mismatch", async () => {
    app = await makeServer();
    const res = await signed(app, KEYS_A, DEV_1, "GET", records);
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("chain_not_found");

    await registerChain(app, KEYS_A, DEV_1);
    await registerChain(app, KEYS_B, DEV_1);
    const cross = await signed(app, KEYS_B, DEV_1, "GET", records);
    expect(cross.statusCode).toBe(401);
    expect(cross.json().error).toBe("chain_mismatch");
  });
});

describe("chain and device registration", () => {
  it("creates chains idempotently and validates chainId derivation", async () => {
    app = await makeServer();
    const body = { chainId: A, publicKey: toBase64(KEYS_A.authPublicKey) };
    expect((await signed(app, KEYS_A, DEV_1, "POST", "/v1/chains", { body })).statusCode).toBe(201);
    expect((await signed(app, KEYS_A, DEV_1, "POST", "/v1/chains", { body })).statusCode).toBe(200);

    const wrongKey = await signed(app, KEYS_B, DEV_1, "POST", "/v1/chains", {
      body: { chainId: KEYS_B.chainId, publicKey: toBase64(KEYS_A.authPublicKey) },
    });
    expect(wrongKey.statusCode).toBe(400);
    expect(wrongKey.json().error).toBe("invalid_chain");

    // Valid body for chain B, but signed with key A.
    const notOwner = await signed(app, KEYS_A, DEV_1, "POST", "/v1/chains", {
      body: { chainId: KEYS_B.chainId, publicKey: toBase64(KEYS_B.authPublicKey) },
      authorization: signRequest(KEYS_A, DEV_1, {
        method: "POST",
        path: "/v1/chains",
        body: new TextEncoder().encode(JSON.stringify({ chainId: KEYS_B.chainId, publicKey: toBase64(KEYS_B.authPublicKey) })),
      }).replace(A, KEYS_B.chainId),
    });
    expect(notOwner.json().error).toBe("bad_signature");
  });

  it("registers, lists and removes devices; removed ids stay revoked", async () => {
    app = await makeServer();
    await registerChain(app, KEYS_A, DEV_1, DEV_2);
    const list = await signed(app, KEYS_A, DEV_1, "GET", `/v1/chains/${A}/devices`);
    expect(list.json().devices.map((d: { id: string }) => d.id)).toEqual([DEV_1, DEV_2]);
    expect(list.json().devices[0]).toMatchObject({ name: `Device ${DEV_1}`, platform: "linux" });

    const mismatch = await signed(app, KEYS_A, DEV_1, "POST", `/v1/chains/${A}/devices`, {
      body: { id: DEV_2, name: "x", platform: "y" },
    });
    expect(mismatch.json().error).toBe("device_mismatch");

    expect((await signed(app, KEYS_A, DEV_1, "DELETE", `/v1/chains/${A}/devices/${DEV_2}`)).statusCode).toBe(204);
    expect((await signed(app, KEYS_A, DEV_1, "DELETE", `/v1/chains/${A}/devices/${DEV_2}`)).statusCode).toBe(404);
    const after = await signed(app, KEYS_A, DEV_1, "GET", `/v1/chains/${A}/devices`);
    expect(after.json().devices.map((d: { id: string }) => d.id)).toEqual([DEV_1]);

    const removed = await pull(app, 0, undefined, DEV_2);
    expect(removed.status).toBe(403);
    expect((removed.body as unknown as { error: string }).error).toBe("device_removed");
    const rejoin = await signed(app, KEYS_A, DEV_2, "POST", `/v1/chains/${A}/devices`, {
      body: { id: DEV_2, name: "again", platform: "linux" },
    });
    expect(rejoin.statusCode).toBe(403);
  });

  it("limits devices per chain", async () => {
    app = await makeServer({ maxDevicesPerChain: 1 });
    await registerChain(app, KEYS_A, DEV_1);
    const res = await signed(app, KEYS_A, DEV_2, "POST", `/v1/chains/${A}/devices`, {
      body: { id: DEV_2, name: "two", platform: "linux" },
    });
    expect(res.statusCode).toBe(413);
  });
});

describe("push / pull", () => {
  it("applies last-writer-wins with deviceId tie-break and returns conflicts", async () => {
    app = await makeServer();
    await registerChain(app, KEYS_A, DEV_1, DEV_2);

    expect((await push(app, [rec("r1", 1, DEV_2)], DEV_2)).body.accepted).toEqual(["r1"]);
    // Same version, lower deviceId -> conflict with the stored record.
    const tieLoss = await push(app, [rec("r1", 1, DEV_1)]);
    expect(tieLoss.body.accepted).toEqual([]);
    expect(tieLoss.body.conflicts).toHaveLength(1);
    expect(tieLoss.body.conflicts[0]).toMatchObject({ id: "r1", version: 1, deviceId: DEV_2 });
    // Exact re-push is idempotent.
    expect((await push(app, [rec("r1", 1, DEV_2)], DEV_2)).body.accepted).toEqual(["r1"]);
    // Higher version wins regardless of device.
    expect((await push(app, [rec("r1", 2, DEV_1)])).body.accepted).toEqual(["r1"]);
    // Stale version loses.
    const stale = await push(app, [rec("r1", 1, DEV_2, { ciphertext: "QUJD" })], DEV_2);
    expect(stale.body.conflicts[0]).toMatchObject({ version: 2, deviceId: DEV_1 });
    // Same version, higher deviceId wins the tie.
    expect((await push(app, [rec("r1", 2, DEV_2)], DEV_2)).body.accepted).toEqual(["r1"]);

    const { body } = await pull(app);
    expect(body.records).toHaveLength(1);
    expect(body.records[0]).toMatchObject({ id: "r1", version: 2, deviceId: DEV_2 });
    expect(body.records[0]!.updatedAt).toBeGreaterThan(0);
  });

  it("rejects records attributed to another device and invalid payloads", async () => {
    app = await makeServer();
    await registerChain(app, KEYS_A, DEV_1);
    expect((await push(app, [rec("r1", 1, DEV_2)])).body.error).toBe("device_mismatch");
    expect((await push(app, [rec("r1", 0)])).status).toBe(400);
    expect((await push(app, [rec("r1", 1, DEV_1, { collection: "passwords" as SyncCollection })])).status).toBe(400);
    expect((await push(app, [rec("r1", 1, DEV_1, { ciphertext: "not base64!" })])).status).toBe(400);
    expect((await push(app, [rec("bad id/../", 1)])).status).toBe(400);
  });

  it("pages by server cursor and filters by collection", async () => {
    app = await makeServer();
    await registerChain(app, KEYS_A, DEV_1);
    const all = Array.from({ length: 1201 }, (_, i) => rec(`r${i}`, 1, DEV_1, { collection: i % 2 ? "history" : "bookmarks" }));
    for (let i = 0; i < all.length; i += 1000) {
      expect((await push(app, all.slice(i, i + 1000))).body.accepted).toHaveLength(Math.min(1000, all.length - i));
    }

    const p1 = await pull(app, 0);
    expect(p1.body.records).toHaveLength(500);
    expect(p1.body.hasMore).toBe(true);
    const p2 = await pull(app, p1.body.cursor);
    expect(p2.body.records).toHaveLength(500);
    expect(p2.body.hasMore).toBe(true);
    const p3 = await pull(app, p2.body.cursor);
    expect(p3.body.records).toHaveLength(201);
    expect(p3.body.hasMore).toBe(false);
    const ids = [...p1.body.records, ...p2.body.records, ...p3.body.records].map((r) => r.id);
    expect(new Set(ids).size).toBe(1201);

    const empty = await pull(app, p3.body.cursor);
    expect(empty.body).toEqual({ records: [], cursor: p3.body.cursor, hasMore: false });

    // Updating a record moves it after the cursor.
    await push(app, [rec("r0", 2)]);
    const delta = await pull(app, p3.body.cursor);
    expect(delta.body.records.map((r) => [r.id, r.version])).toEqual([["r0", 2]]);

    const history = await pull(app, 0, "history");
    expect(history.body.records.every((r) => r.collection === "history")).toBe(true);
    expect(history.body.records).toHaveLength(500);
  });

  it("stores and serves tombstones", async () => {
    app = await makeServer();
    await registerChain(app, KEYS_A, DEV_1);
    await push(app, [rec("r1", 1)]);
    const { body: first } = await pull(app);
    expect((await push(app, [rec("r1", 2, DEV_1, { deleted: true })])).body.accepted).toEqual(["r1"]);
    const { body } = await pull(app, first.cursor);
    expect(body.records).toHaveLength(1);
    expect(body.records[0]).toMatchObject({ id: "r1", version: 2, deleted: true });
  });

  it("enforces per-chain record and byte quotas atomically", async () => {
    app = await makeServer({ maxRecordsPerChain: 3, maxBytesPerChain: 1000 });
    await registerChain(app, KEYS_A, DEV_1);
    expect((await push(app, [rec("a", 1), rec("b", 1), rec("c", 1)])).status).toBe(200);
    const over = await push(app, [rec("c", 2), rec("d", 1)]);
    expect(over.status).toBe(413);
    expect(over.body.error).toBe("quota_exceeded");
    // Whole batch rolled back: "c" is still at version 1.
    const { body } = await pull(app);
    expect(body.records.find((r) => r.id === "c")!.version).toBe(1);
    // Updates that do not grow the chain are still allowed.
    expect((await push(app, [rec("c", 2)])).status).toBe(200);

    const big = await push(app, [rec("a", 2, DEV_1, { ciphertext: toBase64(Buffer.alloc(900)) })]);
    expect(big.status).toBe(413);
  });

  it("rejects bodies over the size limit", async () => {
    app = await makeServer();
    await registerChain(app, KEYS_A, DEV_1);
    const huge = rec("r1", 1, DEV_1, { ciphertext: toBase64(Buffer.alloc(1_600_000)) });
    const res = await push(app, [huge]);
    expect(res.status).toBe(413);
  });
});

describe("wipe", () => {
  it("deletes the chain, its devices and records", async () => {
    app = await makeServer();
    await registerChain(app, KEYS_A, DEV_1);
    await push(app, [rec("r1", 1)]);
    expect((await signed(app, KEYS_A, DEV_1, "DELETE", `/v1/chains/${A}`)).statusCode).toBe(204);
    expect((await pull(app)).status).toBe(404);

    await registerChain(app, KEYS_A, DEV_1);
    const { body } = await pull(app);
    expect(body.records).toEqual([]);
  });
});

describe("rate limits", () => {
  it("limits per IP", async () => {
    app = await makeServer({ ipRequestsPerMinute: 3 });
    for (let i = 0; i < 3; i++) expect((await app.inject({ method: "GET", url: records })).statusCode).toBe(401);
    const limited = await app.inject({ method: "GET", url: records });
    expect(limited.statusCode).toBe(429);
    expect(Number(limited.headers["retry-after"])).toBeGreaterThan(0);
    expect((await app.inject({ method: "GET", url: "/healthz" })).statusCode).toBe(200);
  });

  it("limits per chain", async () => {
    app = await makeServer({ chainRequestsPerMinute: 4 });
    await registerChain(app, KEYS_A, DEV_1); // 2 requests
    expect((await pull(app)).status).toBe(200);
    expect((await pull(app)).status).toBe(200);
    expect((await pull(app)).status).toBe(429);
  });
});
