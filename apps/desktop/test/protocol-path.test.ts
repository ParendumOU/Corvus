import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ net: {}, protocol: {}, session: {}, app: { getPath: () => "/tmp", isPackaged: false } }));
vi.mock("../src/main/paths", () => ({ paths: { rendererDir: "/tmp/renderer" }, rendererDevUrl: null }));

const { decodedPath } = await import("../src/main/protocol");

describe("corvus:// paths", () => {
  it("decodes escapes and refuses a malformed one instead of throwing", () => {
    expect(decodedPath("/widget/a%20b")).toBe("/widget/a b");
    expect(decodedPath("/")).toBe("/");
    expect(decodedPath("/%E0%A4%A")).toBeNull();
    expect(decodedPath("/%")).toBeNull();
  });
});
