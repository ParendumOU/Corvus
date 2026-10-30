import { describe, expect, it } from "vitest";
import {
  ACTIVATION_MS,
  canRememberApp,
  escapeForHandler,
  externalScheme,
  forgetSiteApps,
  isActivationInput,
  isAppAllowed,
  linkKind,
  listSiteSettings,
  mayLaunch,
  openedByGesture,
  reviveExternalApps,
  setAppAllowed,
} from "../src/shared/external-apps";

const SITE = "https://portal.example";

describe("links to other apps", () => {
  it("hands app schemes to the system", () => {
    for (const url of ["afirma://sign?op=1", "zoommtg://zoom.us/join?confno=1", "msteams:/l/meetup-join/x", "mailto:someone@example.com", "tel:+34600000000", "steam://run/1", "ms-word:ofe|u|https://example.com/a.docx", "Afirma://x"]) {
      expect(linkKind(url), url).toBe("external");
    }
    expect(externalScheme("AFIRMA://sign")).toBe("afirma");
    expect(externalScheme("ms-word:ofe")).toBe("ms-word");
  });

  it("keeps what the browser loads itself", () => {
    for (const url of ["https://example.com", "http://127.0.0.1:63117/", "javascript:alert(1)", "data:text/html,x", "file:///C:/x", "chrome://settings", "devtools://x", "corvus://settings", "about:blank", "blob:https://example.com/1", "view-source:https://example.com", "ws://127.0.0.1:1"]) {
      expect(linkKind(url), url).toBe("browser");
      expect(externalScheme(url)).toBeNull();
    }
  });

  it("refuses handlers that ran code from a link", () => {
    for (const url of ["ms-msdt:/id PCWDiagnostic", "search-ms:query=x", "ms-officecmd:{}", "shell:startup", "vbscript:x", "hcp://x", "ms-appinstaller:?source=x"]) {
      expect(linkKind(url), url).toBe("denied");
      expect(externalScheme(url)).toBeNull();
    }
  });

  it("rejects what is not a link", () => {
    expect(linkKind("")).toBe("invalid");
    expect(linkKind("/relative")).toBe("invalid");
    expect(linkKind("1abc:x")).toBe("invalid");
  });

  it("escapes a link the way Chromium hands it to the system", () => {
    expect(escapeForHandler("afirma://sign?op=sign&dat=a%20b#x")).toBe("afirma://sign?op=sign&dat=a%20b#x");
    expect(escapeForHandler('afirma://x" --inject arg')).toBe("afirma://x%22%20--inject%20arg");
    expect(escapeForHandler("app://a<b>{c}|d\\e^`")).toBe("app://a%3Cb%3E%7Bc%7D%7Cd%5Ce%5E%60");
    expect(escapeForHandler("app://ñ")).toBe("app://%C3%B1");
    expect(escapeForHandler("app://[::1]/(x)*!~'")).toBe("app://[::1]/(x)*!~'");
  });
});

describe("one launch per user action", () => {
  it("counts clicks, keys and taps, not moving the mouse or scrolling", () => {
    for (const type of ["mouseDown", "mouseUp", "rawKeyDown", "keyDown", "touchEnd", "gestureTap"]) expect(isActivationInput(type), type).toBe(true);
    for (const type of ["mouseMove", "mouseWheel", "mouseEnter", "gestureScrollBegin", "keyUp", "char", "touchMove"]) expect(isActivationInput(type), type).toBe(false);
  });

  it("lets a page ask once after each action, and never without one", () => {
    expect(mayLaunch({ input: 0, launch: 0 }, false)).toBe(false);
    expect(mayLaunch({ input: 3, launch: 0 }, false)).toBe(true);
    expect(mayLaunch({ input: 3, launch: 4 }, false)).toBe(false);
    expect(mayLaunch({ input: 5, launch: 4 }, false)).toBe(true);
  });

  it("lets a tab opened by a click ask once before anything is done in it", () => {
    expect(mayLaunch({ input: 0, launch: 0 }, true)).toBe(true);
    expect(mayLaunch({ input: 0, launch: 2 }, true)).toBe(false);
    expect(openedByGesture(1_000, 1_000 + ACTIVATION_MS)).toBe(true);
    expect(openedByGesture(1_000, 1_001 + ACTIVATION_MS)).toBe(false);
    expect(openedByGesture(2_000, 1_000)).toBe(false);
    expect(openedByGesture(0, 1_000)).toBe(false);
  });
});

describe("Always allow", () => {
  it("is offered only for secure sites, outside private windows and agent tabs", () => {
    const normal = { privateWindow: false, agent: false };
    expect(canRememberApp(SITE, normal)).toBe(true);
    expect(canRememberApp("http://127.0.0.1:8080", normal)).toBe(true);
    expect(canRememberApp("http://portal.example", normal)).toBe(false);
    expect(canRememberApp(SITE, { privateWindow: true, agent: false })).toBe(false);
    expect(canRememberApp(SITE, { privateWindow: false, agent: true })).toBe(false);
  });

  it("is remembered per site and scheme, and forgotten one by one or per site", () => {
    let map = setAppAllowed({}, SITE, "afirma", true);
    map = setAppAllowed(map, SITE, "zoommtg", true);
    expect(map).toEqual({ [SITE]: ["afirma", "zoommtg"] });
    expect(isAppAllowed(map, SITE, "afirma")).toBe(true);
    expect(isAppAllowed(map, "https://other.example", "afirma")).toBe(false);
    expect(setAppAllowed(map, SITE, "afirma", true)).toBe(map);
    map = setAppAllowed(map, SITE, "afirma", false);
    expect(map).toEqual({ [SITE]: ["zoommtg"] });
    expect(setAppAllowed(map, SITE, "zoommtg", false)).toEqual({});
    expect(forgetSiteApps(map, SITE)).toEqual({});
    expect(forgetSiteApps(map, "https://other.example")).toBe(map);
  });

  it("revives only valid sites and app schemes", () => {
    expect(reviveExternalApps({ [SITE]: ["zoommtg", "afirma", "afirma", "https", "javascript", "ms-msdt", 3], "not an origin": ["afirma"], "https://x.example": "afirma" })).toEqual({
      [SITE]: ["afirma", "zoommtg"],
    });
    expect(reviveExternalApps(null)).toEqual({});
    expect(reviveExternalApps([])).toEqual({});
  });

  it("lists sites with permissions and allowed apps together for Settings", () => {
    const list = listSiteSettings({ "https://b.example": { camera: "allow" }, [SITE]: { "loopback-network": "allow" } }, { [SITE]: ["afirma"], "https://a.example": ["zoommtg"] });
    expect(list).toEqual([
      { origin: "https://a.example", permissions: {}, externalApps: ["zoommtg"] },
      { origin: "https://b.example", permissions: { camera: "allow" } },
      { origin: SITE, permissions: { "loopback-network": "allow" }, externalApps: ["afirma"] },
    ]);
  });
});
