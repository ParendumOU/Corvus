/**
 * Self-update of the Windows portable build. electron-updater only knows the installer (latest.yml
 * points at Corvus-Setup), so a portable copy would install Corvus instead of updating itself. The
 * portable build instead downloads the next Corvus-Portable-<v>.exe next to itself, checks it
 * against the release's SHA256SUMS.txt, and swaps the files after it quits. Pure rules here; the
 * network, file and process work lives in main/portable-updater.ts.
 */
import type { UpdateChannel } from "./settings";

export interface ReleaseAsset {
  name: string;
  url: string;
}

export interface ReleaseInfo {
  version: string;
  prerelease: boolean;
  draft: boolean;
  notes: string | null;
  assets: ReleaseAsset[];
}

export interface PortableOffer {
  version: string;
  notes: string | null;
  exe: ReleaseAsset;
  sums: ReleaseAsset;
}

export function portableAssetName(version: string): string {
  return `Corvus-Portable-${version}.exe`;
}

/** A GitHub REST release (GET /repos/{owner}/{repo}/releases) as Corvus reads it. */
export function fromGitHubRelease(raw: unknown): ReleaseInfo | null {
  const r = (raw ?? {}) as { tag_name?: unknown; prerelease?: unknown; draft?: unknown; body?: unknown; assets?: unknown };
  if (typeof r.tag_name !== "string") return null;
  const assets = Array.isArray(r.assets)
    ? r.assets
        .map((a) => a as { name?: unknown; browser_download_url?: unknown })
        .filter((a): a is { name: string; browser_download_url: string } => typeof a.name === "string" && typeof a.browser_download_url === "string")
        .map((a) => ({ name: a.name, url: a.browser_download_url }))
    : [];
  return {
    version: r.tag_name.replace(/^v/i, ""),
    prerelease: r.prerelease === true,
    draft: r.draft === true,
    notes: typeof r.body === "string" && r.body.trim() ? r.body.trim().slice(0, 4000) : null,
    assets,
  };
}

function parts(version: string): { nums: number[]; pre: string | null } {
  const [core = "", ...rest] = version.trim().replace(/^v/i, "").split("-");
  return { nums: core.split(".").map((n) => Number.parseInt(n, 10) || 0), pre: rest.length > 0 ? rest.join("-") : null };
}

/** Semver order: 1.2.0 > 1.2.0-beta.2 > 1.2.0-beta.1 > 1.1.9. */
export function compareVersions(a: string, b: string): number {
  const x = parts(a);
  const y = parts(b);
  for (let i = 0; i < Math.max(x.nums.length, y.nums.length, 3); i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
    if (d !== 0) return Math.sign(d);
  }
  if (x.pre === y.pre) return 0;
  if (x.pre === null) return 1;
  if (y.pre === null) return -1;
  const xs = x.pre.split(".");
  const ys = y.pre.split(".");
  for (let i = 0; i < Math.max(xs.length, ys.length); i++) {
    const p = xs[i];
    const q = ys[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    const pn = /^\d+$/.test(p) ? Number(p) : null;
    const qn = /^\d+$/.test(q) ? Number(q) : null;
    if (pn !== null && qn !== null && pn !== qn) return Math.sign(pn - qn);
    if (p !== q) return p < q ? -1 : 1;
  }
  return 0;
}

/**
 * The release a portable copy should move to: the newest published one of its channel that ships a
 * portable build and its checksums. Stable leaves a pre-release build for the newest stable one.
 */
export function pickPortableUpdate(releases: readonly ReleaseInfo[], channel: UpdateChannel, current: string): PortableOffer | null {
  const usable = releases
    .filter((r) => !r.draft && (channel === "beta" || !r.prerelease))
    .map((r) => ({ r, exe: r.assets.find((a) => a.name === portableAssetName(r.version)), sums: r.assets.find((a) => a.name === "SHA256SUMS.txt") }))
    .filter((c): c is { r: ReleaseInfo; exe: ReleaseAsset; sums: ReleaseAsset } => c.exe !== undefined && c.sums !== undefined)
    .sort((a, b) => compareVersions(b.r.version, a.r.version));
  const best = usable[0];
  if (!best) return null;
  const order = compareVersions(best.r.version, current);
  const leavingPrerelease = channel === "stable" && current.includes("-") && order !== 0;
  if (order <= 0 && !leavingPrerelease) return null;
  return { version: best.r.version, notes: best.r.notes, exe: best.exe, sums: best.sums };
}

/** The SHA-256 a checksum file lists for `fileName` ("<hash>  name" or "<hash> *name"), lower-case. */
export function sha256For(sums: string, fileName: string): string | null {
  for (const line of sums.split(/\r?\n/)) {
    const m = /^([0-9a-f]{64})\s+\*?(.+?)\s*$/i.exec(line.trim());
    if (m && m[2] === fileName) return m[1]!.toLowerCase();
  }
  return null;
}

/**
 * The name the updated copy takes: the release's own name when this copy still has a release name
 * (so the file says which version it is), otherwise the name the person gave it.
 */
export function updatedFileName(currentName: string, version: string): string {
  return /^Corvus-Portable-\d[\w.-]*\.exe$/i.test(currentName) ? portableAssetName(version) : currentName;
}

/**
 * A cmd script that waits for this copy's process to exit, sets it aside, puts the downloaded copy
 * in its place and starts it; when anything fails the old copy goes back and starts instead, so the
 * person is never left without Corvus. Paths cmd could misread (quotes, %, ^, !) are refused.
 */
export function swapScript(paths: { current: string; download: string; target: string }, pid: number): string {
  for (const p of Object.values(paths)) {
    if (!/^[A-Za-z]:\\/.test(p) || /["%\r\n^!&|<>]/.test(p)) throw new Error(`Cannot update a portable copy at this path: ${p}`);
  }
  if (!Number.isInteger(pid) || pid <= 0) throw new Error("Cannot update without the running process id.");
  // Delayed expansion (!VAR!): a path with parentheses ("Program Files (x86)") would otherwise end
  // the ( ... ) blocks it is expanded into.
  return [
    "@echo off",
    "setlocal EnableDelayedExpansion",
    `set "CURRENT=${paths.current}"`,
    `set "DOWNLOAD=${paths.download}"`,
    `set "TARGET=${paths.target}"`,
    'if not exist "!DOWNLOAD!" goto done',
    "rem Wait up to two minutes for Corvus to quit.",
    "for /l %%i in (1,1,120) do (",
    `  tasklist /fi "PID eq ${pid}" 2>nul | find "${pid}" >nul || goto replace`,
    "  ping -n 2 127.0.0.1 >nul",
    ")",
    "goto done",
    ":replace",
    "rem The portable wrapper may still hold its file for a moment: retry setting it aside.",
    "for /l %%i in (1,1,30) do (",
    '  move /y "!CURRENT!" "!CURRENT!.old" >nul 2>&1',
    '  if not exist "!CURRENT!" goto swap',
    "  ping -n 2 127.0.0.1 >nul",
    ")",
    'start "" "!CURRENT!"',
    "goto done",
    ":swap",
    'move /y "!DOWNLOAD!" "!TARGET!" >nul 2>&1',
    'if exist "!TARGET!" (',
    '  del /f /q "!CURRENT!.old" >nul 2>&1',
    '  start "" "!TARGET!"',
    ") else (",
    '  move /y "!CURRENT!.old" "!CURRENT!" >nul 2>&1',
    '  start "" "!CURRENT!"',
    ")",
    ":done",
    '(goto) 2>nul & del /f /q "%~f0"',
    "",
  ].join("\r\n");
}
