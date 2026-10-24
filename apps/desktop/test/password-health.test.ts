import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ net: { fetch: async () => new Response("") } }));

import { PasswordCheckupService } from "../src/main/password-checkup";
import type { ProfileRuntime } from "../src/main/profiles";
import { breachCount, checkupSummary, isWeakPassword, reuseCounts } from "../src/shared/password-health";

const sha1 = (s: string): string => createHash("sha1").update(s, "utf8").digest("hex").toUpperCase();

/** A profile with just the logins the checkup reads. */
const profileWith = (vault: Array<{ id: string; password: string }>, keepass: Array<{ id: string; password: string }> = []): ProfileRuntime =>
  ({ credentials: { all: () => vault }, keepass: { records: () => keepass } }) as unknown as ProfileRuntime;

describe("password health rules", () => {
  it("reads a breach count from a range answer, padding lines included", () => {
    const body = "0018A45C4D1DEF81644B54AB7F969B88D65:1\r\n00D4F6E8FA6EECAD2A3AA415EEC418D38EC:2\nABCDEF0123456789ABCDEF0123456789ABC:0";
    expect(breachCount(body, "00d4f6e8fa6eecad2a3aa415eec418d38ec")).toBe(2);
    expect(breachCount(body, "ABCDEF0123456789ABCDEF0123456789ABC")).toBe(0);
    expect(breachCount(body, "FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF")).toBe(0);
  });

  it("flags short, common, repetitive and sequential passwords as weak", () => {
    for (const weak of ["abc12", "password123", "Password1!", "qwerty2024", "aaaaaaaaaaaa", "12345678", "abcdefgh", "87654321", "zxcvbnmq"])
      expect(isWeakPassword(weak), weak).toBe(true);
    for (const strong of ["Tr0ub4dor&3xyzzy!", "correct horse battery staple", "k9#Lm2$pQ8vR", "x8Fq2LmN0pZ7"]) expect(isWeakPassword(strong), strong).toBe(false);
  });

  it("counts reuse across logins, never for empty passwords", () => {
    const counts = reuseCounts([
      { id: "a", password: "same-one" },
      { id: "b", password: "same-one" },
      { id: "c", password: "same-one" },
      { id: "d", password: "unique" },
      { id: "e", password: "" },
      { id: "f", password: "" },
    ]);
    expect(Object.fromEntries(counts)).toEqual({ a: 2, b: 2, c: 2, d: 0 });
  });

  it("summarises the logins with something to fix", () => {
    expect(
      checkupSummary([
        { id: "a", breaches: 3, reusedWith: 1, weak: true },
        { id: "b", breaches: 0, reusedWith: 1, weak: false },
        { id: "c", breaches: null, reusedWith: 0, weak: true },
      ]),
    ).toEqual({ breached: 1, reused: 2, weak: 2 });
  });
});

describe("password checkup", () => {
  it("sends only 5-character prefixes, once per prefix, and matches the answer locally", async () => {
    const breached = "password123";
    const fine = "k9#Lm2$pQ8vR";
    const asked: string[] = [];
    const service = new PasswordCheckupService(async (url) => {
      asked.push(url);
      const prefix = url.slice(-5);
      return prefix === sha1(breached).slice(0, 5) ? `${sha1(breached).slice(5)}:251682\r\n${"0".repeat(35)}:0` : `${"1".repeat(35)}:7`;
    });
    service.endpoint = "https://range.test/range/";
    const profile = profileWith(
      [
        { id: "v1", password: breached },
        { id: "v2", password: breached },
        { id: "v3", password: fine },
        { id: "v4", password: "" },
      ],
      [{ id: "kp:db:1", password: fine }],
    );

    const before = service.view(profile);
    expect(before.checkedAt).toBeNull();
    expect(before.items.find((i) => i.id === "v1")?.breaches).toBeNull();

    const after = await service.run(profile);
    expect(asked.sort()).toEqual([`https://range.test/range/${sha1(breached).slice(0, 5)}`, `https://range.test/range/${sha1(fine).slice(0, 5)}`].sort());
    expect(asked.every((u) => !u.includes(sha1(breached).slice(5)) && !u.includes(breached))).toBe(true);
    const byId = Object.fromEntries(after.items.map((i) => [i.id, i]));
    expect(byId.v1).toEqual({ id: "v1", breaches: 251682, reusedWith: 1, weak: true });
    expect(byId.v3).toEqual({ id: "v3", breaches: 0, reusedWith: 1, weak: false });
    expect(byId["kp:db:1"]?.reusedWith).toBe(1);
    expect(byId.v4).toEqual({ id: "v4", breaches: 0, reusedWith: 0, weak: false });
    expect(after.checkedAt).not.toBeNull();
    expect(after.error).toBeNull();
  });

  it("reports a service it could not reach, and a changed password as not checked yet", async () => {
    const vault = [{ id: "v1", password: "k9#Lm2$pQ8vR" }];
    const service = new PasswordCheckupService(async () => {
      throw new Error("offline");
    });
    const failed = await service.run(profileWith(vault));
    expect(failed.error).toMatch(/Could not reach/);
    expect(failed.items[0]?.breaches).toBeNull();

    const ok = new PasswordCheckupService(async () => "");
    const profile = profileWith(vault);
    expect((await ok.run(profile)).items[0]?.breaches).toBe(0);
    vault[0]!.password = "another-Pa55word!";
    expect(ok.view(profile).items[0]?.breaches).toBeNull();
  });
});
