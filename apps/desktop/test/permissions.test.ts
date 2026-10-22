import { describe, expect, it } from "vitest";
import {
  decidePermission,
  isRememberable,
  isSecureOrigin,
  kindsForPermission,
  listSitePermissions,
  originOf,
  resetSitePermissions,
  reviveSitePermissions,
  setSitePermission,
  type PermissionDecision,
  type PermissionKind,
  type PermissionQuery,
  type StoredDecisions,
} from "../src/shared/permissions";

const SITE = "https://meet.example";

function query(kinds: PermissionKind[], extra: Partial<PermissionQuery> = {}, stored: Partial<Record<PermissionKind, StoredDecisions>> = {}): PermissionQuery {
  return { kinds, origin: SITE, topOrigin: SITE, agent: false, lookup: (k) => stored[k] ?? {}, ...extra };
}

describe("permission kinds", () => {
  it("splits media into camera and microphone", () => {
    expect(kindsForPermission("media", ["video", "audio"])).toEqual(["camera", "microphone"]);
    expect(kindsForPermission("media", ["audio"])).toEqual(["microphone"]);
    expect(kindsForPermission("media", [])).toEqual([]);
    expect(kindsForPermission("media")).toEqual([]);
  });

  it("maps Electron names and rejects unsupported ones", () => {
    expect(kindsForPermission("midiSysex")).toEqual(["midi-sysex"]);
    expect(kindsForPermission("pointerLock")).toEqual(["pointer-lock"]);
    expect(kindsForPermission("geolocation-approximate")).toEqual(["geolocation"]);
    expect(kindsForPermission("clipboard-sanitized-write")).toEqual(["clipboard-write"]);
    expect(kindsForPermission("usb")).toEqual([]);
    expect(kindsForPermission("openExternal")).toEqual([]);
  });
});

describe("origins", () => {
  it("serializes origins, including custom schemes", () => {
    expect(originOf("https://a.test:8443/path?q=1")).toBe("https://a.test:8443");
    expect(originOf("corvus://settings/#x")).toBe("corvus://settings");
    expect(originOf("chrome-extension://abc/popup.html")).toBe("chrome-extension://abc");
    expect(originOf("about:blank")).toBe("");
    expect(originOf("not a url")).toBe("");
  });

  it("treats https and loopback http as secure", () => {
    expect(isSecureOrigin("https://a.test")).toBe(true);
    expect(isSecureOrigin("http://localhost:3000")).toBe(true);
    expect(isSecureOrigin("http://app.localhost")).toBe(true);
    expect(isSecureOrigin("http://127.0.0.1:8080")).toBe(true);
    expect(isSecureOrigin("http://[::1]:8080")).toBe(true);
    expect(isSecureOrigin("http://a.test")).toBe(false);
    expect(isSecureOrigin("http://127.0.0.1.evil.test")).toBe(false);
    expect(isSecureOrigin("file://")).toBe(false);
    expect(isSecureOrigin("")).toBe(false);
  });
});

