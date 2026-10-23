import { describe, expect, it } from "vitest";
import {
  GRID_COLUMNS,
  MAX_WIDGETS,
  addWidget,
  customWidgetHosts,
  defaultConfig,
  defaultLayout,
  freeSpot,
  pendingConsent,
  placeWidget,
  sanitizeBackground,
  sanitizeLayout,
  type NewTabLayout,
  type WidgetInstance,
} from "../src/shared/newtab";

const overlapping = (ws: WidgetInstance[]): boolean =>
  ws.some((a, i) => ws.some((b, j) => i !== j && a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h));

describe("New Tab layout", () => {
  it("starts as today's page: greeting, search and top sites", () => {
    const layout = defaultLayout();
    expect(layout.background).toEqual({ kind: "default" });
    expect(layout.widgets.map((w) => w.type)).toEqual(["greeting", "search", "shortcuts"]);
    expect(overlapping(layout.widgets)).toBe(false);
  });

  it("adds widgets where they fit and never lets two overlap", () => {
    let layout: NewTabLayout = defaultLayout();
    layout = addWidget(layout, "clock");
    layout = addWidget(layout, "custom", { title: "Prices" });
    layout = addWidget(layout, "notes", {}, { x: 3, y: 0, w: 4, h: 4 });
    expect(layout.widgets.map((w) => w.id)).toEqual(["greeting", "search", "shortcuts", "clock-1", "custom-1", "notes-1"]);
    expect(layout.widgets.find((w) => w.id === "custom-1")?.config).toEqual({ ...defaultConfig("custom"), title: "Prices" });
    expect(overlapping(layout.widgets)).toBe(false);
    // The widget placed by hand keeps its spot; what it covered moved down.
    expect(layout.widgets.find((w) => w.id === "notes-1")).toMatchObject({ x: 3, y: 0 });
  });

  it("moves and resizes inside the grid, others make room and float back up", () => {
    let layout = addWidget(defaultLayout(), "clock");
    layout = placeWidget(layout, "clock-1", { x: 50, y: -3, w: 1, h: 99 });
    const clock = layout.widgets.find((w) => w.id === "clock-1")!;
    expect(clock.x + clock.w).toBeLessThanOrEqual(GRID_COLUMNS);
    expect(clock).toMatchObject({ y: 0, w: 2 });
    expect(overlapping(layout.widgets)).toBe(false);
    layout = placeWidget(layout, "clock-1", { x: 0, y: 40, h: 3 });
    expect(Math.min(...layout.widgets.map((w) => w.y))).toBe(0);
    expect(overlapping(layout.widgets)).toBe(false);
  });

  it("finds a free spot left to right, top to bottom", () => {
    expect(freeSpot([{ x: 0, y: 0, w: 6, h: 2 }], 6, 2)).toEqual({ x: 6, y: 0 });
    expect(freeSpot([{ x: 0, y: 0, w: 12, h: 2 }], 3, 1)).toEqual({ x: 0, y: 2 });
  });

  it("caps the number of widgets", () => {
    let layout: NewTabLayout = { ...defaultLayout(), widgets: [] };
    for (let i = 0; i < MAX_WIDGETS; i++) layout = addWidget(layout, "notes");
    expect(() => addWidget(layout, "notes")).toThrow(/at most/);
  });
});

