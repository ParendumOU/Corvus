import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const MAIN = fileURLToPath(new URL("../src/main/", import.meta.url));
const source = (file: string): string => fs.readFileSync(`${MAIN}${file}`, "utf8");

/** Static value imports of a module (type-only imports aside). */
const staticImports = (src: string): string[] => [...src.matchAll(/^import (?!type )[^;]*? from "([^"]+)";/gm)].map((m) => m[1]!);

describe("what a normal start loads", () => {
  it("leaves the self-test and the marketing capture out of the main entry", () => {
    const imports = staticImports(source("index.ts"));
    expect(imports.filter((i) => /smoke|capture/.test(i))).toEqual([]);
  });

  it("loads the MCP server package only when the server starts", () => {
    for (const file of fs.readdirSync(MAIN).filter((f) => f.endsWith(".ts") && !f.startsWith("smoke"))) {
      expect(staticImports(source(file)), file).not.toContain("@corvus/mcp-server");
    }
  });
});
