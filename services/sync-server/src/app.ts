import type { SyncDeviceListResponse, SyncPullResponse, SyncPushResponse } from "@corvus/shared";
import {
  CHAIN_ID_RE,
  DEVICE_ID_RE,
  SYNC_COLLECTIONS,
  chainIdFromPublicKey,
  fromBase64,
  isBase64,
  parseAuthHeader,
  verifyRequestSignature,
  type AuthHeader,
} from "@corvus/sync-core";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest, type FastifyServerOptions } from "fastify";
import { z } from "zod";
import { QuotaExceededError, SyncStore, openDatabase } from "./db.js";
import { RateLimiter, ReplayCache } from "./limits.js";

type AuthMode = "chain-create" | "device-register" | "device";

declare module "fastify" {
  interface FastifyRequest {
    rawBody?: Buffer;
    auth?: { chainId: string; deviceId: string };
  }
  interface FastifyContextConfig {
    auth?: AuthMode;
  }
}

export interface ServerOptions {
  dbPath: string;
  maxRecordsPerChain?: number;
  maxBytesPerChain?: number;
  maxDevicesPerChain?: number;
  pageSize?: number;
  bodyLimit?: number;
  maxClockSkewMs?: number;
  replayTtlMs?: number;
  ipRequestsPerMinute?: number;
  chainRequestsPerMinute?: number;
  trustProxy?: boolean;
  logger?: FastifyServerOptions["logger"];
  /**
   * Answers only clients whose socket address passes this check (others get 403 before anything
   * else runs). Default: everyone. The sync server built into the desktop app allows only this
   * computer and private networks (see isPrivateAddress).
   */
  allowClient?: (address: string | undefined) => boolean;
  now?: () => number;
}

export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const recordIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const deviceIdSchema = z.string().regex(DEVICE_ID_RE);
const collectionSchema = z.enum(SYNC_COLLECTIONS);

const createChainBody = z.object({
  chainId: z.string().regex(CHAIN_ID_RE),
  publicKey: z.string().max(64),
});
const registerDeviceBody = z.object({
  id: deviceIdSchema,
  name: z.string().trim().min(1).max(64),
  platform: z.string().trim().min(1).max(32),
});
const pushBody = z.object({
  records: z
    .array(
      z.object({
        id: recordIdSchema,
        collection: collectionSchema,
        version: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
        deviceId: deviceIdSchema,
        deleted: z.boolean(),
        ciphertext: z.string().max(1_500_000).refine(isBase64, "ciphertext must be base64"),
        updatedAt: z.number().optional(),
      }),
    )
    .max(1000),
});
const pullQuery = z.object({
  since: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
  collection: collectionSchema.optional(),
});
const chainParams = z.object({ chainId: z.string().regex(CHAIN_ID_RE) });
const deviceParams = chainParams.extend({ deviceId: deviceIdSchema });

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const res = schema.safeParse(value);
  if (!res.success) {
    const issue = res.error.issues[0];
    throw new HttpError(400, "invalid_request", issue ? `${issue.path.join(".") || "body"}: ${issue.message}` : "Invalid request");
  }
  return res.data;
}

