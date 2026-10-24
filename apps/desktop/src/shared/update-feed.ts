import type { UpdateChannel } from "./settings";

/**
 * Built-in update source: GitHub Releases of the public distribution repo. Must match `publish`
 * in electron-builder.yml (test/update-feed.test.ts enforces it). Only published releases are
 * visible to installed apps; drafts never are.
 */
export const DEFAULT_UPDATE_FEED = { provider: "github", owner: "ParendumOU", repo: "Corvus" } as const;

export const DEFAULT_UPDATE_FEED_URL = `https://github.com/${DEFAULT_UPDATE_FEED.owner}/${DEFAULT_UPDATE_FEED.repo}/releases`;

export type UpdateFeed =
  | { provider: "github"; owner: string; repo: string }
  | { provider: "generic"; url: string; channel: string };

export interface UpdaterChannel {
  channel: "latest" | "beta";
  allowPrerelease: boolean;
  allowDowngrade: boolean;
}

/** A user-set feed URL means a self-hosted generic feed; blank means the GitHub default. */
export function resolveUpdateFeed(feedUrl: string, channel: UpdaterChannel["channel"]): UpdateFeed {
  const url = feedUrl.trim();
  return url ? { provider: "generic", url, channel } : { ...DEFAULT_UPDATE_FEED };
}

/** Desktop release tags; Corvus for mobile is released from the same repo as `mobile-v…`. */
const DESKTOP_TAG_RE = /^v\d+\.\d+\.\d+(?:-(?:alpha|beta)(?:\.\d+)*)?$/;

/**
 * The newest desktop release in GitHub's releases feed (releases.atom, newest first). On the beta
 * channel electron-updater's GitHub provider takes the newest entry whatever it is, so a mobile
 * release would hide every desktop release from beta users; Corvus picks the tag itself.
 */
export function newestDesktopTag(atomXml: string): string | null {
  // Only the entries' own links: release notes in the feed quote links to other releases, escaped.
  for (const m of atomXml.matchAll(/<link\b[^>]*\bhref="[^"]*\/releases\/tag\/([^"/]+)"/g)) {
    let tag: string;
    try {
      tag = decodeURIComponent(m[1] ?? "");
    } catch {
      continue;
    }
    if (DESKTOP_TAG_RE.test(tag)) return tag;
  }
  return null;
}

/** One desktop release's assets read as a generic feed, with the channel file that release has. */
export function releaseFeed(tag: string): { feed: UpdateFeed; channel: string } {
  const channel = /-(alpha|beta)\b/.exec(tag)?.[1] ?? "latest";
  return { feed: { provider: "generic", url: `${DEFAULT_UPDATE_FEED_URL}/download/${encodeURIComponent(tag)}`, channel }, channel };
}

export function displayFeedUrl(feedUrl: string): string {
  return feedUrl.trim() || DEFAULT_UPDATE_FEED_URL;
}

/**
 * electron-updater's `channel` setter silently turns on allowDowngrade, which would offer an older
 * published release to anyone running a newer build. Downgrade only to leave a pre-release build
 * for the stable channel.
 */
export function updaterChannel(channel: UpdateChannel, currentVersion: string): UpdaterChannel {
  const beta = channel === "beta";
  return {
    channel: beta ? "beta" : "latest",
    allowPrerelease: beta,
    allowDowngrade: !beta && currentVersion.includes("-"),
  };
}
