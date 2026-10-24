import { describe, expect, it } from "vitest";
import { chromiumSession, decodeMozLz4, firefoxSession, lz4Block } from "../src/shared/browser-sessions";

// ------------------------------------------------------------------ writers for the tests

/** A base::Pickle: 4-byte payload size, fields padded to 4 bytes. */
class Pickle {
  private parts: Uint8Array[] = [];
  private push(bytes: Uint8Array): this {
    const padded = new Uint8Array((bytes.length + 3) & ~3);
    padded.set(bytes);
    this.parts.push(padded);
    return this;
  }
  int(v: number): this {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setInt32(0, v, true);
    return this.push(b);
  }
  uint64(v: bigint): this {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setBigUint64(0, v, true);
    return this.push(b);
  }
  string(s: string): this {
    const bytes = new TextEncoder().encode(s);
    return this.int(bytes.length).push(bytes);
  }
  string16(s: string): this {
    const bytes = new Uint8Array(s.length * 2);
    for (let i = 0; i < s.length; i++) new DataView(bytes.buffer).setUint16(i * 2, s.charCodeAt(i), true);
    return this.int(s.length).push(bytes);
  }
  bytes(): Uint8Array {
    const size = this.parts.reduce((n, p) => n + p.length, 0);
    const out = new Uint8Array(4 + size);
    new DataView(out.buffer).setUint32(0, size, true);
    let at = 4;
    for (const p of this.parts) {
      out.set(p, at);
      at += p.length;
    }
    return out;
  }
}

function struct(...fields: Array<["i32", number] | ["bool", boolean] | ["pad", number] | ["u64", bigint]>): Uint8Array {
  const size = fields.reduce((n, [k, v]) => n + (k === "i32" ? 4 : k === "bool" ? 1 : k === "u64" ? 8 : (v as number)), 0);
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  let at = 0;
  for (const [kind, value] of fields) {
    if (kind === "i32") view.setInt32(at, value as number, true), (at += 4);
    else if (kind === "bool") (out[at] = value ? 1 : 0), (at += 1);
    else if (kind === "u64") view.setBigUint64(at, value as bigint, true), (at += 8);
    else at += value as number;
  }
  return out;
}

function snss(commands: Array<[number, Uint8Array]>): Uint8Array {
  const parts: number[] = [..."SNSS"].map((c) => c.charCodeAt(0));
  parts.push(3, 0, 0, 0);
  for (const [id, body] of commands) {
    const size = body.length + 1;
    parts.push(size & 255, size >> 8, id, ...body);
  }
  return Uint8Array.from(parts);
}

const nav = (tab: number, index: number, url: string, title: string): [number, Uint8Array] => [6, new Pickle().int(tab).int(index).string(url).string16(title).string("").int(0).bytes()];

