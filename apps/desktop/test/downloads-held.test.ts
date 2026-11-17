import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const userData = fs.mkdtempSync(path.join(os.tmpdir(), "corvus-dl-user-"));
vi.mock("electron", () => ({ app: { getPath: () => userData }, dialog: {}, shell: {} }));

import type { AppContext } from "../src/main/context";
import { DownloadManager } from "../src/main/downloads";
import type { ProfileRuntime } from "../src/main/profiles";

const dirs: string[] = [userData];
afterEach(() => {
  for (const dir of dirs.splice(1)) fs.rmSync(dir, { recursive: true, force: true });
});

/** The parts of Electron's DownloadItem the manager uses. */
class FakeItem extends EventEmitter {
  private savePath = "";
  constructor(
    private readonly url: string,
    private readonly name: string,
  ) {
    super();
  }
  getURL = (): string => this.url;
  getURLChain = (): string[] => [this.url];
  getFilename = (): string => this.name;
  getMimeType = (): string => "application/octet-stream";
  getTotalBytes = (): number => 3;
  getReceivedBytes = (): number => 3;
  canResume = (): boolean => false;
  isPaused = (): boolean => false;
  cancel = (): void => undefined;
  setSavePath = (p: string): void => {
    this.savePath = p;
  };
  getSavePath = (): string => this.savePath;
  /** Writes the file where the manager put it and finishes. */
  finish(body: string): void {
    fs.writeFileSync(this.savePath, body);
    this.emit("done", {}, "completed");
  }
}

describe("held downloads", () => {
  it("keeps two programs of the same name as two files", async () => {
    const downloadsDir = fs.mkdtempSync(path.join(os.tmpdir(), "corvus-dl-"));
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "corvus-dl-data-"));
    dirs.push(downloadsDir, dataDir);
    let willDownload: ((event: unknown, item: FakeItem, wc: undefined) => void) | undefined;
    const runtime = {
      profile: { id: "default" },
      dataDir,
      locked: false,
      isPrivateSession: () => false,
      session: { on: (_name: string, fn: typeof willDownload) => (willDownload = fn) },
    } as unknown as ProfileRuntime;
    const ctx = {
      settings: { get: () => ({ downloads: { directory: downloadsDir, askWhereToSave: false, promptDestination: false }, pdf: { openInViewer: false } }) },
      windows: { forProfile: () => [] },
      queue: { summary: () => null },
    } as unknown as AppContext;
    const manager = new DownloadManager(ctx);
    manager.attach(runtime);

    const a = new FakeItem("https://a.example/setup.exe", "setup.exe");
    const b = new FakeItem("https://b.example/setup.exe", "setup.exe");
    willDownload!({ preventDefault: () => undefined }, a, undefined);
    willDownload!({ preventDefault: () => undefined }, b, undefined);
    a.finish("AAA");
    b.finish("BBB");
    const [second, first] = manager.list(runtime);
    expect(first!.state).toBe("blocked");
    // A slow disk: the first file is not in place yet when the second one picks its name.
    const rename = fs.promises.rename.bind(fs.promises);
    const slow = vi.spyOn(fs.promises, "rename").mockImplementation(async (from, to) => {
      await new Promise((r) => setTimeout(r, 20));
      return rename(from, to);
    });
    manager.keep(runtime, first!.id);
    manager.keep(runtime, second!.id);

    await vi.waitFor(() => expect(manager.list(runtime).every((d) => d.state === "completed")).toBe(true));
    const kept = manager.list(runtime).map((d) => fs.readFileSync(d.savePath, "utf8"));
    expect(kept.sort()).toEqual(["AAA", "BBB"]);
    expect(fs.readdirSync(downloadsDir).sort()).toEqual(["setup (1).exe", "setup.exe"]);
    slow.mockRestore();
  });
});
