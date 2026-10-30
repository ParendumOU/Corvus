import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { addNeverSave, autofillSiteOf, MAX_LAST_LOGINS, MAX_NEVER_SAVE, neverSaveHostOf, noteLastLogin, reviveLastLogins, reviveNeverSave, type LastLogins } from "../src/shared/autofill-sites";
import { SiteSettingsStore } from "../src/main/site-settings";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "corvus-autofill-sites-"));
  dirs.push(dir);
  return dir;
}

describe("the site an account was used on", () => {
  it("is the registrable domain the accounts are shared across, else the host", () => {
    expect(autofillSiteOf("https://login.example.com/sign-in")).toBe("example.com");
    expect(autofillSiteOf("https://verify.example.com/2fa?x=1")).toBe("example.com");
    expect(autofillSiteOf("https://a.example.co.uk/")).toBe("example.co.uk");
    expect(autofillSiteOf("http://localhost:3000/login")).toBe("localhost:3000");
    expect(autofillSiteOf("http://127.0.0.1:8080/")).toBe("127.0.0.1:8080");
    expect(autofillSiteOf("https://me.github.io/")).toBe("me.github.io");
    for (const url of ["corvus://settings", "file:///C:/x.html", "not a url", ""]) expect(autofillSiteOf(url), url).toBe("");
  });
});

describe("the account used last", () => {
  it("is remembered per site, and the site used longest ago is forgotten past the limit", () => {
    let map: LastLogins = {};
    map = noteLastLogin(map, "example.com", "a", 1);
    map = noteLastLogin(map, "example.org", "b", 2);
    map = noteLastLogin(map, "example.com", "c", 3);
    expect(map).toEqual({ "example.com": { id: "c", at: 3 }, "example.org": { id: "b", at: 2 } });
    expect(noteLastLogin(map, "", "x", 4)).toBe(map);
    expect(noteLastLogin(map, "example.net", "", 4)).toBe(map);

    let full: LastLogins = {};
    for (let i = 0; i < MAX_LAST_LOGINS; i++) full = noteLastLogin(full, `site${i}.example`, `id${i}`, 100 + i);
    full = noteLastLogin(full, "site0.example", "again", 10_000);
    full = noteLastLogin(full, "new.example", "n", 10_001);
    expect(Object.keys(full)).toHaveLength(MAX_LAST_LOGINS);
    expect(full["site1.example"]).toBeUndefined();
    expect(full["site0.example"]).toEqual({ id: "again", at: 10_000 });
    expect(full["new.example"]).toEqual({ id: "n", at: 10_001 });
  });

  it("comes back from disk only well formed, the newest kept", () => {
    expect(reviveLastLogins(null)).toEqual({});
    expect(reviveLastLogins([])).toEqual({});
    expect(
      reviveLastLogins({
        "example.com": { id: "a", at: 5 },
        "example.org": { id: "", at: 5 },
        "example.net": { id: "b", at: "5" },
        "example.edu": { id: 7, at: 5 },
        "x.example": "a",
        "": { id: "c", at: 1 },
      }),
    ).toEqual({ "example.com": { id: "a", at: 5 } });
    const many = Object.fromEntries(Array.from({ length: MAX_LAST_LOGINS + 5 }, (_, i) => [`s${i}.example`, { id: "x", at: i }]));
    const revived = reviveLastLogins(many);
    expect(Object.keys(revived)).toHaveLength(MAX_LAST_LOGINS);
    expect(revived["s0.example"]).toBeUndefined();
    expect(revived[`s${MAX_LAST_LOGINS + 4}.example`]).toBeDefined();
  });
});

describe("the \"Never saved\" list", () => {
  it("keeps the exact host (and port) of a page, never its domain", () => {
    expect(neverSaveHostOf("https://Accounts.Example.com/login?next=/")).toBe("accounts.example.com");
    expect(neverSaveHostOf("http://127.0.0.1:8080/login")).toBe("127.0.0.1:8080");
    expect(neverSaveHostOf("https://example.com:443/")).toBe("example.com");
    for (const url of ["corvus://passwords", "file:///x", "garbage", ""]) expect(neverSaveHostOf(url), url).toBe("");

    const list = addNeverSave([], "accounts.example.com");
    expect(list).toEqual(["accounts.example.com"]);
    expect(addNeverSave(list, "ACCOUNTS.example.com ")).toEqual(["accounts.example.com"]);
    expect(addNeverSave(list, "example.com")).toEqual(["accounts.example.com", "example.com"]);
    for (const bad of ["", "a b.example", "example.com/path", "https://example.com", "x".repeat(300)]) expect(addNeverSave(list, bad), bad).toEqual(list);
  });

  it("comes back from disk as valid hosts, each once, the newest kept past the limit", () => {
    expect(reviveNeverSave("example.com")).toEqual([]);
    expect(reviveNeverSave(["Example.com", " example.com ", "127.0.0.1:8080", "[::1]:3000", 7, null, "bad host", "a/b"])).toEqual(["example.com", "127.0.0.1:8080", "[::1]:3000"]);
    let list: string[] = [];
    for (let i = 0; i < MAX_NEVER_SAVE + 3; i++) list = addNeverSave(list, `h${i}.example`);
    expect(list).toHaveLength(MAX_NEVER_SAVE);
    expect(list[0]).toBe("h3.example");
    expect(reviveNeverSave([...list, "h0.example"])).toHaveLength(MAX_NEVER_SAVE);
  });
});

describe("SiteSettingsStore autofill memory", () => {
  it("keeps the account used last and the never-saved hosts across restarts, next to older files", () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, "site-settings.json"), JSON.stringify({ version: 1, permissions: {}, zoom: { "example.com": 1.25 } }));
    const store = new SiteSettingsStore(dir);
    expect(store.lastLogin("example.com")).toBeUndefined();
    expect(store.neverSave()).toEqual([]);
    store.noteLastLogin("example.com", "login-1");
    store.noteLastLogin("", "login-2");
    expect(store.setNeverSave("accounts.example.com", true)).toEqual(["accounts.example.com"]);
    expect(store.setNeverSave("127.0.0.1:8080", true)).toEqual(["accounts.example.com", "127.0.0.1:8080"]);
    store.flush();

    const again = new SiteSettingsStore(dir);
    expect(again.zoom("example.com")).toBe(1.25);
    expect(again.lastLogin("example.com")).toBe("login-1");
    expect(again.lastLogin("")).toBeUndefined();
    expect(again.isNeverSave("accounts.example.com")).toBe(true);
    expect(again.isNeverSave("example.com")).toBe(false);
    expect(again.isNeverSave("")).toBe(false);
    expect(again.setNeverSave("accounts.example.com", false)).toEqual(["127.0.0.1:8080"]);
    expect(again.isNeverSave("accounts.example.com")).toBe(false);
  });
});
