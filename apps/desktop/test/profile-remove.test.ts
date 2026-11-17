import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const cleared: string[] = [];
vi.mock("electron", () => ({
  app: {},
  webContents: { getAllWebContents: () => [] },
  session: {
    fromPartition: (partition: string) => ({
      clearStorageData: async () => void cleared.push(partition),
      clearCache: async () => undefined,
    }),
  },
}));

vi.mock("electron-chrome-extensions", () => ({ ElectronChromeExtensions: class {} }));
vi.mock("electron-chrome-web-store", () => ({}));

const { ProfileManager } = await import("../src/main/profile-manager");
const { ProfileRegistry } = await import("../src/main/profiles");

const dirs: string[] = [];
afterEach(() => {
  cleared.length = 0;
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("deleting a profile", () => {
  it("wipes its containers' sessions too, not only the profile's own", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "corvus-profile-remove-"));
    dirs.push(root);
    const manager = new ProfileManager(root);
    const work = manager.create("Work");
    fs.writeFileSync(path.join(manager.dataDir(work.id), "containers.json"), JSON.stringify({ version: 1, containers: [{ id: "bank", name: "Bank", color: "green" }] }));
    await new ProfileRegistry(manager, {} as never).remove(work.id);
    expect(cleared).toEqual([`persist:profile-${work.id}`, `persist:profile-${work.id}-ctr-bank`]);
    expect(fs.existsSync(manager.dataDir(work.id))).toBe(false);
  });
});