describe("Chromium session files", () => {
  it("replays the commands into windows, tabs in order, the selected page, pins and groups", () => {
    const file = snss([
      [9, struct(["i32", 1], ["i32", 0])],
      [0, struct(["i32", 1], ["i32", 10])],
      [0, struct(["i32", 1], ["i32", 11])],
      [0, struct(["i32", 1], ["i32", 12])],
      [2, struct(["i32", 10], ["i32", 2])],
      [2, struct(["i32", 11], ["i32", 0])],
      [2, struct(["i32", 12], ["i32", 1])],
      nav(10, 0, "https://a.example/", "A"),
      nav(10, 1, "https://a.example/next", "A next"),
      [7, struct(["i32", 10], ["i32", 0])],
      nav(11, 0, "https://pinned.example/", "Pinned"),
      [12, struct(["i32", 11], ["bool", true], ["pad", 3])],
      nav(12, 0, "https://grouped.example/", "Grouped"),
      [25, struct(["i32", 12], ["pad", 4], ["u64", 0xabcn], ["u64", 0x123n], ["bool", true], ["pad", 7])],
      [27, new Pickle().uint64(0xabcn).uint64(0x123n).string16("Research").int(4).int(1).bytes()],
      // A popup window and a closed tab are left out.
      [9, struct(["i32", 2], ["i32", 1])],
      [0, struct(["i32", 2], ["i32", 20])],
      nav(20, 0, "https://popup.example/", "Popup"),
      [0, struct(["i32", 1], ["i32", 13])],
      nav(13, 0, "https://closed.example/", "Closed"),
      [16, struct(["i32", 13], ["pad", 4], ["u64", 1n])],
    ]);
    expect(chromiumSession(file)).toEqual([
      {
        tabs: [
          { url: "https://pinned.example/", title: "Pinned", pinned: true },
          { url: "https://grouped.example/", title: "Grouped", pinned: false, groupId: "g-abc-123" },
          { url: "https://a.example/", title: "A", pinned: false },
        ],
        groups: [{ id: "g-abc-123", title: "Research", color: "green", collapsed: true }],
      },
    ]);
  });

  it("uses the latest page when none is selected, skips damaged commands and stops at a cut file", () => {
    const file = snss([
      [0, struct(["i32", 5], ["i32", 1])],
      nav(1, 0, "https://first.example/", "First"),
      nav(1, 3, "https://latest.example/", "Latest"),
      [6, Uint8Array.from([9, 9])],
      [7, Uint8Array.from([1])],
    ]);
    const cut = Uint8Array.from([...file, 200, 0, 6, 1, 2]);
    expect(chromiumSession(cut)).toEqual([{ tabs: [{ url: "https://latest.example/", title: "Latest", pinned: false }], groups: [] }]);
    expect(() => chromiumSession(Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]))).toThrow(/Not a Chromium session/);
  });
});

describe("Firefox session files", () => {
  it("decodes LZ4 blocks with matches", () => {
    // "abcabcabcabcX": literals "abc", then a match of 9 bytes 3 back, then the last literal.
    const block = Uint8Array.from([0x35, 0x61, 0x62, 0x63, 0x03, 0x00, 0x10, 0x58]);
    const out = new Uint8Array(13);
    expect(lz4Block(block, out)).toBe(13);
    expect(new TextDecoder().decode(out)).toBe("abcabcabcabcX");
    expect(() => lz4Block(Uint8Array.from([0x10, 0x61, 0x09, 0x00]), new Uint8Array(10))).toThrow(/Damaged/);
  });

  it("reads mozLz4 files and the windows, tabs and groups in them", () => {
    const json = JSON.stringify({
      windows: [
        {
          tabs: [
            { entries: [{ url: "https://old.example/", title: "Old" }, { url: "https://current.example/", title: "Current" }], index: 2, pinned: true },
            { entries: [{ url: "https://grouped.example/", title: "Grouped" }], index: 1, groupId: "123-1" },
            { entries: [], index: 1 },
          ],
          groups: [
            { id: "123-1", name: "Trip", color: "gray", collapsed: false },
            { id: "unused", name: "Empty", color: "blue" },
          ],
        },
        { tabs: [] },
      ],
    });
    const text = new TextEncoder().encode(json);
    // Literals only: one sequence holding the whole text.
    const head = [0xf0];
    let rest = text.length - 15;
    while (rest >= 255) {
      head.push(255);
      rest -= 255;
    }
    head.push(rest);
    const size = new Uint8Array(4);
    new DataView(size.buffer).setUint32(0, text.length, true);
    const file = Uint8Array.from([...new TextEncoder().encode("mozLz40\0"), ...size, ...head, ...text]);
    const session = firefoxSession(JSON.parse(decodeMozLz4(file)));
    expect(session).toEqual([
      {
        tabs: [
          { url: "https://current.example/", title: "Current", pinned: true },
          { url: "https://grouped.example/", title: "Grouped", pinned: false, groupId: "123-1" },
        ],
        groups: [{ id: "123-1", title: "Trip", color: "grey", collapsed: false }],
      },
    ]);
    expect(() => decodeMozLz4(new TextEncoder().encode("not a session file"))).toThrow(/mozLz4/);
  });
});