describe("sanitizing stored and agent-sent layouts", () => {
  it("falls back to the default for garbage", () => {
    expect(sanitizeLayout(null)).toEqual(defaultLayout());
    expect(sanitizeLayout({ widgets: "nope" })).toEqual(defaultLayout());
  });

  it("drops unknown widgets, fixes ids and boxes, and keeps only safe values", () => {
    const layout = sanitizeLayout({
      background: { kind: "color", color: "#ABCDEF" },
      widgets: [
        { id: "a", type: "rocket", x: 0, y: 0, w: 4, h: 4 },
        { id: "a", type: "clock", x: -5, y: 2.6, w: 30, h: 1, config: { style: "analog", zones: ["Europe/Madrid", "'; drop"] } },
        { id: "a", type: "shortcuts", config: { pinned: [{ title: "Mail", url: "https://mail.example/" }, { title: "x", url: "javascript:alert(1)" }] } },
        { type: "notes", config: { text: 42 } },
      ],
    });
    expect(layout.background).toEqual({ kind: "color", color: "#abcdef" });
    expect(layout.widgets.map((w) => [w.id, w.type])).toEqual([
      ["a", "clock"],
      ["shortcuts-1", "shortcuts"],
      ["notes-1", "notes"],
    ]);
    expect(layout.widgets[0]).toMatchObject({ x: 0, w: 12, h: 2, config: { style: "analog", zones: ["Europe/Madrid"] } });
    expect(layout.widgets[1]!.config).toMatchObject({ pinned: [{ title: "Mail", url: "https://mail.example/" }] });
    expect(layout.widgets[2]!.config).toEqual({ text: "" });
    expect(overlapping(layout.widgets)).toBe(false);
  });

  it("only accepts uploaded image names and known wallpaper sources", () => {
    expect(sanitizeBackground({ kind: "image", file: "../../etc/passwd" })).toEqual({ kind: "default" });
    expect(sanitizeBackground({ kind: "image", file: "0f3a9c2b-1d.jpg", dim: 2, blur: -1 })).toEqual({ kind: "image", file: "0f3a9c2b-1d.jpg", dim: 0.8, blur: 0 });
    expect(sanitizeBackground({ kind: "wallpaper", source: "evil" })).toEqual({ kind: "default" });
    expect(sanitizeBackground({ kind: "wallpaper", source: "bing" })).toMatchObject({ kind: "wallpaper", source: "bing" });
  });

  it("keeps a custom widget's code within limits and its sources to http(s)", () => {
    const layout = sanitizeLayout({
      widgets: [
        {
          type: "custom",
          config: {
            title: "BTC",
            html: "x".repeat(70_000),
            sources: [
              { name: "price", kind: "fetch", url: "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=eur", everyMinutes: 0 },
              { name: "bad name", url: "https://a.example/" },
              { name: "file", url: "file:///etc/passwd" },
              { name: "news", kind: "feed", url: "https://news.example/rss" },
              { name: "mine", kind: "corvus", url: "watches" },
              { name: "nope", kind: "corvus", url: "history" },
            ],
            links: ["www.coingecko.com", "not a host!"],
          },
        },
      ],
    });
    const config = layout.widgets[0]!.config as ReturnType<typeof defaultConfig<"custom">>;
    expect(config.html.length).toBe(64 * 1024);
    expect(config.sources).toEqual([
      { name: "price", kind: "fetch", url: "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=eur", select: "", everyMinutes: 1 },
      { name: "news", kind: "feed", url: "https://news.example/rss", select: "", everyMinutes: 15 },
      { name: "mine", kind: "corvus", url: "watches", select: "", everyMinutes: 15 },
    ]);
    expect([...customWidgetHosts(config)].sort()).toEqual(["api.coingecko.com", "news.example", "www.coingecko.com"]);
  });

  it("reads pages with the person's session only for hosts they allowed, never too often", () => {
    const layout = sanitizeLayout({
      widgets: [
        {
          type: "custom",
          config: {
            sources: [
              { name: "x", kind: "page", url: "https://x.com/home", select: "[data-testid=primaryColumn]", everyMinutes: 1 },
              { name: "yt", kind: "page", url: "https://www.youtube.com/feed/subscriptions" },
            ],
            consent: ["x.com", "evil.example"],
          },
        },
      ],
    });
    const config = layout.widgets[0]!.config as ReturnType<typeof defaultConfig<"custom">>;
    expect(config.sources[0]).toMatchObject({ kind: "page", select: "[data-testid=primaryColumn]", everyMinutes: 10 });
    expect(config.consent).toEqual(["x.com"]);
    expect(pendingConsent(config)).toEqual(["www.youtube.com"]);
  });
});
