import net from "node:net";
import type { FastifyInstance } from "fastify";
import { buildServer, type ServerOptions } from "./app.js";
import { isPrivateAddress } from "./network.js";

export { buildServer, isPrivateAddress, type ServerOptions };

/** The port a sync server built into an app tries first (the Docker setup publishes 8797 too). */
export const EMBEDDED_PORT = 8797;
const FALLBACK_PORTS = 10;

/** Ports to try, in order: the one used last time, the default and the next few, then any free one (0). */
export function portCandidates(remembered?: number | null): number[] {
  const ports = [remembered, ...Array.from({ length: FALLBACK_PORTS }, (_, i) => EMBEDDED_PORT + i)].filter(
    (p): p is number => typeof p === "number" && Number.isInteger(p) && p > 0 && p < 65536,
  );
  return [...new Set(ports), 0];
}

function portFree(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once("error", () => resolve(false));
    probe.listen({ port, host, exclusive: true }, () => probe.close(() => resolve(true)));
  });
}

export interface EmbeddedServer {
  app: FastifyInstance;
  port: number;
}

/**
 * A sync server for an app to run on its own computer: answers only this computer and private
 * networks (isPrivateAddress), listens on every IPv4 address of the computer, on the first free port
 * of `portCandidates(remembered)`.
 */
export interface EmbeddedOptions extends ServerOptions {
  /** The port used last time (tried first). */
  remembered?: number | null;
  host?: string;
  /** Hears the address of each request from another device (not this computer), after it is answered. */
  onRemoteClient?: (address: string) => void;
}

const LOOPBACK = /^(::ffff:)?127.|^::1$/;

export async function startEmbeddedServer(opts: EmbeddedOptions): Promise<EmbeddedServer> {
  const { remembered, host = "0.0.0.0", onRemoteClient, ...server } = opts;
  const app = await buildServer({ allowClient: isPrivateAddress, ...server });
  if (onRemoteClient) {
    app.addHook("onResponse", async (req) => {
      const address = req.socket.remoteAddress;
      if (address && !LOOPBACK.test(address)) onRemoteClient(address.replace(/^::ffff:/, ""));
    });
  }
  try {
    for (const port of portCandidates(remembered)) {
      if (port !== 0 && !(await portFree(port, host))) continue;
      await app.listen({ port, host });
      const address = app.server.address();
      return { app, port: typeof address === "object" && address ? address.port : port };
    }
    throw new Error("No free port");
  } catch (err) {
    await app.close().catch(() => undefined);
    throw err;
  }
}
