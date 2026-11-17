import { createCipheriv, randomBytes, scryptSync } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { BUNDLE_FILES, BundleError, collectProfile, openBundle, sealBundle, writeProfileFiles } from "../src/main/profile-bundle";
import type { Credential } from "../src/shared/credentials";

const dirs: string[] = [];
const tempDir = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "corvus-bundle-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const login: Credential = { id: "c1", origin: "https://mail.example", username: "ana", password: "s3cret-pw", createdAt: 1, updatedAt: 2 };

describe("profile bundle", () => {
  it("carries the profile's files and logins through a password-sealed file", () => {
    const from = tempDir();
    fs.writeFileSync(path.join(from, "bookmarks.json"), JSON.stringify([{ id: "b1", title: "Corvus" }]));
    fs.writeFileSync(path.join(from, "history.json"), "[]");
    fs.writeFileSync(path.join(from, "credentials.json"), '{"sealed":"by this machine"}');
    fs.writeFileSync(path.join(from, "keepass.json"), '{"sources":["C:/vault.kdbx"]}');
    fs.writeFileSync(path.join(from, "sync.json"), "{}");
    const contents = collectProfile(from, { name: "Work", avatar: "#ff0000" }, [login]);
    expect(Object.keys(contents.files).sort()).toEqual(["bookmarks.json", "history.json"]);

    const sealed = sealBundle(contents, "correct horse", 123, "0.10.0");
    expect(sealed).not.toContain("s3cret-pw");
    expect(sealed).not.toContain("Corvus");
    const opened = openBundle(sealed, "correct horse");
    expect(opened).toEqual({ profile: { name: "Work", avatar: "#ff0000" }, files: contents.files, credentials: [login] });

    const to = tempDir();
    expect(writeProfileFiles(to, opened.files).sort()).toEqual(["bookmarks.json", "history.json"]);
    expect(JSON.parse(fs.readFileSync(path.join(to, "bookmarks.json"), "utf8"))).toEqual([{ id: "b1", title: "Corvus" }]);
  });

  it("refuses a short password, a wrong one, a tampered file and other files", () => {
    const contents = { profile: { name: "P" }, files: { "reading.json": "[]" }, credentials: [] };
    expect(() => sealBundle(contents, "short")).toThrow(BundleError);
    const sealed = sealBundle(contents, "long enough");
    expect(() => openBundle(sealed, "not the one")).toThrow(/Wrong password/);
    const tampered = JSON.parse(sealed) as { data: string };
    tampered.data = Buffer.from(Buffer.from(tampered.data, "base64").map((b, i) => (i === 3 ? b ^ 1 : b))).toString("base64");
    expect(() => openBundle(JSON.stringify(tampered), "long enough")).toThrow(/Wrong password, or the file is damaged/);
    expect(() => openBundle("{\"hello\":1}", "long enough")).toThrow(/not a Corvus profile/);
    expect(() => openBundle("not json", "long enough")).toThrow(/not a Corvus profile/);
    const greedy = JSON.parse(sealed) as { kdf: { N: number } };
    greedy.kdf.N = 1 << 24;
    expect(() => openBundle(JSON.stringify(greedy), "long enough")).toThrow(/damaged/);
  });

  it("calls a sealed payload that is not JSON or inflates too far damaged", () => {
    const seal = (plain: Buffer): string => {
      const salt = randomBytes(16);
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", scryptSync("long enough", salt, 32, { N: 1024, r: 8, p: 1 }), iv);
      const data = Buffer.concat([cipher.update(plain), cipher.final()]);
      const kdf = { name: "scrypt", N: 1024, r: 8, p: 1, salt: salt.toString("base64") };
      return JSON.stringify({ format: "corvus-profile", v: 1, kdf, iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64") });
    };
    expect(() => openBundle(seal(gzipSync(Buffer.from("not json"))), "long enough")).toThrow(/damaged/);
    expect(() => openBundle(seal(gzipSync(Buffer.from("null"))), "long enough")).toThrow(/damaged/);
    const big = seal(gzipSync(Buffer.from(JSON.stringify({ format: "corvus-profile-data", files: { "history.json": `"${"x".repeat(1 << 20)}"` } }))));
    expect(() => openBundle(big, "long enough", 1 << 16)).toThrow(BundleError);
    expect(openBundle(big, "long enough").files["history.json"]).toHaveLength((1 << 20) + 2);
  });

  it("keeps only known files that parse, and names a nameless profile", () => {
    const sealed = sealBundle({ profile: { name: "  " }, files: { "bookmarks.json": "{oops", "../escape.json": "[]", "watches.json": "[]" } as Record<string, string>, credentials: [] }, "long enough");
    const opened = openBundle(sealed, "long enough");
    expect(opened.files).toEqual({ "watches.json": "[]" });
    expect(opened.profile.name).toBe("Imported profile");
    expect(BUNDLE_FILES).not.toContain("credentials.json");
  });
});

describe("password history in a profile export", () => {
  it("stays behind: the bundle carries the login without its retired-password hashes", () => {
    const login = { id: "h1", origin: "https://example.com", username: "ana", password: "now", passwordHistory: [{ salt: "c2FsdA==", hash: "aGFzaA==", at: 1 }], passwordChangedAt: 5, createdAt: 1, updatedAt: 5 };
    const contents = collectProfile(fs.mkdtempSync(path.join(os.tmpdir(), "corvus-bundle-history-")), { name: "P" }, [login]);
    expect(contents.credentials).toEqual([{ id: "h1", origin: "https://example.com", username: "ana", password: "now", passwordChangedAt: 5, createdAt: 1, updatedAt: 5 }]);
  });
});
