import type { SyncStateStorage } from "@corvus/shared";
import { describe, expect, it } from "vitest";
import { SyncError, createSyncClient, generateRecoveryPhrase, withDeadline } from "../src/index.js";

const phrase = generateRecoveryPhrase();

function memory(): SyncStateStorage {
  const map = new Map<string, string>();
  return { get: async (k) => map.get(k), set: async (k, v) => void map.set(k, v) };
}

const never = <T>(): Promise<T> => new Promise<T>(() => undefined);

/** A fetch whose answer, or the body of it, never arrives; records the abort signal it was given. */
function stalledFetch(stage: "answer" | "body") {
  const signals: AbortSignal[] = [];
  const fetch = (async (_url: string, init?: RequestInit) => {
    if (init?.signal) signals.push(init.signal);
    if (stage === "answer") return never<Response>();
    // Headers arrived, the body never ends: what a stalled React Native / Expo fetch looks like.
    return { ok: true, status: 200, json: () => never<unknown>() } as unknown as Response;
  }) as typeof globalThis.fetch;
  return { fetch, signals };
}

const client = (fetch: typeof globalThis.fetch, requestTimeoutMs?: number) =>
  createSyncClient({ serverUrl: "https://sync.invalid", phrase, deviceName: "Phone", platform: "android", storage: memory(), fetch, ...(requestTimeoutMs ? { requestTimeoutMs } : {}) });

describe("request deadline", () => {
  it("gives up when the server never answers, and aborts the request", async () => {
    const { fetch, signals } = stalledFetch("answer");
    const err = await client(fetch, 50).listDevices().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SyncError);
    expect((err as SyncError).code).toBe("timeout");
    expect(signals[0]?.aborted).toBe(true);
  });

  it("gives up when the answer's body never finishes (a pull can never hang)", async () => {
    const { fetch } = stalledFetch("body");
    const started = Date.now();
    const err = await client(fetch, 50).pullPages(() => undefined).catch((e: unknown) => e);
    expect((err as SyncError).code).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("leaves requests alone when no deadline is set, and lets a timely answer through", async () => {
    let calls = 0;
    const fetch = (async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 20));
      return new Response(JSON.stringify({ devices: [] }));
    }) as typeof globalThis.fetch;
    expect(await client(fetch).listDevices()).toEqual([]);
    expect(await client(fetch, 1000).listDevices()).toEqual([]);
    expect(calls).toBe(2);
  });

  it("withDeadline settles like the work when it is in time", async () => {
    await expect(withDeadline(Promise.resolve(7), 50, () => new Error("late"))).resolves.toBe(7);
    await expect(withDeadline(Promise.reject(new Error("boom")), 50, () => new Error("late"))).rejects.toThrow("boom");
    await expect(withDeadline(never(), 20, () => new Error("late"))).rejects.toThrow("late");
  });
});
