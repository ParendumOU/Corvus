import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { evalSnippets, filterCompactRules, type IndexedCMPRuleset } from "@duckduckgo/autoconsent";
import compactRules from "@duckduckgo/autoconsent/rules/compact-rules.json";
import {
  ConsentTabs,
  GPC_PAGE_SCRIPT,
  addSite,
  cmpDisplayName,
  consentConfig,
  isConsentPageUrl,
  isConsentSnippetId,
  isSettledLifecycle,
  nextConsentState,
  normalizeSite,
  parseConsentEvent,
  removeSite,
  reviveSiteList,
  shouldRunConsent,
  siteListMatches,
  toConsentEvent,
  withGpcHeader,
} from "@corvus/shared";
import { clientHintHeaders, outgoingHeaders } from "../src/main/user-agent";

vi.mock("electron", () => ({ ipcMain: { on: () => undefined, handle: () => undefined }, webContents: { fromId: () => null } }));

describe("cookie consent config", () => {
  it("rejects, prehides and keeps cosmetic rules as the fallback", () => {
    const config = consentConfig();
    expect(config).toMatchObject({ enabled: true, autoAction: "optOut", enablePrehide: true, enableCosmeticRules: true, isMainWorld: false, heuristicMode: "off" });
    expect(Object.values(config.logs).every((v) => v === false)).toBe(true);
    expect(consentConfig({ mainWorld: true }).isMainWorld).toBe(true);
  });

  it("runs only on web pages whose site is not excepted", () => {
    expect(isConsentPageUrl("https://example.com/")).toBe(true);
    expect(isConsentPageUrl("corvus://newtab/")).toBe(false);
    expect(isConsentPageUrl("file:///tmp/a.html")).toBe(false);
    expect(isConsentPageUrl("not a url")).toBe(false);
    expect(shouldRunConsent(true, "https://news.example.com/a", "https://cmp.vendor.net/frame", [])).toBe(true);
    expect(shouldRunConsent(false, "https://example.com/", "https://example.com/", [])).toBe(false);
    expect(shouldRunConsent(true, "corvus://settings/", "https://example.com/", [])).toBe(false);
    expect(shouldRunConsent(true, "https://news.example.com/a", "https://cmp.vendor.net/frame", ["example.com"])).toBe(false);
    expect(shouldRunConsent(true, "https://example.org/", "https://example.org/", ["example.com"])).toBe(true);
  });

  it("keeps a forgiving list of excepted sites", () => {
    expect(normalizeSite("WWW.Example.COM.")).toBe("example.com");
    expect(normalizeSite("https://www.example.com/path")).toBe("example.com");
    expect(siteListMatches("shop.example.com", ["example.com"])).toBe(true);
    expect(siteListMatches("badexample.com", ["example.com"])).toBe(false);
    expect(addSite(["b.com"], "www.a.com")).toEqual(["a.com", "b.com"]);
    expect(addSite(["a.com"], "a.com")).toEqual(["a.com"]);
    // Turning the switch off on a subdomain removes the site entry it falls under.
    expect(removeSite(["example.com", "other.com"], "shop.example.com")).toEqual(["other.com"]);
    expect(reviveSiteList(["B.com", 3, "", "b.com", "x".repeat(300)])).toEqual(["b.com"]);
    expect(reviveSiteList("nope")).toEqual([]);
  });
});

