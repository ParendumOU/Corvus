// Writes out/THIRD_PARTY_NOTICES.md after `electron-vite build`: every third-party package that ships
// in the desktop app, with its version, licence and licence text, and fails the build when a licence
// is outside the allowlist (license-policy.mjs).
//
// Two sets make up "what ships":
// - packages bundled into out/ by the build (main, preload, renderer), recorded per build by the
//   `corvus-bundled-packages` plugin in electron.vite.config.ts as out/.licenses/<target>.json;
// - the production `dependencies` of @corvus/desktop and their own dependencies, which stay external
//   and are copied into the packaged app by electron-builder.
// Workspace packages (@corvus/*) are first-party. Electron and Chromium ship their own licence files.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ALLOWED_LICENSES, SOURCE_URL, acceptedCopyleft, isAllowedLicense, licenseOf } from "./license-policy.mjs";

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(appDir, "out");
const manifestDir = path.join(outDir, ".licenses");
const target = path.join(outDir, "THIRD_PARTY_NOTICES.md");
const MAX_TEXT = 64 * 1024;

const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

function realDir(dir) {
  try {
    return fs.realpathSync(dir);
  } catch {
    return null;
  }
}

/** Node-style lookup of `name` from `fromDir` (works with pnpm's symlinked layout). */
function resolvePackage(fromDir, name) {
  let dir = fromDir;
  for (;;) {
    const candidate = path.basename(dir) === "node_modules" ? path.join(dir, name) : path.join(dir, "node_modules", name);
    if (fs.existsSync(path.join(candidate, "package.json"))) return realDir(candidate);
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

const roots = new Set();

// 1. Bundled into out/ by the build.
if (!fs.existsSync(manifestDir)) {
  console.error("[notices] out/.licenses is missing: run electron-vite build first.");
  process.exit(1);
}
for (const file of fs.readdirSync(manifestDir).filter((f) => f.endsWith(".json"))) {
  for (const dir of readJson(path.join(manifestDir, file))) {
    const real = realDir(dir);
    if (real && fs.existsSync(path.join(real, "package.json"))) roots.add(real);
  }
}

// 2. External production dependencies and everything they depend on.
const desktop = readJson(path.join(appDir, "package.json"));
const seen = new Set();
function walk(fromDir, names, optional) {
  for (const name of names) {
    const dir = resolvePackage(fromDir, name);
    if (!dir) {
      if (optional.has(name)) continue;
      console.error(`[notices] cannot find production dependency ${name} from ${fromDir}`);
      process.exit(1);
    }
    if (seen.has(dir)) continue;
    seen.add(dir);
    roots.add(dir);
    const pkg = readJson(path.join(dir, "package.json"));
    const opt = new Set(Object.keys(pkg.optionalDependencies ?? {}));
    walk(dir, [...Object.keys(pkg.dependencies ?? {}), ...opt], opt);
  }
}
walk(appDir, Object.keys(desktop.dependencies ?? {}), new Set(Object.keys(desktop.optionalDependencies ?? {})));

// 3. Dependencies of bundled packages. Some ship prebuilt files that already contain their
// dependencies (kdbxweb embeds fflate), which the bundler never sees as separate modules. Listing a
// dependency that tree-shaking dropped is harmless; missing one that ships is not.
for (const dir of [...roots]) {
  if (seen.has(dir)) continue;
  const pkg = readJson(path.join(dir, "package.json"));
  if (pkg.name?.startsWith("@corvus/")) continue;
  const deps = Object.keys(pkg.dependencies ?? {});
  const opt = new Set(Object.keys(pkg.optionalDependencies ?? {}));
  walk(dir, deps.filter((d) => resolvePackage(dir, d)), opt);
}

// Collect, dedupe by name@version, skip first-party and Electron itself.
const packages = new Map();
for (const dir of roots) {
  const pkg = readJson(path.join(dir, "package.json"));
  if (!pkg.name || pkg.name.startsWith("@corvus/") || pkg.name === "electron") continue;
  const key = `${pkg.name}@${pkg.version}`;
  if (packages.has(key)) continue;
  const texts = fs
    .readdirSync(dir)
    .filter((f) => /^(unrar)?(licen[cs]e|copying|notice)([.-].*)?$/i.test(f) && fs.statSync(path.join(dir, f)).isFile())
    .sort()
    .map((f) => ({ file: f, text: fs.readFileSync(path.join(dir, f), "utf8").slice(0, MAX_TEXT).trim() }));
  const repo = typeof pkg.repository === "string" ? pkg.repository : pkg.repository?.url;
  const copyleft = isAllowedLicense(licenseOf(pkg)) ? null : acceptedCopyleft(pkg.name, pkg.version);
  packages.set(key, {
    name: pkg.name,
    version: pkg.version,
    license: copyleft ? copyleft.license : licenseOf(pkg),
    copyleft,
    homepage: pkg.homepage || repo || "",
    texts,
  });
}

const list = [...packages.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
const refused = list.filter((p) => !p.copyleft && !isAllowedLicense(p.license));
const copyleft = list.filter((p) => p.copyleft);
if (refused.length > 0) {
  console.error(`[notices] licences outside the allowlist (${ALLOWED_LICENSES.join(", ")}):`);
  for (const p of refused) console.error(`  ${p.name}@${p.version}: ${p.license || "(none declared)"}`);
  process.exit(1);
}

const fence = (text) => {
  const ticks = text.includes("```") ? "````" : "```";
  return `${ticks}text\n${text}\n${ticks}`;
};
const combined = copyleft.length
  ? [
      `**Licence of this build.** The Corvus source code is licensed under MPL-2.0. This packaged app and`,
      `its installers are a combined work that includes ${copyleft.map((p) => `${p.name} (${p.license})`).join(", ")},`,
      `so they are distributed under ${[...new Set(copyleft.map((p) => p.license))].join(", ")}. The complete corresponding`,
      `source is the public repository: ${SOURCE_URL}`,
      "",
    ]
  : [];
const lines = [
  "# Third-party notices",
  "",
  ...combined,
  `Corvus ${desktop.version} includes the third-party software listed below. Each package keeps its own`,
  "licence, reproduced here. Electron and Chromium ship their own licence files (LICENSE and",
  "LICENSES.chromium.html) next to the application.",
  "",
  `${list.length} packages.`,
  "",
];
for (const p of list) {
  lines.push(`## ${p.name} ${p.version}`, "", `License: ${p.license}`);
  if (p.copyleft) lines.push(`Note: the package declares ${p.copyleft.declared}. ${p.copyleft.reason}`);
  if (p.homepage) lines.push(`Source: ${p.homepage}`);
  lines.push("");
  if (p.texts.length === 0) lines.push("The package does not include a licence file; it is distributed under the licence named above.", "");
  for (const t of p.texts) lines.push(`${t.file}:`, "", fence(t.text), "");
}
fs.writeFileSync(target, `${lines.join("\n").trimEnd()}\n`);
fs.rmSync(manifestDir, { recursive: true, force: true });
console.log(`[notices] wrote ${path.relative(appDir, target)} (${list.length} packages)`);
