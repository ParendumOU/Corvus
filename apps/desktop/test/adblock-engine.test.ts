import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({}));

import { ElectronBlocker, Request } from "@ghostery/adblocker-electron";
import { buildEngine } from "../src/main/adblock-engine";

const script = (url: string): Request => Request.fromRawDetails({ url, type: "script", sourceUrl: "https://site.example/" });

describe("filter list parser", () => {
  it("builds a serialized engine that blocks what the lists say", () => {
    const built = buildEngine(["||ads.example^", "@@||ads.example/allowed.js", "site.example##.banner", "! a comment"].join("\n"), null);
    expect(built.filterCount).toBe(3);
    const engine = ElectronBlocker.deserialize(built.bytes);
    expect(engine.match(script("https://ads.example/a.js")).match).toBe(true);
    expect(engine.match(script("https://ads.example/allowed.js")).match).toBe(false);
    expect(engine.match(script("https://cdn.example/a.js")).match).toBe(false);
  });
});
