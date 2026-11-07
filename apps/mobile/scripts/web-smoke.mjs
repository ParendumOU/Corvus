// Loads the web build (dist-web, from `pnpm export:web`) in a headless browser and checks its
// screens. Runs Electron (already in the monorepo for the desktop app) on a virtual display, like
// the desktop smoke test, in the Docker dev image. The smoke pairs with a sync server of its own,
// with a throwaway database: the chains it makes must never land on a real one (the Docker
// sync-server keeps the person's own data).
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const serverEntry = path.resolve(here, "../../../services/sync-server/dist/index.js");
if (!fs.existsSync(serverEntry)) {
  console.error(`[web-smoke] ${serverEntry} is missing: build the sync server first (pnpm -r build).`);
  process.exit(1);
}

const freePort = () =>
  new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "corvus-web-smoke-sync-"));
const port = await freePort();
const syncUrl = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, [serverEntry], {
  env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", CORVUS_SYNC_DB: path.join(dataDir, "sync.db"), LOG_LEVEL: "warn" },
  stdio: "inherit",
});
let up = false;
for (let i = 0; i < 100 && !up; i++) {
  await new Promise((r) => setTimeout(r, 100));
  up = await fetch(`${syncUrl}/healthz`).then((r) => r.ok, () => false);
}
const stopServer = () => {
  server.kill();
  fs.rmSync(dataDir, { recursive: true, force: true });
};
if (!up) {
  console.error("[web-smoke] the throwaway sync server did not start");
  stopServer();
  process.exit(1);
}

const electron = createRequire(import.meta.url)("electron");
const env = { ...process.env, CORVUS_SYNC_URL: syncUrl };
let xvfb = null;
if (!env.DISPLAY) {
  xvfb = spawn("Xvfb", [":98", "-screen", "0", "1280x1024x24"], { stdio: "ignore" });
  env.DISPLAY = ":98";
  await new Promise((r) => setTimeout(r, 1000));
}
const run = spawnSync(electron, ["--no-sandbox", "--disable-dev-shm-usage", path.join(here, "web-smoke-main.cjs")], { stdio: "inherit", env, timeout: 180_000 });
xvfb?.kill();
stopServer();
process.exit(run.status ?? 1);