describe("cookie consent messages", () => {
  it("passes on only plain, known fields from Autoconsent's messages", () => {
    expect(toConsentEvent({ type: "popupFound", cmp: "Onetrust", url: "https://secret.example/?token=1" })).toEqual({ type: "popupFound", cmp: "Onetrust" });
    expect(toConsentEvent({ type: "optOutResult", cmp: "Onetrust", result: true, scheduleSelfTest: true, url: "x" })).toEqual({ type: "optOutResult", cmp: "Onetrust", result: true });
    expect(toConsentEvent({ type: "autoconsentDone", cmp: "didomi", isCosmetic: false, url: "x", duration: 3, totalClicks: 1 })).toEqual({
      type: "autoconsentDone",
      cmp: "didomi",
      isCosmetic: false,
    });
    expect(toConsentEvent({ type: "report", state: {} })).toBeNull();
    expect(toConsentEvent({ type: "eval", id: "1", code: "alert(1)" })).toBeNull();
    expect(toConsentEvent(null)).toBeNull();
  });

  it("validates messages again on the trusted side", () => {
    expect(parseConsentEvent({ type: "settled" })).toEqual({ type: "settled" });
    expect(parseConsentEvent({ type: "autoconsentDone", cmp: "x", isCosmetic: "no" })).toBeNull();
    expect(parseConsentEvent({ type: "optOutResult", cmp: "x" })).toBeNull();
    expect(parseConsentEvent({ type: "popupFound", cmp: "" })).toBeNull();
    expect(parseConsentEvent({ type: "popupFound", cmp: "a".repeat(81) })).toBeNull();
    expect(parseConsentEvent({ type: "popupFound", cmp: "bad\nname" })).toBeNull();
    expect(parseConsentEvent({ type: "eval", id: "1", code: "x" })).toBeNull();
    expect(parseConsentEvent(["popupFound"])).toBeNull();
    expect(parseConsentEvent("settled")).toBeNull();
  });

  it("knows when a frame's search is over", () => {
    for (const done of ["nothingDetected", "done", "optOutSucceeded", "optOutFailed"]) expect(isSettledLifecycle(done)).toBe(true);
    for (const busy of ["loading", "started", "cmpDetected", "openPopupDetected", "runningOptOut", undefined]) expect(isSettledLifecycle(busy)).toBe(false);
  });

  it("runs only Autoconsent's own named snippets in the page", () => {
    const ids = Object.keys(evalSnippets);
    expect(ids.length).toBeGreaterThan(50);
    for (const id of ids) expect(isConsentSnippetId(id)).toBe(true);
    expect(isConsentSnippetId("alert(1)")).toBe(false);
    expect(isConsentSnippetId("EVAL_X; alert(1)")).toBe(false);
    expect(isConsentSnippetId("constructor")).toBe(false);
    expect(isConsentSnippetId(42)).toBe(false);
  });

  it("ships rules for the common consent platforms", () => {
    const rules = compactRules as unknown as IndexedCMPRuleset;
    const names = (ruleset: { r: unknown[][]; s: string[] }): string[] => ruleset.r.map((r) => String(r[1]));
    const generic = filterCompactRules(rules, { url: "https://example.com/", mainFrame: true });
    expect(names(generic)).toEqual(expect.arrayContaining(["didomi", "quantcast", "cookieyes", "iubenda"]));
    expect(filterCompactRules(rules, { url: "https://example.com/", mainFrame: false }).r.length).toBeLessThan(generic.r.length);
  });
});

describe("cookie banner state per tab", () => {
  it("counts a banner once, whatever the frames report", () => {
    const tabs = new ConsentTabs();
    expect(tabs.record(1, { type: "popupFound", cmp: "Onetrust" })).toBe(true);
    expect(tabs.get(1)).toEqual({ cmp: "Onetrust", outcome: "pending" });
    expect(tabs.record(1, { type: "optOutResult", cmp: "Onetrust", result: true })).toBe(false);
    expect(tabs.record(1, { type: "autoconsentDone", cmp: "Onetrust", isCosmetic: false })).toBe(true);
    expect(tabs.get(1)).toEqual({ cmp: "Onetrust", outcome: "rejected" });
    // A later failure in another frame does not undo it, and nothing counts twice.
    expect(tabs.record(1, { type: "optOutResult", cmp: "Sourcepoint-frame", result: false })).toBe(false);
    expect(tabs.record(1, { type: "autoconsentDone", cmp: "Onetrust", isCosmetic: false })).toBe(false);
    expect(tabs.total()).toBe(1);
    tabs.reset(1);
    expect(tabs.get(1)).toBeUndefined();
    tabs.record(1, { type: "autoconsentDone", cmp: "some-cosmetic", isCosmetic: true });
    expect(tabs.get(1)?.outcome).toBe("hidden");
    expect(tabs.total()).toBe(2);
    tabs.forget(1);
    expect(tabs.get(1)).toBeUndefined();
  });

  it("marks a banner that could not be answered", () => {
    expect(nextConsentState(undefined, { type: "optOutResult", cmp: "x", result: false })).toEqual({ state: { cmp: "x", outcome: "failed" }, handled: false });
    expect(nextConsentState(undefined, { type: "settled" })).toEqual({ state: undefined, handled: false });
  });

  it("names consent platforms readably", () => {
    expect(cmpDisplayName("Onetrust")).toBe("OneTrust");
    expect(cmpDisplayName("Cybotcookiebot")).toBe("Cookiebot");
    expect(cmpDisplayName("Sourcepoint-frame")).toBe("Sourcepoint");
    expect(cmpDisplayName("Complianz banner")).toBe("Complianz");
    expect(cmpDisplayName("auto_ES_example.com_x")).toBe("");
    expect(cmpDisplayName("HEURISTIC-REJECT")).toBe("");
    expect(cmpDisplayName("some-new-cmp")).toBe("some-new-cmp");
  });
});

