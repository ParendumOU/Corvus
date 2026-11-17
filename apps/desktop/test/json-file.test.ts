import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { JsonFile } from "../src/main/json-file";

const dirs: string[] = [];
function tempFile(content?: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "corvus-json-"));
  dirs.push(dir);
  const file = path.join(dir, "store.json");
  if (content !== undefined) fs.writeFileSync(file, content);
  return file;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("JsonFile.load", () => {
  it("is not fresh when the file reads", () => {
    const file = JsonFile.load(tempFile('["a"]'), () => [] as string[]);
    expect(file.get()).toEqual(["a"]);
    expect(file.fresh).toBe(false);
  });

  it("is fresh when the file is missing", () => {
    const file = JsonFile.load(tempFile(), () => [] as string[]);
    expect(file.get()).toEqual([]);
    expect(file.fresh).toBe(true);
  });

  it("moves a corrupt file aside and starts fresh", () => {
    const filePath = tempFile("[1,");
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const file = JsonFile.load(filePath, () => [] as number[], undefined, 0);
    expect(file.fresh).toBe(true);
    const backups = fs.readdirSync(path.dirname(filePath)).filter((f) => f.startsWith("store.json.corrupt-"));
    expect(backups).toHaveLength(1);
    file.set([2]);
    expect(JSON.parse(fs.readFileSync(filePath, "utf8"))).toEqual([2]);
  });

  it("never writes over a file it could neither read nor move aside", () => {
    const filePath = tempFile('["kept"]');
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const busy = Object.assign(new Error("EBUSY: resource busy or locked"), { code: "EBUSY" });
    vi.spyOn(fs, "readFileSync").mockImplementationOnce(() => {
      throw busy;
    });
    vi.spyOn(fs, "renameSync").mockImplementationOnce(() => {
      throw busy;
    });
    const file = JsonFile.load(filePath, () => [] as string[], undefined, 0);
    expect(file.fresh).toBe(true);
    file.set(["new"]);
    file.flush();
    vi.restoreAllMocks();
    expect(JSON.parse(fs.readFileSync(filePath, "utf8"))).toEqual(["kept"]);
  });
});
