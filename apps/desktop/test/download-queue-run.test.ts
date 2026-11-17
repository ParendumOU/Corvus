import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ Notification: { isSupported: () => false } }));

import type { AppContext } from "../src/main/context";
import { DownloadQueue } from "../src/main/download-queue";
import type { ProfileRuntime } from "../src/main/profiles";
import type { QueuePackage } from "../src/shared/download-queue";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("download queue runs", () => {
  it("never fetches a file address a file host gave that is not a web address", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "corvus-queue-"));
    dirs.push(dataDir);
    const pkg: QueuePackage = {
      id: "p1",
      name: "p1",
      source: "https://host.example/",
      passwords: [],
      dir: path.join(dataDir, "dl", "p1"),
      addedAt: 1,
      items: [
        {
          id: "i1",
          url: "https://host.example/d/abc",
          filename: "secret.txt",
          host: "host.example",
          kind: "hoster",
          state: "queued",
          receivedBytes: 0,
          totalBytes: null,
          attempts: 0,
          resolved: { url: "file:///etc/passwd", at: Date.now() },
        },
      ],
    };
    fs.writeFileSync(path.join(dataDir, "download-queue.json"), JSON.stringify([pkg]));
    const fetch = vi.fn(async () => new Response("x"));
    const runtime = { profile: { id: "default" }, dataDir, session: { fetch } } as unknown as ProfileRuntime;
    const ctx = {
      settings: { get: () => ({ downloads: { maxParallel: 3, segments: 1, extractArchives: false } }) },
      downloads: { directory: () => path.join(dataDir, "dl") },
      windows: { forProfile: () => [] },
    } as unknown as AppContext;
    const queue = new DownloadQueue(ctx);
    queue.attach(runtime);
    await vi.waitFor(() => expect(queue.list(runtime).packages[0]?.items[0]?.state).toBe("failed"));
    expect(fetch).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(pkg.dir, "secret.txt"))).toBe(false);
    queue.flush();
  });
});
