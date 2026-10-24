import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import type { UpdateChannel } from "../shared/settings";
import { DEFAULT_UPDATE_FEED } from "../shared/update-feed";
import {
  fromGitHubRelease,
  pickPortableUpdate,
  portableAssetName,
  sha256For,
  swapScript,
  updatedFileName,
  type PortableOffer,
  type ReleaseInfo,
} from "../shared/portable-update";

type Fetch = (url: string, init?: { headers?: Record<string, string> }) => Promise<Response>;

/** The running portable copy, when this is the Windows portable build. */
export function portableExecutable(env: NodeJS.ProcessEnv = process.env, platform = process.platform): string | null {
  const file = env.PORTABLE_EXECUTABLE_FILE;
  return platform === "win32" && file ? file : null;
}

/**
 * Updates the Windows portable build in place (see shared/portable-update.ts): finds the next
 * release, downloads its portable exe next to the running one, verifies its SHA-256 against the
 * release checksums, and on install swaps the files once Corvus has quit.
 */
export class PortableUpdater {
  constructor(
    private readonly exePath: string,
    private readonly fetchImpl: Fetch = fetch,
  ) {}

  /** The offer for this channel, or null when this copy is current. A custom feed URL is a generic feed. */
  async check(channel: UpdateChannel, currentVersion: string, feedUrl: string): Promise<PortableOffer | null> {
    const releases = feedUrl.trim() ? await this.genericRelease(feedUrl.trim(), channel) : await this.githubReleases();
    return pickPortableUpdate(releases, channel, currentVersion);
  }

  private async githubReleases(): Promise<ReleaseInfo[]> {
    const res = await this.fetchImpl(`https://api.github.com/repos/${DEFAULT_UPDATE_FEED.owner}/${DEFAULT_UPDATE_FEED.repo}/releases?per_page=20`, {
      headers: { accept: "application/vnd.github+json", "user-agent": "Corvus" },
    });
    if (!res.ok) throw new Error(`GitHub answered ${res.status} while looking for updates.`);
    const list = (await res.json()) as unknown;
    return Array.isArray(list) ? list.map(fromGitHubRelease).filter((r): r is ReleaseInfo => r !== null) : [];
  }

  /** A self-hosted electron-builder feed: its latest.yml / beta.yml names the version. */
  private async genericRelease(feedUrl: string, channel: UpdateChannel): Promise<ReleaseInfo[]> {
    const base = feedUrl.replace(/\/+$/, "");
    const res = await this.fetchImpl(`${base}/${channel === "beta" ? "beta" : "latest"}.yml`);
    if (!res.ok) throw new Error(`The update feed answered ${res.status}.`);
    const version = /^version:\s*['"]?([^'"\s]+)/m.exec(await res.text())?.[1];
    if (!version) return [];
    return [
      {
        version,
        prerelease: version.includes("-"),
        draft: false,
        notes: null,
        assets: [
          { name: portableAssetName(version), url: `${base}/${portableAssetName(version)}` },
          { name: "SHA256SUMS.txt", url: `${base}/SHA256SUMS.txt` },
        ],
      },
    ];
  }

  /** Where the update is downloaded to: next to this copy, so the swap is a rename. */
  downloadPath(offer: PortableOffer): string {
    return path.join(path.dirname(this.exePath), `${portableAssetName(offer.version)}.download`);
  }

  /** Downloads and verifies the offered copy; returns its path. A copy that does not match is deleted. */
  async download(offer: PortableOffer, onProgress: (percent: number) => void): Promise<string> {
    const sumsRes = await this.fetchImpl(offer.sums.url);
    if (!sumsRes.ok) throw new Error(`Could not read the release checksums (${sumsRes.status}).`);
    const expected = sha256For(await sumsRes.text(), offer.exe.name);
    if (!expected) throw new Error(`The release checksums do not list ${offer.exe.name}.`);

    const res = await this.fetchImpl(offer.exe.url);
    if (!res.ok || !res.body) throw new Error(`Download failed (${res.status}).`);
    const total = Number(res.headers.get("content-length")) || 0;
    const target = this.downloadPath(offer);
    const hash = createHash("sha256");
    const out = fs.createWriteStream(target);
    let received = 0;
    let lastPercent = -1;
    try {
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        hash.update(value);
        received += value.byteLength;
        if (!out.write(value)) await new Promise<void>((r) => out.once("drain", () => r()));
        const percent = total > 0 ? Math.min(99, Math.floor((received / total) * 100)) : 0;
        if (percent !== lastPercent) onProgress((lastPercent = percent));
      }
      await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())));
    } catch (err) {
      out.destroy();
      fs.rmSync(target, { force: true });
      throw err;
    }
    if (hash.digest("hex") !== expected) {
      fs.rmSync(target, { force: true });
      throw new Error("The downloaded update does not match its published checksum; it was deleted.");
    }
    onProgress(100);
    return target;
  }

  /**
   * Hands the swap to a detached cmd script and lets Corvus quit: the script waits for this process
   * to exit, puts the new copy in place (renamed to its release name when this one has one) and
   * starts it. Throws, before quitting, when this copy's location cannot be updated.
   */
  install(downloaded: string, version: string, quit: () => void, pid = process.pid): void {
    const target = path.join(path.dirname(this.exePath), updatedFileName(path.basename(this.exePath), version));
    const script = swapScript({ current: this.exePath, download: downloaded, target }, pid);
    const file = path.join(os.tmpdir(), `corvus-update-${pid}.cmd`);
    fs.writeFileSync(file, script, "utf8");
    const child = spawn("cmd.exe", ["/d", "/c", file], { detached: true, stdio: "ignore", windowsHide: true });
    child.unref();
    quit();
  }
}
