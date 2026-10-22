#!/usr/bin/env node
// Generate the tree of the MCP connector repo ParendumOU/Corvus-MCP (MIT) from this repo:
//   mcp/corvus-mcp-stdio.mjs, mcp/THIRD_PARTY_NOTICES.md   bundled stdio bridge (npx/pnpm dlx bin)
//   .claude-plugin/plugin.json, commands/, skills/           Claude Code plugin (plugin root = repo root)
//   .claude-plugin/marketplace.json, README.md, LICENSE      from integrations/mcp-connector/
//   package.json                                              generated, version = plugin version
// Everything comes from the committed tree of a ref (default HEAD). It never pushes.
//
//   node scripts/build-mcp-connector.mjs <outdir> [--commit] [--skip-bundle] [--ref <ref>]
//
// <outdir> is either new/empty (with --commit: `git init -b main` + one commit), or an existing
// clone of the connector repo (its files are replaced; with --commit a new commit on top). Commits
// use the identity of every ParendumOU commit as author and committer. Unless --skip-bundle, the
// bridge is rebuilt in Docker first and the run stops if the committed bundle was stale.
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const IDENTITY = { name: "Parendum", email: "295081442+ParendumOU@users.noreply.github.com" };
const REPO_URL = "https://github.com/ParendumOU/Corvus-MCP";
const PLUGIN = "integrations/claude-code";
const TEMPLATES = "integrations/mcp-connector";
const BIN = "mcp/corvus-mcp-stdio.mjs";
const ALLOWED =
  /^(README\.md|LICENSE|package\.json|mcp\/corvus-mcp-stdio\.mjs|mcp\/THIRD_PARTY_NOTICES\.md|\.claude-plugin\/(marketplace|plugin)\.json|commands\/[A-Za-z0-9._-]+\.md|skills\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\.md)$/;
const SECRETS =
  /gh[pousr]_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{40,}|glpat-[A-Za-z0-9_-]{20}|sk-ant-(api|admin)\d{2}-[A-Za-z0-9_-]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|sourceMappingURL=data:/;

function die(msg) {
  console.error(`build-mcp-connector: ${msg}`);
  process.exit(1);
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { maxBuffer: 1 << 28, ...opts });
  if (r.error) die(`${cmd} failed: ${r.error.message}`);
  if (r.status !== 0) die(`${cmd} ${args[0]} failed: ${String(r.stderr ?? "").trim()}`);
  return r.stdout;
}
const git = (args, opts) => run("git", args, opts);

const args = process.argv.slice(2);
let outArg = null;
let commit = false;
let skipBundle = false;
let ref = "HEAD";
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--commit") commit = true;
  else if (args[i] === "--skip-bundle") skipBundle = true;
  else if (args[i] === "--ref") ref = args[++i] ?? die("--ref needs a value");
  else if (!outArg && !args[i].startsWith("-")) outArg = args[i];
  else die(`unknown argument: ${args[i]}`);
}
if (!outArg) die("usage: node scripts/build-mcp-connector.mjs <outdir> [--commit] [--skip-bundle] [--ref <ref>]");
const out = resolve(outArg);
const existingRepo = existsSync(join(out, ".git"));
if (!existingRepo && existsSync(out) && readdirSync(out).length > 0) die(`${out} is neither empty nor a git clone`);

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(root);

if (!skipBundle) {
  console.log("Rebuilding the bridge bundle (Docker)...");
  run(
    "docker",
    ["compose", "run", "--rm", "-T", "dev", "sh", "-c",
      'pnpm install --frozen-lockfile >/dev/null && pnpm -r --filter "@corvus/mcp-server^..." run build >/dev/null && pnpm --filter @corvus/mcp-server run bundle:bridge'],
    { stdio: ["ignore", "inherit", "inherit"] },
  );
  const stale = String(git(["status", "--porcelain", "--", `${PLUGIN}/mcp`])).trim();
  if (stale) die(`the committed bridge bundle was stale and has been rebuilt; review and commit ${PLUGIN}/mcp, then run again`);
}

const commitId = String(git(["rev-parse", "--verify", `${ref}^{commit}`])).trim();
const show = (path) => git(["show", `${commitId}:${path}`]);
const listed = (dir) => String(git(["ls-tree", "-r", "--name-only", commitId, "--", dir])).split("\n").filter(Boolean);

const files = new Map();
for (const name of ["README.md", "LICENSE", ".claude-plugin/marketplace.json"]) files.set(name, show(`${TEMPLATES}/${name}`));
for (const path of [...listed(`${PLUGIN}/commands`), ...listed(`${PLUGIN}/skills`), ...listed(`${PLUGIN}/mcp`)]) {
  files.set(path.slice(PLUGIN.length + 1), show(path));
}

