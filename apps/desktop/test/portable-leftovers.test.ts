import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isPortableLeftover, removePortableLeftovers } from "../src/main/portable-leftovers";

const HOUR = 60 * 60 * 1000;

describe("portable launcher leftovers", () => {
  let temp: string;
  const make = (dir: string, files: string[], ageMs: number): void => {
    for (const file of files) {
      fs.mkdirSync(path.dirname(path.join(temp, dir, file)), { recursive: true });
      fs.writeFileSync(path.join(temp, dir, file), "x");
    }
    const at = new Date(Date.now() - ageMs);
    fs.utimesSync(path.join(temp, dir), at, at);
  };

  beforeEach(() => {
    temp = fs.mkdtempSync(path.join(os.tmpdir(), "leftovers-"));
  });
  afterEach(() => fs.rmSync(temp, { recursive: true, force: true }));

  it("knows an unpacked app and a launcher work folder, nothing else", () => {
    const has = (files: string[]) => (relative: string) => files.includes(relative.replace(/\\/g, "/"));
    expect(isPortableLeftover("3LXriSXn60sSrZ9B9mwCcKp40oz", has(["Corvus.exe", "resources/app.asar"]))).toBe(true);
    expect(isPortableLeftover("nsq752B.tmp", has(["7z-out/Corvus.exe"]))).toBe(true);
    expect(isPortableLeftover("3LXriSXn60sSrZ9B9mwCcKp40oz", has(["Corvus.exe"]))).toBe(false);
    expect(isPortableLeftover("nsq752B.tmp", has(["7z-out/Other.exe"]))).toBe(false);
    expect(isPortableLeftover("some-other-app", has(["Corvus.exe", "resources/app.asar"]))).toBe(false);
  });

  it("removes old leftovers and keeps recent ones and other folders", async () => {
    make("3L9kUjIDuJE3SCyUAdD4csovKYU", ["Corvus.exe", "resources/app.asar"], 2 * HOUR);
    make("nsdC8F2.tmp", ["7z-out/Corvus.exe", "app-64.7z"], 2 * HOUR);
    make("nsa1319.tmp", ["7z-out/Corvus.exe"], 5 * 60 * 1000);
    make("nskF0CF.tmp", ["7z-out/Setup.exe"], 2 * HOUR);
    make("3LKmUKkWx9oDyZ4GWPT1BgyuH9I", ["notes.txt"], 2 * HOUR);
    expect(await removePortableLeftovers(temp)).toBe(2);
    expect(fs.readdirSync(temp).sort()).toEqual(["3LKmUKkWx9oDyZ4GWPT1BgyuH9I", "nsa1319.tmp", "nskF0CF.tmp"]);
  });

  it("does nothing when the temp folder is missing", async () => {
    expect(await removePortableLeftovers(path.join(temp, "missing"))).toBe(0);
  });
});
