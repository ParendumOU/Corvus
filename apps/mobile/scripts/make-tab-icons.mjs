// Draws the tab bar's icons (Home, Assist, Library, Settings) as template PNGs at 1x/2x/3x (24/48/72 px):
// black strokes on transparent, from the same 24-unit stroke paths as src/components/icon.tsx (the
// desktop app's icons). Runs Electron's canvas on a virtual display, like the web smoke test.
// Run in Docker: node apps/mobile/scripts/make-tab-icons.mjs
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const electron = createRequire(import.meta.url)("electron");
const env = { ...process.env };
let xvfb = null;
if (!env.DISPLAY) {
  xvfb = spawn("Xvfb", [":96", "-screen", "0", "640x480x24"], { stdio: "ignore" });
  env.DISPLAY = ":96";
  await new Promise((r) => setTimeout(r, 1000));
}
const run = spawnSync(electron, ["--no-sandbox", "--disable-dev-shm-usage", path.join(here, "make-tab-icons-main.cjs")], { stdio: "inherit", env, timeout: 60_000, killSignal: "SIGKILL" });
xvfb?.kill();
process.exit(run.status ?? 1);
