// Smoke test against a running server, e.g. from the dev container:
//   docker compose run --rm dev sh -c "pnpm -r build && pnpm --filter @corvus/sync-server smoke"
// Uses CORVUS_SYNC_URL (default http://localhost:8787). Creates a throwaway chain and wipes it.
import { createSyncClient, generateRecoveryPhrase } from "@corvus/sync-core";

const serverUrl = process.env.CORVUS_SYNC_URL ?? "http://localhost:8787";
const memory = () => {
  const data = new Map();
  return { get: async (k) => data.get(k), set: async (k, v) => void data.set(k, v) };
};
const check = (cond, msg) => {
  if (!cond) throw new Error(`FAIL: ${msg}`);
  console.log(`ok   ${msg}`);
};

const health = await fetch(`${serverUrl}/healthz`);
check(health.ok, `GET /healthz -> ${health.status}`);

const phrase = generateRecoveryPhrase();
const a = createSyncClient({ serverUrl, phrase, deviceName: "smoke-a", platform: "linux", storage: memory() });
const b = createSyncClient({ serverUrl, phrase, deviceName: "smoke-b", platform: "linux", storage: memory() });
const other = createSyncClient({ serverUrl, phrase: generateRecoveryPhrase(), deviceName: "smoke-x", platform: "linux", storage: memory() });

await a.register();
await b.register();
await other.register();
check(true, `registered chain ${a.chainId} with 2 devices`);

await a.push([{ collection: "bookmarks", id: "smoke-1", payload: { title: "Smoke", url: "https://example.com/" }, deleted: false }]);
const got = await b.pull();
check(got.length === 1 && got[0].payload.title === "Smoke", "device B decrypted device A's bookmark");
check((await other.pull()).length === 0, "foreign chain sees nothing");
check((await a.listDevices()).length === 2, "listDevices returns 2 devices");

await a.wipeChain();
await other.wipeChain();
const after = await b.pull().then(() => "ok", (e) => e.code);
check(after === "chain_not_found", "wiped chain is gone");
console.log("SMOKE PASSED");
