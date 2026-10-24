import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_UPDATE_FEED,
  DEFAULT_UPDATE_FEED_URL,
  displayFeedUrl,
  newestDesktopTag,
  releaseFeed,
  resolveUpdateFeed,
  updaterChannel,
} from "../src/shared/update-feed";

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

  it("on the beta channel, finds the newest desktop release past Corvus for mobile releases", () => {
    const entry = (tag: string, content = "") =>
      `<entry><id>tag:github.com,2008:Repository/1/${tag}</id><link rel="alternate" type="text/html" href="https://github.com/ParendumOU/Corvus/releases/tag/${tag}"/><title>${tag}</title><content type="html">${content}</content></entry>`;
    const feed = (...entries: string[]) => `<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom">${entries.join("")}</feed>`;
    const quoted = "&lt;a href=&quot;https://github.com/ParendumOU/Corvus/releases/tag/v0.3.0&quot;&gt;0.3.0 notes&lt;/a&gt;";
    expect(newestDesktopTag(feed(entry("mobile-v0.1.0", quoted), entry("v0.11.0"), entry("v0.10.0")))).toBe("v0.11.0");
    expect(newestDesktopTag(feed(entry("v0.12.0-beta.1"), entry("v0.11.0")))).toBe("v0.12.0-beta.1");
    expect(newestDesktopTag(feed(entry("v0.12.0-nightly.1"), entry("v0.11.0")))).toBe("v0.11.0");
    expect(newestDesktopTag(feed(entry("mobile-v0.1.0")))).toBeNull();
    expect(newestDesktopTag("")).toBeNull();

    expect(releaseFeed("v0.11.0")).toEqual({
      feed: { provider: "generic", url: "https://github.com/ParendumOU/Corvus/releases/download/v0.11.0", channel: "latest" },
      channel: "latest",
    });
    expect(releaseFeed("v0.12.0-beta.1").channel).toBe("beta");
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
