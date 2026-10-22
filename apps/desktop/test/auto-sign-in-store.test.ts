import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AutoSignInStore } from "../src/main/auto-sign-in-store";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("AutoSignInStore", () => {
  it("is empty by default, toggles per login and persists", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "corvus-auto-"));
    dirs.push(dir);
    const store = new AutoSignInStore(dir);
    expect(store.ids().size).toBe(0);
    store.set("vault-id", true);
    store.set("kp:abc:uuid", true);
    store.set("vault-id", true);
    expect([...store.ids()]).toEqual(["vault-id", "kp:abc:uuid"]);
    store.set("vault-id", false);
    store.flush();
    const reopened = new AutoSignInStore(dir);
    expect(reopened.has("kp:abc:uuid")).toBe(true);
    expect(reopened.has("vault-id")).toBe(false);
  });

  it("ignores a malformed file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "corvus-auto-"));
    dirs.push(dir);
    fs.writeFileSync(path.join(dir, "autosignin.json"), JSON.stringify({ ids: [1, "ok", null] }));
    expect([...new AutoSignInStore(dir).ids()]).toEqual(["ok"]);
  });
});