describe("decision table", () => {
  it("auto-allows fullscreen and clipboard writes, even on http", () => {
    expect(decidePermission(query(["fullscreen"], { origin: "http://a.test", topOrigin: "http://a.test" }))).toEqual({ action: "allow" });
    expect(decidePermission(query(["clipboard-write"]))).toEqual({ action: "allow" });
  });

  it("denies fullscreen to agent tabs so the AI badge stays visible", () => {
    expect(decidePermission(query(["fullscreen"], { agent: true }))).toEqual({ action: "deny", reason: "agent" });
  });

  it("denies unsupported, internal, insecure and embedded requests", () => {
    expect(decidePermission(query([]))).toMatchObject({ reason: "unsupported" });
    expect(decidePermission(query(["notifications"], { origin: "corvus://settings", topOrigin: "corvus://settings" }))).toMatchObject({ reason: "internal" });
    expect(decidePermission(query(["geolocation"], { origin: "http://a.test", topOrigin: "http://a.test" }))).toMatchObject({ reason: "insecure" });
    expect(decidePermission(query(["camera"], { origin: "https://ads.test" }))).toMatchObject({ reason: "embedded" });
  });

  it("prompts for unknown decisions and allows remembered ones", () => {
    expect(decidePermission(query(["camera", "microphone"]))).toEqual({ action: "prompt", kinds: ["camera", "microphone"] });
    expect(decidePermission(query(["camera", "microphone"], {}, { camera: { persistent: "allow" } }))).toEqual({ action: "prompt", kinds: ["microphone"] });
    expect(decidePermission(query(["camera"], {}, { camera: { persistent: "allow" } }))).toEqual({ action: "allow" });
    expect(decidePermission(query(["notifications"], { origin: "http://localhost:5173", topOrigin: "http://localhost:5173" }))).toEqual({
      action: "prompt",
      kinds: ["notifications"],
    });
  });

  it("denies when any requested kind is blocked; temporary answers win over remembered ones", () => {
    expect(decidePermission(query(["camera", "microphone"], {}, { microphone: { persistent: "block" } }))).toMatchObject({ reason: "blocked" });
    expect(decidePermission(query(["camera"], {}, { camera: { persistent: "block", temporary: "allow" } }))).toEqual({ action: "allow" });
    expect(decidePermission(query(["camera"], {}, { camera: { persistent: "allow", temporary: "block" } }))).toMatchObject({ reason: "blocked" });
  });

  it("never grants camera, microphone, location or screen capture to agent tabs", () => {
    const allowAll = { persistent: "allow" as PermissionDecision, temporary: "allow" as PermissionDecision };
    for (const kind of ["camera", "microphone", "geolocation", "display-capture"] as PermissionKind[]) {
      expect(decidePermission(query([kind], { agent: true }, { [kind]: allowAll }))).toEqual({ action: "deny", reason: "agent" });
    }
  });

  it("does not auto-approve agent tabs from remembered decisions", () => {
    expect(decidePermission(query(["notifications"], { agent: true }, { notifications: { persistent: "allow" } }))).toEqual({
      action: "prompt",
      kinds: ["notifications"],
    });
    expect(decidePermission(query(["notifications"], { agent: true }, { notifications: { persistent: "block" } }))).toMatchObject({ reason: "blocked" });
    expect(decidePermission(query(["notifications"], { agent: true }, { notifications: { temporary: "allow" } }))).toEqual({ action: "allow" });
  });

  it("always asks for screen capture", () => {
    expect(decidePermission(query(["display-capture"], {}, { "display-capture": { persistent: "allow", temporary: "allow" } }))).toEqual({
      action: "prompt",
      kinds: ["display-capture"],
    });
    expect(isRememberable("display-capture")).toBe(false);
    expect(isRememberable("fullscreen")).toBe(false);
    expect(isRememberable("geolocation")).toBe(true);
  });
});

describe("site permission storage", () => {
  it("sets, clears and resets per origin", () => {
    let map = setSitePermission({}, SITE, "camera", "allow");
    map = setSitePermission(map, SITE, "notifications", "block");
    map = setSitePermission(map, "https://b.test", "geolocation", "allow");
    expect(listSitePermissions(map)).toEqual([
      { origin: "https://b.test", permissions: { geolocation: "allow" } },
      { origin: SITE, permissions: { camera: "allow", notifications: "block" } },
    ]);
    map = setSitePermission(map, SITE, "camera", null);
    expect(map[SITE]).toEqual({ notifications: "block" });
    map = resetSitePermissions(map, SITE);
    expect(Object.keys(map)).toEqual(["https://b.test"]);
    map = setSitePermission(map, "https://b.test", "geolocation", null);
    expect(map).toEqual({});
  });

  it("refuses kinds that are never remembered and keeps identity on no-ops", () => {
    const map = setSitePermission({}, SITE, "camera", "allow");
    expect(setSitePermission(map, SITE, "display-capture", "allow")).toBe(map);
    expect(setSitePermission(map, SITE, "camera", "allow")).toBe(map);
    expect(resetSitePermissions(map, "https://none.test")).toBe(map);
  });

  it("revives only valid entries", () => {
    expect(
      reviveSitePermissions({
        [SITE]: { camera: "allow", microphone: "maybe", "display-capture": "allow", bogus: "block" },
        "not an origin": { camera: "allow" },
        "https://x.test/path": { camera: "allow" },
        "https://empty.test": {},
      }),
    ).toEqual({ [SITE]: { camera: "allow" } });
    expect(reviveSitePermissions(null)).toEqual({});
    expect(reviveSitePermissions([1, 2])).toEqual({});
  });
});