const plugin = JSON.parse(String(show(`${PLUGIN}/.claude-plugin/plugin.json`)));
plugin.repository = REPO_URL;
const serverArgs = plugin.mcpServers?.corvus?.args ?? [];
if (!serverArgs.includes(`\${CLAUDE_PLUGIN_ROOT}/${BIN}`)) die(`plugin.json no longer runs \${CLAUDE_PLUGIN_ROOT}/${BIN}`);
files.set(".claude-plugin/plugin.json", Buffer.from(`${JSON.stringify(plugin, null, 2)}\n`));

const pkg = {
  name: "corvus-mcp",
  version: plugin.version,
  private: true,
  description: "MCP connector for the Corvus AI browser: lets Claude Code, Claude Desktop, Cursor, VS Code and other MCP clients drive Corvus.",
  license: "MIT",
  author: "Parendum <info@parendum.com>",
  homepage: "https://corvus.parendum.com",
  repository: { type: "git", url: `git+${REPO_URL}.git` },
  type: "module",
  bin: { "corvus-mcp": BIN },
  files: ["mcp"],
  engines: { node: ">=20" },
  keywords: ["mcp", "model-context-protocol", "browser", "corvus", "claude", "automation"],
};
files.set("package.json", Buffer.from(`${JSON.stringify(pkg, null, 2)}\n`));

// Guard: only the expected files, nothing secret-looking, no em or en dashes in the README.
const problems = [];
for (const [path, buf] of files) {
  if (!ALLOWED.test(path)) problems.push(`${path}: not on the allowlist`);
  if (SECRETS.test(buf.toString("utf8"))) problems.push(`${path}: looks like it contains a secret or an inline source map`);
}
if (/[–—]/.test(files.get("README.md").toString("utf8"))) problems.push("README.md: contains an em or en dash");
const market = JSON.parse(files.get(".claude-plugin/marketplace.json").toString("utf8"));
for (const p of market.plugins ?? []) {
  if (p.source !== "./") problems.push(`marketplace plugin ${p.name}: source must be "./" (plugin at the repo root)`);
  if (p.name !== plugin.name) problems.push(`marketplace plugin ${p.name}: plugin.json name is ${plugin.name}`);
}
if (!files.has(BIN)) problems.push(`${BIN}: missing`);
if (problems.length) {
  console.error("Refusing to build the connector tree:");
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}

if (existingRepo) {
  for (const entry of readdirSync(out)) if (entry !== ".git") rmSync(join(out, entry), { recursive: true, force: true });
} else {
  mkdirSync(out, { recursive: true });
}
for (const [path, buf] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
  const file = join(out, ...path.split("/"));
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, buf);
}
if (process.platform !== "win32") chmodSync(join(out, ...BIN.split("/")), 0o755);
console.log(`Connector tree from ${commitId.slice(0, 12)} written to ${out} (${files.size} files):`);
for (const path of [...files.keys()].sort()) console.log(`  ${path}`);

const claude = spawnSync("claude", ["plugin", "validate", out], { encoding: "utf8" });
if (claude.error || claude.status === null) console.log("claude plugin validate: skipped (Claude Code CLI not found)");
else if (claude.status !== 0) die(`claude plugin validate failed:\n${claude.stdout}${claude.stderr}`);
else console.log("claude plugin validate: ok");

if (commit) {
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: IDENTITY.name,
    GIT_AUTHOR_EMAIL: IDENTITY.email,
    GIT_COMMITTER_NAME: IDENTITY.name,
    GIT_COMMITTER_EMAIL: IDENTITY.email,
  };
  if (!existingRepo) git(["init", "-q", "-b", "main"], { cwd: out });
  git(["-c", "core.autocrlf=false", "add", "-A"], { cwd: out });
  git(["update-index", "--chmod=+x", "--", BIN], { cwd: out });
  const changed = spawnSync("git", ["diff", "--cached", "--quiet"], { cwd: out }).status !== 0;
  if (!changed) {
    console.log("No changes to commit.");
  } else {
    const message = existingRepo ? `Update Corvus MCP connector (${plugin.version})` : "Initial release of the Corvus MCP connector";
    git(["-c", "core.autocrlf=false", "commit", "-q", "-m", message], { cwd: out, env });
    console.log(`Committed: ${String(git(["log", "--oneline", "-1"], { cwd: out })).trim()} (not pushed)`);
  }
}
