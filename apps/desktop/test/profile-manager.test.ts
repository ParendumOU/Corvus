import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_PROFILE_ID, ProfileError, ProfileManager } from "../src/main/profile-manager";

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "corvus-profiles-"));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("ProfileManager", () => {
  it("creates a default profile with a data directory on first run", () => {
    const pm = new ProfileManager(root);
    expect(pm.list()).toEqual([expect.objectContaining({ id: DEFAULT_PROFILE_ID, name: "Personal" })]);
    expect(pm.lastUsed).toBe(DEFAULT_PROFILE_ID);
    expect(fs.existsSync(pm.dataDir(DEFAULT_PROFILE_ID))).toBe(true);
    expect(fs.existsSync(path.join(root, "profiles.json"))).toBe(true);
  });

  it("creates, renames and persists profiles", () => {
    const pm = new ProfileManager(root);
    const work = pm.create("  Work  ");
    expect(work.name).toBe("Work");
    expect(work.id).toMatch(/^[a-f0-9]{8}$/);
    expect(fs.existsSync(pm.dataDir(work.id))).toBe(true);
    pm.rename(work.id, "Office");
    pm.markUsed(work.id);

    const reloaded = new ProfileManager(root);
    expect(reloaded.list().map((p) => p.name)).toEqual(["Personal", "Office"]);
    expect(reloaded.lastUsed).toBe(work.id);
  });

  it("rejects empty names and unknown ids", () => {
    const pm = new ProfileManager(root);
    expect(() => pm.create("   ")).toThrow(ProfileError);
    expect(() => pm.rename("nope", "x")).toThrow(ProfileError);
    expect(() => pm.markUsed("nope")).toThrow(ProfileError);
  });

  it("deletes profiles and their data but never the last one", () => {
    const pm = new ProfileManager(root);
    const work = pm.create("Work");
    fs.writeFileSync(path.join(pm.dataDir(work.id), "bookmarks.json"), "[]");
    pm.markUsed(work.id);
    pm.remove(work.id);
    expect(pm.list().map((p) => p.id)).toEqual([DEFAULT_PROFILE_ID]);
    expect(pm.lastUsed).toBe(DEFAULT_PROFILE_ID);
    expect(fs.existsSync(path.join(root, work.id))).toBe(false);
    expect(() => pm.remove(DEFAULT_PROFILE_ID)).toThrow(/only profile/);
  });

  it("uses one session partition per profile", () => {
    expect(ProfileManager.partition("abc")).toBe("persist:profile-abc");
  });

  it("guards data directories against path traversal", () => {
    const pm = new ProfileManager(root);
    expect(() => pm.dataDir("../etc")).toThrow(ProfileError);
  });

  it("links and unlinks a sync chain", () => {
    const pm = new ProfileManager(root);
    pm.setSyncChain(DEFAULT_PROFILE_ID, "chain-1");
    expect(pm.get(DEFAULT_PROFILE_ID)?.syncChainId).toBe("chain-1");
    pm.setSyncChain(DEFAULT_PROFILE_ID, undefined);
    expect(pm.get(DEFAULT_PROFILE_ID)?.syncChainId).toBeUndefined();
  });

  it("recovers from a corrupt profiles file", () => {
    fs.writeFileSync(path.join(root, "profiles.json"), "{not json");
    const pm = new ProfileManager(root);
    expect(pm.list()).toHaveLength(1);
    expect(fs.readdirSync(root).some((f) => f.startsWith("profiles.json.corrupt-"))).toBe(true);
  });
});
