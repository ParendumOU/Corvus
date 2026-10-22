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
