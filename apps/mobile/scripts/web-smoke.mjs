// Loads the web build (dist-web, from `pnpm export:web`) in a headless browser and checks its
// screens. Runs Electron (already in the monorepo for the desktop app) on a virtual display, like
// the desktop smoke test, in the Docker dev image.
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const electron = createRequire(import.meta.url)("electron");
const env = { ...process.env };
let xvfb = null;
if (!env.DISPLAY) {
  xvfb = spawn("Xvfb", [":98", "-screen", "0", "1280x1024x24"], { stdio: "ignore" });
  env.DISPLAY = ":98";
  await new Promise((r) => setTimeout(r, 1000));
}
const run = spawnSync(electron, ["--no-sandbox", "--disable-dev-shm-usage", path.join(here, "web-smoke-main.cjs")], { stdio: "inherit", env, timeout: 180_000 });
xvfb?.kill();
process.exit(run.status ?? 1);
