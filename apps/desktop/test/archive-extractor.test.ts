import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({}));

import { extractArchive, type SevenZipRun } from "../src/main/archive-extractor";
import { runSevenZip } from "../src/main/sevenzip";
import { archiveSets } from "../src/shared/archives";

const FIXTURES = path.join(import.meta.dirname, "fixtures", "archives");

/** 30 000 bytes of noise (the generator the RAR fixtures were made with). */
function payload(): Buffer {
  const b = Buffer.alloc(30_000);
  let x = 1;
  for (let i = 0; i < b.length; i++) {
    x = (x * 1103515245 + 12345) >>> 0;
    b[i] = x >>> 24;
  }
  return b;
}

const dirs: string[] = [];
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "corvus-archive-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function copyFixtures(dir: string, names: string[]): void {
  for (const name of names) fs.copyFileSync(path.join(FIXTURES, name), path.join(dir, name));
}

const sha256 = (file: string): string => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

const runner = (dir: string): SevenZipRun => (args) => runSevenZip(dir, args);
const setOf = (dir: string) => archiveSets(fs.readdirSync(dir))[0]!;

describe("extractArchive (7-Zip)", () => {
  it("extracts a multi-volume RAR5 with encrypted names, trying the passwords in order", async () => {
    const dir = tempDir();
    copyFixtures(dir, ["Secret.part1.rar", "Secret.part2.rar"]);
    const set = setOf(dir);
    expect(set.volumes).toEqual(["Secret.part1.rar", "Secret.part2.rar"]);
    const out = await extractArchive(runner(dir), set, ["wrong", "corvus-rar", "later"]);
    expect(out).toEqual({ status: "done", files: 2, password: "corvus-rar" });
    expect(sha256(path.join(dir, "payload.bin"))).toBe("3649d9bfc363a45a7f5834cdbf4fcfb2729d0f05df0e67631eeb76d1ff397cb1");
    expect(fs.readFileSync(path.join(dir, "payload.bin")).equals(payload())).toBe(true);
    expect(fs.readFileSync(path.join(dir, "readme.txt"), "utf8")).toBe("Corvus archive fixture\n");
  }, 60_000);

  it("asks for a password when none of the candidates opens it", async () => {
    const dir = tempDir();
    copyFixtures(dir, ["Secret.part1.rar", "Secret.part2.rar"]);
    expect(await extractArchive(runner(dir), setOf(dir), ["nope", "Secret"])).toEqual({ status: "password" });
    expect(fs.existsSync(path.join(dir, "payload.bin"))).toBe(false);
  }, 60_000);

  it("extracts an archive without a password", async () => {
    const dir = tempDir();
    copyFixtures(dir, ["Plain.rar"]);
    expect(await extractArchive(runner(dir), setOf(dir), ["unused"])).toEqual({ status: "done", files: 1, password: null });
    expect(fs.readFileSync(path.join(dir, "readme.txt"), "utf8")).toBe("Corvus archive fixture\n");
  }, 60_000);

  it("extracts a split 7z with encrypted headers and a zip whose files are encrypted", async () => {
    const src = tempDir();
    fs.writeFileSync(path.join(src, "payload.bin"), payload());
    expect((await runSevenZip(src, ["a", "-mx0", "-v10k", "-pseven-pw", "-mhe=on", "-bsp0", "-y", "Movie.7z", "payload.bin"])).code).toBe(0);
    expect((await runSevenZip(src, ["a", "-tzip", "-pzip-pw", "-bsp0", "-y", "Docs.zip", "payload.bin"])).code).toBe(0);

    const seven = tempDir();
    for (const name of fs.readdirSync(src).filter((n) => n.startsWith("Movie.7z."))) fs.copyFileSync(path.join(src, name), path.join(seven, name));
    const set = setOf(seven);
    expect(set.entry).toBe("Movie.7z.001");
    expect(set.volumes.length).toBeGreaterThan(2);
    expect(await extractArchive(runner(seven), set, ["Movie", "seven-pw"])).toEqual({ status: "done", files: 1, password: "seven-pw" });
    expect(fs.readFileSync(path.join(seven, "payload.bin")).equals(payload())).toBe(true);

    const zip = tempDir();
    fs.copyFileSync(path.join(src, "Docs.zip"), path.join(zip, "Docs.zip"));
    expect(await extractArchive(runner(zip), setOf(zip), ["bad", "zip-pw"])).toEqual({ status: "done", files: 1, password: "zip-pw" });
    expect(fs.readFileSync(path.join(zip, "payload.bin")).equals(payload())).toBe(true);
  }, 60_000);

  it("joins a file cut into .001, .002, ... parts", async () => {
    const dir = tempDir();
    const data = payload();
    fs.writeFileSync(path.join(dir, "video.mkv.001"), data.subarray(0, 12_000));
    fs.writeFileSync(path.join(dir, "video.mkv.002"), data.subarray(12_000, 24_000));
    fs.writeFileSync(path.join(dir, "video.mkv.003"), data.subarray(24_000));
    const set = setOf(dir);
    expect(set).toMatchObject({ entry: "video.mkv.001", kind: "split" });
    expect(await extractArchive(runner(dir), set, [])).toMatchObject({ status: "done", password: null });
    expect(fs.readFileSync(path.join(dir, "video.mkv")).equals(data)).toBe(true);
  }, 60_000);

  it("fails with 7-Zip's reason on a broken archive", async () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, "Broken.part1.rar"), "not an archive at all\n");
    const out = await extractArchive(runner(dir), setOf(dir), ["x"]);
    expect(out.status).toBe("failed");
    expect((out as { error: string }).error).toMatch(/archive/i);
  }, 60_000);

  it("fails when a volume is missing", async () => {
    const dir = tempDir();
    copyFixtures(dir, ["Secret.part1.rar"]);
    const out = await extractArchive(runner(dir), setOf(dir), ["corvus-rar"]);
    expect(out.status).toBe("failed");
  }, 60_000);
});
