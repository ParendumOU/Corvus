import { describe, expect, it } from "vitest";
import { sanitizeLayout, type CustomSource } from "../src/shared/newtab";
import { sourceComplete } from "../src/renderer/pages/newtab-sources";

const source = (patch: Partial<CustomSource>): CustomSource => ({ name: "prices", kind: "fetch", url: "https://example.com/data.json", select: "", everyMinutes: 15, ...patch });
const kept = (s: CustomSource): boolean => {
  const layout = sanitizeLayout({ widgets: [{ id: "w1", type: "custom", x: 0, y: 0, w: 3, h: 3, config: { sources: [s] } }] });
  return (layout.widgets[0]!.config as { sources: CustomSource[] }).sources.length === 1;
};

describe("custom widget source editor", () => {
  it("holds back exactly the sources the store would drop", () => {
    const cases = [
      source({}),
      source({ url: "" }),
      source({ url: "https://" }),
      source({ url: "ftp://example.com/" }),
      source({ name: "" }),
      source({ name: "1st" }),
      source({ kind: "corvus", url: "watches" }),
      source({ kind: "page", url: "https://example.com/" }),
    ];
    for (const s of cases) expect(sourceComplete(s), JSON.stringify(s)).toBe(kept(s));
  });
});
