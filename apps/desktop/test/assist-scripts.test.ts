import { describe, expect, it } from "vitest";
import { applyTranslationsScript, collectSegmentsScript, restoreTranslationScript } from "../src/main/assist-scripts";

/** A small stand-in for a page: one visible paragraph holding text nodes, in document order. */
interface FakeText {
  nodeValue: string;
  parentElement: object;
  isConnected: boolean;
  splitText(offset: number): FakeText;
}

function page(values: string[]) {
  const paragraph = { getClientRects: () => [{}], closest: () => null };
  const nodes: FakeText[] = [];
  const text = (value: string): FakeText => ({
    nodeValue: value,
    parentElement: paragraph,
    isConnected: true,
    splitText(offset) {
      const rest = text(this.nodeValue.slice(offset));
      this.nodeValue = this.nodeValue.slice(0, offset);
      nodes.splice(nodes.indexOf(this) + 1, 0, rest);
      return rest;
    },
  });
  nodes.push(...values.map(text));
  const NodeFilter = { SHOW_TEXT: 4, FILTER_ACCEPT: 1, FILTER_REJECT: 2 };
  const document = {
    body: {},
    querySelector: () => null,
    createTreeWalker: (_root: unknown, _what: number, filter: { acceptNode(n: FakeText): number }) => {
      let current: FakeText | null = null;
      return {
        nextNode(): FakeText | null {
          for (let i = current ? nodes.indexOf(current) + 1 : 0; i < nodes.length; i++) {
            if (filter.acceptNode(nodes[i]!) === NodeFilter.FILTER_ACCEPT) return (current = nodes[i]!);
          }
          return null;
        },
      };
    },
  };
  const window: Record<string, unknown> = {};
  const run = <T>(code: string): T =>
    new Function("document", "NodeFilter", "getComputedStyle", "window", `return ${code}`)(document, NodeFilter, () => ({ visibility: "visible", display: "block" }), window) as T;
  return { nodes, run, text: () => nodes.map((n) => n.nodeValue).join("") };
}

describe("page translation scripts", () => {
  it("translates a text node longer than one segment in full, in pieces split at words", () => {
    const long = `${"word ".repeat(150).trim()}.`;
    const p = page([`  ${long}  `]);
    const batch = p.run<{ segments: string[]; more: boolean }>(collectSegmentsScript(120, 4500));
    expect(batch.segments.length).toBeGreaterThan(2);
    expect(batch.segments.every((s) => s.length <= 300)).toBe(true);
    expect(batch.segments.join(" ")).toBe(long);
    // The page text is unchanged by the split.
    expect(p.text()).toBe(`  ${long}  `);

    const changed = p.run<number>(applyTranslationsScript(batch.segments.map((s) => s.toUpperCase())));
    expect(changed).toBe(batch.segments.length);
    expect(p.text().replace(/\s+/g, " ").trim()).toBe(long.toUpperCase());

    p.run(restoreTranslationScript());
    expect(p.text()).toBe(`  ${long}  `);
  });

  it("leaves the rest of a long node for the next batch when the batch is full", () => {
    const p = page(["a".repeat(250), `${"word ".repeat(100).trim()}`]);
    const batch = p.run<{ segments: string[]; more: boolean }>(collectSegmentsScript(2, 4500));
    expect(batch.segments).toHaveLength(2);
    expect(batch.more).toBe(true);
    p.run(applyTranslationsScript([null, null]));
    const next = p.run<{ segments: string[]; more: boolean }>(collectSegmentsScript(2, 4500));
    expect(next.segments.length).toBeGreaterThan(0);
  });
});
