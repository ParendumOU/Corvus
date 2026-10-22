import type { SyncStateStorage } from "@corvus/shared";
import { deriveKeys, signRequest, toBase64, type SignRequestInput, type SyncKeys } from "@corvus/sync-core";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { buildServer, type ServerOptions } from "../src/app.js";

export const PHRASE_A = `${"abandon ".repeat(23)}art`;
export const PHRASE_B = `${"zoo ".repeat(23)}vote`;
export const KEYS_A: SyncKeys = deriveKeys(PHRASE_A);
export const KEYS_B: SyncKeys = deriveKeys(PHRASE_B);
export const DEV_1 = "device-1111";
export const DEV_2 = "device-2222";

export function makeServer(opts: Partial<ServerOptions> = {}): Promise<FastifyInstance> {
  return buildServer({ dbPath: ":memory:", ...opts });
}

export interface SignedOptions {
  body?: unknown;
  rawBody?: string;
  sign?: Partial<SignRequestInput>;
  keys?: SyncKeys;
  authorization?: string;
}

export function signed(
  app: FastifyInstance,
  keys: SyncKeys,
  device: string,
  method: "GET" | "POST" | "DELETE",
  path: string,
  opts: SignedOptions = {},
): Promise<LightMyRequestResponse> {
  const payload = opts.rawBody ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body));
  const bytes = payload === undefined ? undefined : new TextEncoder().encode(payload);
  const authorization =
    opts.authorization ?? signRequest(opts.keys ?? keys, device, { method, path, body: bytes, ...opts.sign });
  const headers: Record<string, string> = { authorization };
  if (payload !== undefined) headers["content-type"] = "application/json";
  return app.inject({ method, url: path, headers, payload });
}

export async function registerChain(app: FastifyInstance, keys: SyncKeys, ...devices: string[]): Promise<void> {
  const chain = await signed(app, keys, devices[0] ?? DEV_1, "POST", "/v1/chains", {
    body: { chainId: keys.chainId, publicKey: toBase64(keys.authPublicKey) },
  });
  if (chain.statusCode >= 300) throw new Error(`chain create failed: ${chain.body}`);
  for (const id of devices) {
    const res = await signed(app, keys, id, "POST", `/v1/chains/${keys.chainId}/devices`, {
      body: { id, name: `Device ${id}`, platform: "linux" },
    });
    if (res.statusCode >= 300) throw new Error(`device register failed: ${res.body}`);
  }
}

export function memoryStorage(): SyncStateStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    async get(key) {
      return data.get(key);
    },
    async set(key, value) {
      data.set(key, value);
    },
  };
}
