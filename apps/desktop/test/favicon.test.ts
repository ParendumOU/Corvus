import { describe, expect, it } from "vitest";
import { MAX_SAVED_FAVICON_URL, faviconSrcToShow, isFaviconUrl, pickFavicon } from "../src/shared/favicon";
import { faviconsFromHistory, type HistoryRecord } from "../src/shared/history-ops";
import { buildSnapshot, reviveSession, serializeWindow, type LiveWindow } from "../src/shared/session-state";

describe("favicon selection", () => {
  it("keeps the first web or inline icon a page reports", () => {
    expect(pickFavicon(["chrome://favicon/x", "https://a.test/favicon.ico", "https://a.test/icon.svg"])).toBe("https://a.test/favicon.ico");
    expect(pickFavicon(["data:image/png;base64,AAAA"])).toBe("data:image/png;base64,AAAA");
    expect(pickFavicon(["javascript:alert(1)", "file:///icon.png"])).toBeUndefined();
    expect(pickFavicon([])).toBeUndefined();
  });

  it("accepts only web and data: URLs, within a length limit when asked", () => {
    expect(isFaviconUrl("HTTPS://A.test/f.ico")).toBe(true);
    expect(isFaviconUrl("http://a.test/f.ico")).toBe(true);
    expect(isFaviconUrl("javascript:alert(1)")).toBe(false);
    expect(isFaviconUrl(42)).toBe(false);
    expect(isFaviconUrl(undefined)).toBe(false);
    const big = `data:image/png;base64,${"A".repeat(MAX_SAVED_FAVICON_URL)}`;
    expect(isFaviconUrl(big)).toBe(true);
    expect(isFaviconUrl(big, MAX_SAVED_FAVICON_URL)).toBe(false);
  });
});

describe("<Favicon> source", () => {
  it("shows the icon until that icon fails", () => {
    expect(faviconSrcToShow("https://a.test/f.ico", null)).toBe("https://a.test/f.ico");
    expect(faviconSrcToShow("https://a.test/f.ico", "https://a.test/f.ico")).toBeUndefined();
    expect(faviconSrcToShow(undefined, null)).toBeUndefined();
  });

  it("shows a new icon after an earlier one failed (regression: one failure hid every later icon)", () => {
    expect(faviconSrcToShow("https://a.test/good.png", "https://a.test/missing.png")).toBe("https://a.test/good.png");
  });
});

describe("favicons from history", () => {
  const entry = (url: string, visitedAt: number, faviconUrl?: string): HistoryRecord => ({
    id: url,
    url,
    title: "",
    visitedAt,
    visitCount: 1,
    ...(faviconUrl ? { faviconUrl } : {}),
  });
  const history: HistoryRecord[] = [
    entry("https://www.google.com/search?q=x", 300, "https://www.google.com/s.ico"),
    entry("https://www.google.com/", 100, "https://www.gstatic.com/home.ico"),
    entry("https://www.google.com/maps", 200, "https://www.google.com/maps.ico"),
    entry("https://parendum.com/", 50, "https://parendum.com/favicon.ico"),
    entry("https://parendum.com:8443/", 400, "https://parendum.com:8443/other.ico"),
    entry("https://noicon.test/", 10),
    entry("https://evil.test/", 10, "javascript:alert(1)"),
  ];

  it("prefers the page's own icon, else the most recent icon of the same site", () => {
    const icons = faviconsFromHistory(history, [
      "https://www.google.com/",
      "https://www.google.com/imghp",
      "https://parendum.com/about",
      "https://noicon.test/",
      "https://evil.test/",
      "https://unknown.test/",
      "corvus://newtab/",
    ]);
    expect(icons.get("https://www.google.com/")).toBe("https://www.gstatic.com/home.ico");
    expect(icons.get("https://www.google.com/imghp")).toBe("https://www.google.com/s.ico");
    expect(icons.get("https://parendum.com/about")).toBe("https://parendum.com/favicon.ico");
    expect(icons.has("https://noicon.test/")).toBe(false);
    expect(icons.has("https://evil.test/")).toBe(false);
    expect(icons.has("https://unknown.test/")).toBe(false);
    expect(icons.has("corvus://newtab/")).toBe(false);
  });

  it("returns nothing for an empty history or no URLs", () => {
    expect(faviconsFromHistory([], ["https://a.test/"]).size).toBe(0);
    expect(faviconsFromHistory(history, []).size).toBe(0);
  });
});

describe("session favicons", () => {
  const icon = "https://a.test/favicon.ico";
  const live: LiveWindow = {
    profileId: "default",
    maximized: false,
    tabs: [
      { url: "https://a.test/", title: "A", pinned: false, faviconUrl: icon, active: true },
      { url: "https://b.test/", title: "B", pinned: false, faviconUrl: "javascript:alert(1)", active: false },
      { url: "https://c.test/", title: "C", pinned: false, faviconUrl: `data:image/png;base64,${"A".repeat(MAX_SAVED_FAVICON_URL)}`, active: false },
      { url: "https://d.test/", title: "D", pinned: false, active: false },
    ],
    groups: [],
  };

  it("saves each tab's icon so unloaded restored tabs can show it", () => {
    const w = serializeWindow(live);
    expect(w?.tabs.map((t) => t.faviconUrl)).toEqual([icon, undefined, undefined, undefined]);
    const revived = reviveSession(JSON.parse(JSON.stringify(buildSnapshot([w], 1))));
    expect(revived?.windows[0]?.tabs[0]).toEqual({ url: "https://a.test/", title: "A", pinned: false, faviconUrl: icon });
  });

  it("drops icons a session file should not carry", () => {
    const revived = reviveSession({
      version: 1,
      savedAt: 1,
      windows: [
        {
          profileId: "p",
          tabs: [
            { url: "https://a.test/", faviconUrl: "javascript:alert(1)" },
            { url: "https://b.test/", faviconUrl: 7 },
            { url: "https://c.test/", faviconUrl: "data:image/svg+xml,<svg/>" },
          ],
        },
      ],
    });
    expect(revived?.windows[0]?.tabs.map((t) => t.faviconUrl)).toEqual([undefined, undefined, "data:image/svg+xml,<svg/>"]);
  });
});
