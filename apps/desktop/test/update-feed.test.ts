import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DEFAULT_UPDATE_FEED, DEFAULT_UPDATE_FEED_URL, displayFeedUrl, resolveUpdateFeed, updaterChannel } from "../src/shared/update-feed";

const builderYml = readFileSync(new URL("../electron-builder.yml", import.meta.url), "utf8");

function publishBlock(): Record<string, string> {
  const block = builderYml.slice(builderYml.indexOf("\npublish:\n") + 10);
  const out: Record<string, string> = {};
  for (const line of block.split("\n")) {
    const m = /^ {2}(?<key>\w+): (?<value>.+)$/.exec(line)?.groups;
    if (!m?.key || !m.value) break;
    out[m.key] = m.value.trim();
  }
  return out;
}

describe("update feed", () => {
  it("defaults to GitHub Releases of the public repo", () => {
    expect(resolveUpdateFeed("", "latest")).toEqual({ provider: "github", owner: "ParendumOU", repo: "Corvus" });
    expect(resolveUpdateFeed("   ", "beta")).toEqual(DEFAULT_UPDATE_FEED);
    expect(displayFeedUrl("")).toBe("https://github.com/ParendumOU/Corvus/releases");
    expect(DEFAULT_UPDATE_FEED_URL).toBe(displayFeedUrl(" "));
  });

  it("uses a self-hosted generic feed when a URL is set", () => {
    expect(resolveUpdateFeed(" https://feed.test/corvus ", "beta")).toEqual({ provider: "generic", url: "https://feed.test/corvus", channel: "beta" });
    expect(displayFeedUrl("https://feed.test/corvus")).toBe("https://feed.test/corvus");
  });

  it("only allows a downgrade when leaving a pre-release for stable", () => {
    expect(updaterChannel("stable", "0.2.0")).toEqual({ channel: "latest", allowPrerelease: false, allowDowngrade: false });
    expect(updaterChannel("stable", "0.3.0-beta.1")).toEqual({ channel: "latest", allowPrerelease: false, allowDowngrade: true });
    expect(updaterChannel("beta", "0.3.0-beta.1")).toEqual({ channel: "beta", allowPrerelease: true, allowDowngrade: false });
  });

  it("matches the electron-builder publish config", () => {
    expect(publishBlock()).toEqual({ provider: "github", owner: DEFAULT_UPDATE_FEED.owner, repo: DEFAULT_UPDATE_FEED.repo, releaseType: "draft" });
  });

  it("keeps the installer names the website links to", () => {
    expect(builderYml).toMatch(/\nnsis:\n(?: {2}.*\n)*? {2}artifactName: Corvus-Setup-\$\{version\}\.\$\{ext\}\n/);
    expect(builderYml).toMatch(/\nportable:\n {2}artifactName: Corvus-Portable-\$\{version\}\.\$\{ext\}\n/);
    expect(builderYml).toMatch(/\nappImage:\n {2}artifactName: Corvus-\$\{version\}-\$\{arch\}\.\$\{ext\}\n/);
    expect(builderYml).toMatch(/\ndeb:\n {2}artifactName: corvus_\$\{version\}_\$\{arch\}\.\$\{ext\}\n/);
  });
});