export async function buildServer(opts: ServerOptions): Promise<FastifyInstance> {
  const cfg = {
    maxRecords: opts.maxRecordsPerChain ?? 50_000,
    maxBytes: opts.maxBytesPerChain ?? 50 * 1024 * 1024,
    maxDevices: opts.maxDevicesPerChain ?? 50,
    pageSize: opts.pageSize ?? 500,
    skew: opts.maxClockSkewMs ?? 5 * 60_000,
  };
  const now = opts.now ?? Date.now;
  const db = openDatabase(opts.dbPath);
  const store = new SyncStore(db);
  const replay = new ReplayCache(opts.replayTtlMs ?? 10 * 60_000);
  const ipLimiter = new RateLimiter(opts.ipRequestsPerMinute ?? 600, 60_000);
  const chainLimiter = new RateLimiter(opts.chainRequestsPerMinute ?? 1200, 60_000);

  const app = Fastify({
    bodyLimit: opts.bodyLimit ?? 2 * 1024 * 1024,
    trustProxy: opts.trustProxy ?? false,
    logger: opts.logger ?? false,
  });
  app.addHook("onClose", async () => db.close());

  // Keep the exact bytes: the signature covers sha256(raw body).
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser("application/json", { parseAs: "buffer" }, (req, body: Buffer, done) => {
    req.rawBody = body;
    if (body.length === 0) return done(null, undefined);
    try {
      done(null, JSON.parse(body.toString("utf8")));
    } catch {
      done(new HttpError(400, "invalid_json", "Body is not valid JSON"), undefined);
    }
  });

  app.setErrorHandler((err: Error & { statusCode?: number; code?: string }, req, reply) => {
    if (err instanceof HttpError) return reply.code(err.statusCode).send({ error: err.code, message: err.message });
    if (err instanceof QuotaExceededError) return reply.code(413).send({ error: "quota_exceeded", message: err.message });
    const status = err.statusCode && err.statusCode >= 400 && err.statusCode < 500 ? err.statusCode : 500;
    if (status === 500) {
      req.log.error({ err: { message: err.message, code: err.code } }, "request failed");
      return reply.code(500).send({ error: "internal", message: "Internal server error" });
    }
    const code = status === 413 ? "payload_too_large" : status === 415 ? "unsupported_media_type" : "bad_request";
    return reply.code(status).send({ error: code, message: err.message });
  });
  app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: "not_found", message: "Route not found" }));

  const rateLimited = (reply: FastifyReply, retryMs: number) => {
    reply.header("retry-after", Math.ceil(retryMs / 1000));
    throw new HttpError(429, "rate_limited", "Too many requests");
  };

  const allowClient = opts.allowClient;
  if (allowClient) {
    app.addHook("onRequest", async (req) => {
      if (!allowClient(req.socket.remoteAddress)) throw new HttpError(403, "forbidden", "This sync server only answers devices on its local network");
    });
  }

  app.get("/healthz", async () => ({ ok: true }));

  app.register(
    async (v1) => {
      v1.addHook("onRequest", async (req, reply) => {
        const retry = ipLimiter.hit(req.ip, now());
        if (retry) rateLimited(reply, retry);
      });

      v1.addHook("preHandler", async (req: FastifyRequest, reply) => {
        const mode = req.routeOptions.config.auth ?? "device";
        const header = req.headers.authorization;
        const auth: AuthHeader | null = typeof header === "string" ? parseAuthHeader(header) : null;
        if (!auth) throw new HttpError(401, "unauthorized", "Missing or malformed Corvus-Sig authorization header");
        const t = now();
        if (Math.abs(t - auth.ts) > cfg.skew) throw new HttpError(401, "clock_skew", "Request timestamp outside the allowed window");

        let publicKey: Uint8Array | undefined;
        if (mode === "chain-create") {
          const body = parse(createChainBody, req.body);
          if (body.chainId !== auth.chain) throw new HttpError(401, "chain_mismatch", "Header chain does not match body");
          try {
            publicKey = fromBase64(body.publicKey);
          } catch {
            throw new HttpError(400, "invalid_request", "publicKey must be base64");
          }
          if (publicKey.length !== 32 || chainIdFromPublicKey(publicKey) !== body.chainId) {
            throw new HttpError(400, "invalid_chain", "chainId is not derived from publicKey");
          }
        } else {
          const { chainId } = parse(chainParams, req.params);
          if (chainId !== auth.chain) throw new HttpError(401, "chain_mismatch", "Header chain does not match path");
          publicKey = store.getChainKey(chainId);
          if (!publicKey) throw new HttpError(404, "chain_not_found", "Unknown sync chain");
        }

        if (!verifyRequestSignature(publicKey, auth, req.method, req.url, req.rawBody ?? new Uint8Array())) {
          throw new HttpError(401, "bad_signature", "Signature verification failed");
        }
        if (!replay.checkAndRemember(header as string, t)) throw new HttpError(401, "replayed", "Request signature already used");

        if (mode === "device") {
          const device = store.getDevice(auth.chain, auth.device);
          if (!device) throw new HttpError(403, "device_not_registered", "Device is not registered on this chain");
          if (device.removed) throw new HttpError(403, "device_removed", "Device was removed from this chain");
          store.touchDevice(auth.chain, auth.device, t);
        }
        const retry = chainLimiter.hit(auth.chain, t);
        if (retry) rateLimited(reply, retry);
        req.auth = { chainId: auth.chain, deviceId: auth.device };
      });

      v1.post("/chains", { config: { auth: "chain-create" } }, async (req, reply) => {
        const body = parse(createChainBody, req.body);
        const created = store.createChain(body.chainId, fromBase64(body.publicKey), now());
        return reply.code(created ? 201 : 200).send({ chainId: body.chainId });
      });

      v1.post("/chains/:chainId/devices", { config: { auth: "device-register" } }, async (req, reply) => {
        const { chainId, deviceId } = req.auth!;
        const body = parse(registerDeviceBody, req.body);
        if (body.id !== deviceId) throw new HttpError(400, "device_mismatch", "Body id must match the signing device");
        const existing = store.getDevice(chainId, deviceId);
        if (existing?.removed) throw new HttpError(403, "device_removed", "Device was removed from this chain");
        if (!existing && store.countActiveDevices(chainId) >= cfg.maxDevices) {
          throw new HttpError(413, "quota_exceeded", `A chain can have at most ${cfg.maxDevices} devices`);
        }
        return reply.code(existing ? 200 : 201).send(store.upsertDevice(chainId, body, now()));
      });

      v1.get("/chains/:chainId/devices", async (req): Promise<SyncDeviceListResponse> => {
        return { devices: store.listDevices(req.auth!.chainId), serverTime: now() };
      });

      v1.delete("/chains/:chainId/devices/:deviceId", async (req, reply) => {
        const { deviceId } = parse(deviceParams, req.params);
        if (!store.removeDevice(req.auth!.chainId, deviceId, now())) {
          throw new HttpError(404, "device_not_found", "Unknown device");
        }
        return reply.code(204).send();
      });

      v1.post("/chains/:chainId/records", async (req): Promise<SyncPushResponse> => {
        const { chainId, deviceId } = req.auth!;
        const { records } = parse(pushBody, req.body);
        if (records.some((r) => r.deviceId !== deviceId)) {
          throw new HttpError(400, "device_mismatch", "Records must be attributed to the signing device");
        }
        const t = now();
        const result = store.push(
          chainId,
          records.map((r) => ({ ...r, updatedAt: t })),
          t,
          { maxRecords: cfg.maxRecords, maxBytes: cfg.maxBytes },
        );
        return { ...result, serverTime: t };
      });

      v1.get("/chains/:chainId/records", async (req): Promise<SyncPullResponse> => {
        const query = parse(pullQuery, req.query);
        return store.pull(req.auth!.chainId, query.since, query.collection, cfg.pageSize);
      });

      v1.delete("/chains/:chainId", async (req, reply) => {
        store.deleteChain(req.auth!.chainId);
        return reply.code(204).send();
      });
    },
    { prefix: "/v1" },
  );

  return app;
}
