// Entry of the sync server built into Corvus ("This computer"): the same server as
// services/sync-server, in a utility process of its own so syncing never stalls the browser.
import { startEmbeddedServer, type EmbeddedServer } from "@corvus/sync-server/embedded";
import type { LocalServerReply, LocalServerRequest } from "./local-sync-server";

/** How often the same device address is reported (it is shown as "last reached from"). */
const CLIENT_REPORT_MS = 10_000;

let server: EmbeddedServer | null = null;
const reported = new Map<string, number>();
const reply = (msg: LocalServerReply): void => process.parentPort.postMessage(msg);

process.parentPort.on("message", (event) => {
  const msg = event.data as LocalServerRequest;
  if (msg.type === "stop") {
    void (server?.app.close() ?? Promise.resolve()).finally(() => process.exit(0));
    return;
  }
  if (server) return;
  void startEmbeddedServer({
    dbPath: msg.dbPath,
    remembered: msg.remembered,
    // Another device reaching this computer: tells Settings that the network lets it through.
    onRemoteClient: (address) => {
      const now = Date.now();
      if (now - (reported.get(address) ?? 0) < CLIENT_REPORT_MS) return;
      reported.set(address, now);
      reply({ type: "client", address, at: now });
    },
  })
    .then((started) => {
      server = started;
      reply({ type: "listening", port: started.port });
    })
    .catch((err: unknown) => reply({ type: "failed", error: err instanceof Error ? err.message : String(err) }));
});