describe("Global Privacy Control", () => {
  it("adds Sec-GPC: 1 once", () => {
    expect(withGpcHeader({ Accept: "*/*", "sec-gpc": "0" })).toEqual({ Accept: "*/*", "Sec-GPC": "1" });
  });

  it("goes out with web requests when on, beside the client hints", () => {
    const hints = clientHintHeaders(142, "win32");
    const nav = outgoingHeaders({ url: "https://example.com/", resourceType: "mainFrame", requestHeaders: { Accept: "text/html" } }, hints, true);
    expect(nav.headers).toMatchObject({ ...hints, Accept: "text/html", "Sec-GPC": "1" });
    expect(nav.seen).toBeNull();
    const plain = outgoingHeaders({ url: "http://example.com/a.js", resourceType: "script", requestHeaders: {} }, hints, true);
    expect(plain.headers).toEqual({ "Sec-GPC": "1" });
    const off = outgoingHeaders({ url: "https://example.com/", resourceType: "mainFrame", requestHeaders: {} }, hints, false);
    expect(off.headers["Sec-GPC"]).toBeUndefined();
    const sub = outgoingHeaders({ url: "https://example.com/a.js", resourceType: "script", requestHeaders: { "sec-ch-ua": "x" } }, hints, false);
    expect(sub.seen?.["sec-ch-ua"]).toBe("x");
    expect(sub.headers).toEqual({ "sec-ch-ua": "x" });
  });

  it("defines navigator.globalPrivacyControl as a prototype getter", () => {
    class Navigator {}
    const navigator = new Navigator() as { globalPrivacyControl?: boolean };
    const sandbox = { Navigator, navigator, Object };
    runInNewContext(GPC_PAGE_SCRIPT, sandbox);
    expect(navigator.globalPrivacyControl).toBe(true);
    expect(Object.keys(Object.getOwnPropertyDescriptors(navigator))).toEqual([]);
    // Runs once: a second run (another preload, a native implementation) changes nothing.
    runInNewContext(GPC_PAGE_SCRIPT, sandbox);
    expect(navigator.globalPrivacyControl).toBe(true);
  });
});

describe("AdblockController cookie consent", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("is on by default, keeps excepted sites and shows the tab's banner", async () => {
    const { AdblockController } = await import("../src/main/adblock");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "corvus-consent-"));
    dirs.push(dir);
    const controller = new AdblockController(dir);
    expect(controller.options()).toMatchObject({ cookieConsent: true, gpc: true });
    expect(controller.consentRunsOn("https://www.example.com/", "https://www.example.com/")).toBe(true);
    controller.setConsentAllowed("www.example.com", true);
    expect(controller.consentAllowedSites()).toEqual(["example.com"]);
    expect(controller.consentRunsOn("https://shop.example.com/", "https://cmp.net/")).toBe(false);
    controller.setConsentAllowed("shop.example.com", false);
    expect(controller.consentAllowedSites()).toEqual([]);
    controller.setOptions({ cookieConsent: false, gpc: false });
    expect(controller.options()).toMatchObject({ cookieConsent: false, gpc: false });
    expect(controller.consentRunsOn("https://example.com/", "https://example.com/")).toBe(false);
    expect(controller.view({ updatedAt: null, source: "bundled", filterCount: 0, updating: false })).toMatchObject({ cookieConsent: false, gpc: false, consentAllowedSites: [] });
    controller.setOptions({ cookieConsent: true });

    const wc = { id: 7, isDestroyed: () => false, getURL: () => "https://news.example.org/a" } as unknown as Electron.WebContents;
    controller.recordConsent(7, { type: "popupFound", cmp: "Onetrust" });
    expect(controller.barState(wc)).toMatchObject({ cookieConsent: true, consentAllowed: false, bannersHandled: 0 });
    expect(controller.barState(wc).cookieBanner).toBeUndefined();
    controller.recordConsent(7, { type: "autoconsentDone", cmp: "Onetrust", isCosmetic: false });
    expect(controller.barState(wc)).toMatchObject({ cookieBanner: { cmp: "OneTrust", outcome: "rejected" }, bannersHandled: 1 });
    controller.resetTab(7);
    expect(controller.barState(wc).cookieBanner).toBeUndefined();
    expect(controller.barState(wc).bannersHandled).toBe(1);
    controller.flush();
    const saved = JSON.parse(fs.readFileSync(path.join(dir, "adblock.json"), "utf8")) as Record<string, unknown>;
    expect(saved).toMatchObject({ cookieConsent: true, gpc: false, consentAllowed: [] });
  });
});
