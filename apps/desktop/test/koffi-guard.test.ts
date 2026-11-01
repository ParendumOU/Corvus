import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const src = path.resolve(import.meta.dirname, "../src");

function sources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? sources(full) : /\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

const files = sources(src).map((file) => ({ name: path.relative(src, file).replaceAll("\\", "/"), text: fs.readFileSync(file, "utf8") }));

/**
 * Electron's V8 memory sandbox aborts the whole process on an ArrayBuffer over outside memory, which
 * is what koffi's view function makes (it closed Corvus on Windows on Import, v0.34.0). A fault there
 * must stay in the DPAPI worker, so koffi never loads in the main process either.
 */
describe("koffi stays out of harm's way", () => {
  it("its view function is not used anywhere", () => {
    expect(files.filter((f) => /\bkoffi\s*\??\.\s*view\b/.test(f.text) || /\bview\s*[:,}][^;\n]*from\s+["']koffi["']/.test(f.text)).map((f) => f.name)).toEqual([]);
  });

  it("only dpapi-native.ts loads it", () => {
    const loads = files.filter((f) => /(?:require\(|createRequire\([^)]*\)\(|from\s+|import\()\s*["']koffi["']/.test(f.text.replace(/typeof import\("koffi"\)/g, ""))).map((f) => f.name);
    expect(loads).toEqual(["main/dpapi-native.ts"]);
  });

  it("only the worker and the smoke reach the native module, so the main process never loads koffi on a real import", () => {
    const users = files.filter((f) => /from\s+["']\.\/dpapi-native["']/.test(f.text)).map((f) => f.name);
    expect(users.filter((name) => name !== "main/dpapi-worker.ts" && !name.startsWith("main/smoke"))).toEqual([]);
    expect(users).toContain("main/dpapi-worker.ts");
  });
});
