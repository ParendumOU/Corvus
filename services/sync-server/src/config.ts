import { z } from "zod";
import type { ServerOptions } from "./app.js";

const int = (fallback: number) => z.coerce.number().int().positive().default(fallback);

const envSchema = z.object({
  PORT: int(8787),
  HOST: z.string().default("0.0.0.0"),
  CORVUS_SYNC_DB: z.string().min(1).default("./data/sync.db"),
  CORVUS_SYNC_MAX_RECORDS: int(50_000),
  CORVUS_SYNC_MAX_BYTES: int(50 * 1024 * 1024),
  CORVUS_SYNC_MAX_DEVICES: int(50),
  CORVUS_SYNC_RATE_IP: int(600),
  CORVUS_SYNC_RATE_CHAIN: int(1200),
  CORVUS_SYNC_TRUST_PROXY: z.enum(["0", "1", "true", "false"]).default("0"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
});

export interface Config {
  port: number;
  host: string;
  server: ServerOptions;
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const e = envSchema.parse(env);
  return {
    port: e.PORT,
    host: e.HOST,
    server: {
      dbPath: e.CORVUS_SYNC_DB,
      maxRecordsPerChain: e.CORVUS_SYNC_MAX_RECORDS,
      maxBytesPerChain: e.CORVUS_SYNC_MAX_BYTES,
      maxDevicesPerChain: e.CORVUS_SYNC_MAX_DEVICES,
      ipRequestsPerMinute: e.CORVUS_SYNC_RATE_IP,
      chainRequestsPerMinute: e.CORVUS_SYNC_RATE_CHAIN,
      trustProxy: e.CORVUS_SYNC_TRUST_PROXY === "1" || e.CORVUS_SYNC_TRUST_PROXY === "true",
      // Request logs carry method/url/status only; never headers or bodies.
      logger: { level: e.LOG_LEVEL, redact: ["req.headers.authorization"] },
    },
  };
}
