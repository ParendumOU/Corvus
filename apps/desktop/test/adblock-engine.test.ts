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

describe("engine rules", () => {
  const youtube = { url: "https://www.youtube.com/", hostname: "www.youtube.com", domain: "youtube.com", getBaseRules: false, getInjectionRules: false, getExtendedRules: true, getRulesFromHostname: true, getRulesFromDOM: false };

  it("keeps the procedural filters CSS cannot express", () => {
    const engine = ElectronBlocker.deserialize(buildEngine("youtube.com##.promo:has-text(Sponsored)", null).bytes);
    const { extended, styles } = engine.getCosmeticsFilters(youtube);
    expect(extended).toHaveLength(1);
    expect(extended[0]?.attribute).toBeTruthy();
    expect(styles).toContain(`[${extended[0]?.attribute}]`);
  });

  it("applies only the !#if blocks meant for Chromium", () => {
    const lists = ["!#if env_firefox", "youtube.com##.firefox", "!#else", "youtube.com##.chromium", "!#endif", "!#if ext_ubol", "youtube.com##.lite", "!#endif", "!#if env_chromium", "youtube.com##.both", "!#endif"].join("\n");
    const engine = ElectronBlocker.deserialize(buildEngine(lists, null).bytes);
    const { styles } = engine.getCosmeticsFilters({ ...youtube, getExtendedRules: false });
    expect(styles).toContain(".chromium");
    expect(styles).toContain(".both");
    expect(styles).not.toContain(".firefox");
    expect(styles).not.toContain(".lite");
  });
});
