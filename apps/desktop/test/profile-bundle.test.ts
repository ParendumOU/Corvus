import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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

  it("keeps only known files that parse, and names a nameless profile", () => {
    const sealed = sealBundle({ profile: { name: "  " }, files: { "bookmarks.json": "{oops", "../escape.json": "[]", "watches.json": "[]" } as Record<string, string>, credentials: [] }, "long enough");
    const opened = openBundle(sealed, "long enough");
    expect(opened.files).toEqual({ "watches.json": "[]" });
    expect(opened.profile.name).toBe("Imported profile");
    expect(BUNDLE_FILES).not.toContain("credentials.json");
  });
});
