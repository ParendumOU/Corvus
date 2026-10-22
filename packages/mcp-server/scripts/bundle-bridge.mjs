// Bundles the stdio bridge into one self-contained file for the Claude Code plugin and the MCP
// connector, plus THIRD_PARTY_NOTICES.md with the license of every package inlined into it.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const pkgDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = resolve(pkgDir, "../../integrations/claude-code/mcp");
const outfile = join(outDir, "corvus-mcp-stdio.mjs");
const PERMISSIVE = new Set(["MIT", "ISC", "BSD-2-Clause", "BSD-3-Clause", "Apache-2.0", "0BSD"]);

process.chdir(pkgDir);
const result = await build({
  entryPoints: ["src/bin/stdio-bridge.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  banner: { js: "import{createRequire}from'node:module';const require=createRequire(import.meta.url);" },
  outfile,
  metafile: true,
  logLevel: "info",
});

const packages = new Map();
for (const input of Object.keys(result.metafile.inputs)) {
  const abs = resolve(pkgDir, input);
  const marker = `${sep}node_modules${sep}`;
  const at = abs.lastIndexOf(marker);
  if (at < 0) continue;
  const rest = abs.slice(at + marker.length).split(sep);
  const name = rest[0].startsWith("@") ? `${rest[0]}/${rest[1]}` : rest[0];
  const dir = abs.slice(0, at + marker.length) + name.split("/").join(sep);
  if (!packages.has(name)) packages.set(name, dir);
}

const sections = [];
for (const [name, dir] of [...packages].sort(([a], [b]) => a.localeCompare(b))) {
  const meta = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  const license = typeof meta.license === "string" ? meta.license : "UNKNOWN";
  if (!PERMISSIVE.has(license)) throw new Error(`${name}: license "${license}" is not on the permissive list`);
  const file = readdirSync(dir).find((f) => /^(licen[cs]e|copying)(\.(md|txt))?$/i.test(f));
  if (!file || !existsSync(join(dir, file))) throw new Error(`${name}: no license file to reproduce`);
  const text = readFileSync(join(dir, file), "utf8").replace(/\r\n/g, "\n").trim();
  sections.push(`## ${name} ${meta.version} (${license})\n\n\`\`\`text\n${text}\n\`\`\``);
}

const notices = `# Third-party notices

\`corvus-mcp-stdio.mjs\` is a single-file build of the Corvus MCP stdio bridge. Besides Corvus code
it contains the packages below, whose licenses are reproduced here.

${sections.join("\n\n")}
`;
writeFileSync(join(outDir, "THIRD_PARTY_NOTICES.md"), notices);
console.log(`${relative(process.cwd(), join(outDir, "THIRD_PARTY_NOTICES.md"))}: ${packages.size} packages`);
