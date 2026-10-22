// Renders build/icon.svg to the PNG/ICO files electron-builder needs.
// Usage: pnpm --filter @corvus/desktop icons
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Resvg } from "@resvg/resvg-js";
import pngToIco from "png-to-ico";

const buildDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "build");
const svg = fs.readFileSync(path.join(buildDir, "icon.svg"));

const render = (size) => new Resvg(svg, { fitTo: { mode: "width", value: size } }).render().asPng();

fs.writeFileSync(path.join(buildDir, "icon.png"), render(1024));
const iconsDir = path.join(buildDir, "icons");
fs.mkdirSync(iconsDir, { recursive: true });
for (const size of [16, 32, 48, 64, 128, 256, 512]) {
  fs.writeFileSync(path.join(iconsDir, `${size}x${size}.png`), render(size));
}
const ico = await pngToIco([16, 24, 32, 48, 64, 128, 256].map(render));
fs.writeFileSync(path.join(buildDir, "icon.ico"), ico);
console.log(`icons written to ${buildDir}`);
