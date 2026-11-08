import { describe, expect, it } from "vitest";
import {
  MAX_FRAME_DEPTH,
  cardFillAllowed,
  effectiveOpacity,
  fieldOnScreen,
  fieldShown,
  formHostOf,
  frameIsTarget,
  frameOriginUsable,
  newDocToken,
  parseFrameAnswer,
  parseFrameFillRequest,
  secureCardContext,
  validCvv,
  validDocToken,
  type FieldSight,
  type FramePlace,
} from "../src/shared/frame-fill";

const target = { processId: 4, routingId: 7, origin: "https://pay.example", box: { x: 1, y: 2, width: 3, height: 4 } };
const card = { label: "", nameOnCard: "Ana Example", number: "4111111111111111", expMonth: "08", expYear: "2028" };

describe("frameIsTarget", () => {
  it("is the same live frame with the same origin", () => {
    expect(frameIsTarget(target, { processId: 4, routingId: 7, origin: "https://pay.example", detached: false })).toBe(true);
    expect(frameIsTarget(target, { processId: 4, routingId: 7, origin: "https://evil.example", detached: false })).toBe(false);
    expect(frameIsTarget(target, { processId: 4, routingId: 8, origin: "https://pay.example", detached: false })).toBe(false);
    expect(frameIsTarget(target, { processId: 5, routingId: 7, origin: "https://pay.example", detached: false })).toBe(false);
    expect(frameIsTarget(target, { processId: 4, routingId: 7, origin: "https://pay.example", detached: true })).toBe(false);
    expect(frameIsTarget(target, null)).toBe(false);
  });
});

describe("validCvv", () => {
  it("takes 3 or 4 digits", () => {
    expect(validCvv("123")).toBe(true);
    expect(validCvv("1234")).toBe(true);
    expect(validCvv(" 123 ")).toBe(false);
    expect(validCvv("12")).toBe(false);
    expect(validCvv("12345")).toBe(false);
    expect(validCvv("12a")).toBe(false);
  });
});

describe("card fill secure contexts", () => {
  it("take https and http on this computer only", () => {
    expect(secureCardContext("https://shop.example/checkout")).toBe(true);
    expect(secureCardContext("https://pay.example:8443")).toBe(true);
    expect(secureCardContext("http://localhost:3000/pay")).toBe(true);
    expect(secureCardContext("http://LOCALHOST")).toBe(true);
    expect(secureCardContext("http://127.0.0.1:8080")).toBe(true);
    expect(secureCardContext("http://[::1]:8080")).toBe(true);
    expect(secureCardContext("http://shop.example/checkout")).toBe(false);
    expect(secureCardContext("http://192.0.2.10/pay")).toBe(false);
    expect(secureCardContext("http://localhost.example/pay")).toBe(false);
    expect(secureCardContext("ftp://localhost/")).toBe(false);
    expect(secureCardContext("null")).toBe(false);
    expect(secureCardContext("")).toBe(false);
  });

  it("need both the page and the frame filled", () => {
    expect(cardFillAllowed("https://shop.example/checkout", "https://pay.example")).toBe(true);
    expect(cardFillAllowed("http://localhost:3000/", "http://127.0.0.1:3000")).toBe(true);
    expect(cardFillAllowed("http://shop.example/checkout", "https://pay.example")).toBe(false);
    expect(cardFillAllowed("https://shop.example/checkout", "http://pay.example")).toBe(false);
    expect(cardFillAllowed("https://shop.example/checkout", "null")).toBe(false);
  });
});

describe("fieldShown", () => {
  interface Node {
    rect: { left: number; top: number; width: number; height: number };
    style: { visibility: string; display: string; opacity: string };
    parentElement: Node | null;
  }
  const node = (over: { rect?: Partial<Node["rect"]>; style?: Partial<Node["style"]>; parent?: Node | null } = {}): Node & { getBoundingClientRect(): { left: number; top: number; right: number; bottom: number; width: number; height: number } } => {
    const rect = { left: 40, top: 300, width: 200, height: 24, ...over.rect };
    return {
      rect,
      style: { visibility: "visible", display: "inline-block", opacity: "1", ...over.style },
      parentElement: over.parent ?? null,
      getBoundingClientRect: () => ({ ...rect, right: rect.left + rect.width, bottom: rect.top + rect.height }),
    };
  };
  const view = (scroll = { x: 0, y: 0 }) => ({ scrollX: scroll.x, scrollY: scroll.y, innerWidth: 1280, getComputedStyle: (el: unknown) => (el as Node).style });
  const shown = (el: ReturnType<typeof node>, v = view()): boolean => fieldShown(el as never, v as never);

  it("takes a field the person sees, below the fold too", () => {
    expect(shown(node())).toBe(true);
    expect(shown(node({ rect: { top: 2400 } }))).toBe(true);
    expect(shown(node({ style: { opacity: "0.5" }, parent: node({ style: { opacity: "0.2" } }) }))).toBe(true);
    // Scrolled down: a field above the window is still in the document.
    expect(shown(node({ rect: { top: -500 } }), view({ x: 0, y: 900 }))).toBe(true);
  });

  it("leaves out transparent fields, and fields in a transparent parent", () => {
    expect(shown(node({ style: { opacity: "0" } }))).toBe(false);
    expect(shown(node({ style: { opacity: "0.05" } }))).toBe(false);
    expect(shown(node({ parent: node({ parent: node({ style: { opacity: "0" } }) }) }))).toBe(false);
  });

  it("leaves out 1 px boxes, hidden fields and fields off the document", () => {
    expect(shown(node({ rect: { width: 1, height: 1 } }))).toBe(false);
    expect(shown(node({ rect: { height: 1.5 } }))).toBe(false);
    expect(shown(node({ style: { visibility: "hidden" } }))).toBe(false);
    expect(shown(node({ style: { display: "none" } }))).toBe(false);
    expect(shown(node({ rect: { left: -9999 } }))).toBe(false);
    expect(shown(node({ rect: { top: -9999 } }))).toBe(false);
    expect(shown(node({ rect: { left: 1280 } }))).toBe(false);
  });
});

const DOC = "0123456789abcdef0123456789abcdef";

describe("the request a frame takes", () => {
  const base = { token: 3, origin: "https://pay.example", doc: DOC, box: target.box };

  it("parses a card fill with its CVV, and an address fill", () => {
    expect(parseFrameFillRequest({ ...base, kind: "card", card, cvv: "123" })).toEqual({ ...base, kind: "card", card, cvv: "123" });
    const address = { name: "Ana" };
    expect(parseFrameFillRequest({ ...base, kind: "address", address })).toMatchObject({ kind: "address", address: { name: "Ana" } });
  });

  it("parses a probe, a login, a username alone and a 2FA code, each for one document", () => {
    expect(parseFrameFillRequest({ ...base, kind: "probe" })).toEqual({ ...base, kind: "probe" });
    expect(parseFrameFillRequest({ ...base, kind: "login", username: "ana@example.com", password: "s3cret", usernameOnly: false, keepTyped: true })).toEqual({ ...base, kind: "login", username: "ana@example.com", password: "s3cret", usernameOnly: false, keepTyped: true });
    // A username-only fill never carries a password, whatever it was sent with.
    expect(parseFrameFillRequest({ ...base, kind: "login", username: "ana@example.com", password: "s3cret", usernameOnly: true, keepTyped: false })).toMatchObject({ password: "", usernameOnly: true });
    expect(parseFrameFillRequest({ ...base, kind: "otp", code: "123456" })).toEqual({ ...base, kind: "otp", code: "123456" });
  });

  it("parses where a child frame is (asked of its parent, no document)", () => {
    expect(parseFrameFillRequest({ token: 4, kind: "place", index: 2 })).toEqual({ token: 4, kind: "place", index: 2 });
    expect(parseFrameFillRequest({ token: 4, kind: "place", index: -1 })).toBeNull();
    expect(parseFrameFillRequest({ token: 4, kind: "place", index: 1.5 })).toBeNull();
  });

  it("refuses anything malformed, and any fill without a document token", () => {
    expect(parseFrameFillRequest({ ...base, kind: "card", card, cvv: "12" })).toBeNull();
    expect(parseFrameFillRequest({ ...base, origin: "", kind: "card", card, cvv: "123" })).toBeNull();
    expect(parseFrameFillRequest({ ...base, box: { x: "1" }, kind: "card", card, cvv: "123" })).toBeNull();
    expect(parseFrameFillRequest({ ...base, doc: undefined, kind: "probe" })).toBeNull();
    expect(parseFrameFillRequest({ ...base, doc: "not-a-token", kind: "probe" })).toBeNull();
    expect(parseFrameFillRequest({ ...base, kind: "login", username: "", password: "", usernameOnly: false, keepTyped: false })).toBeNull();
    expect(parseFrameFillRequest({ ...base, kind: "login", username: "ana", password: 5, usernameOnly: false, keepTyped: false })).toBeNull();
    expect(parseFrameFillRequest({ ...base, kind: "login", username: "ana", password: "x".repeat(5000), usernameOnly: false, keepTyped: false })).toBeNull();
    expect(parseFrameFillRequest({ ...base, kind: "otp", code: "12 34" })).toBeNull();
    expect(parseFrameFillRequest({ ...base, kind: "submit" })).toBeNull();
    expect(parseFrameFillRequest(null)).toBeNull();
  });

  it("parses the answer, with what a probe found and where a frame is", () => {
    expect(parseFrameAnswer({ token: 3, filled: 4 })).toEqual({ token: 3, filled: 4 });
    const sight = { box: target.box, shown: true, opacity: 1, viewWidth: 400, viewHeight: 300 };
    expect(parseFrameAnswer({ token: 3, filled: 0, sight, found: { login: true, identifier: false, otp: true } })).toEqual({ token: 3, filled: 0, sight, found: { login: true, identifier: false, otp: true } });
    const place = { x: 10, y: 20, width: 400, height: 300, scale: 1, opacity: 1, shown: true, sandboxed: false, viewWidth: 1280, viewHeight: 800 };
    expect(parseFrameAnswer({ token: 3, filled: 0, place })).toEqual({ token: 3, filled: 0, place });
    expect(parseFrameAnswer({ token: 3, filled: -1 })).toBeNull();
    expect(parseFrameAnswer({ token: "3", filled: 1 })).toBeNull();
    expect(parseFrameAnswer({ token: 3, filled: 0, sight: { ...sight, opacity: 2 } })).toBeNull();
    expect(parseFrameAnswer({ token: 3, filled: 0, found: { login: "yes", identifier: false, otp: false } })).toBeNull();
    expect(parseFrameAnswer({ token: 3, filled: 0, place: { ...place, shown: undefined } })).toBeNull();
  });
});

describe("document tokens", () => {
  it("are 32 hex characters from 16 random bytes", () => {
    const doc = newDocToken((b) => b.fill(171));
    expect(doc).toBe("ab".repeat(16));
    expect(validDocToken(doc)).toBe(true);
    expect(validDocToken(newDocToken((b) => crypto.getRandomValues(b)))).toBe(true);
    expect(validDocToken("AB".repeat(16))).toBe(false);
    expect(validDocToken("ab".repeat(15))).toBe(false);
    expect(validDocToken(42)).toBe(false);
  });
});

describe("frame origins", () => {
  it("take a web page's origin", () => {
    expect(frameOriginUsable("https://login.example.com")).toBe(true);
    expect(frameOriginUsable("http://127.0.0.1:8080")).toBe(true);
  });

  it("never an opaque origin (a sandboxed frame, a data: URL) or anything that is not an origin", () => {
    expect(frameOriginUsable("null")).toBe(false);
    expect(frameOriginUsable("")).toBe(false);
    expect(frameOriginUsable("data:text/html,<form>")).toBe(false);
    expect(frameOriginUsable("about:blank")).toBe(false);
    expect(frameOriginUsable("file:///C:/")).toBe(false);
    expect(frameOriginUsable("chrome-extension://abc")).toBe(false);
    expect(frameOriginUsable("https://login.example.com/path")).toBe(false);
  });
});

describe("the form's host a frame's dropdown names", () => {
  it("is the frame's host when it is another site than the page's", () => {
    expect(formHostOf("https://shop.example.org/checkout", "https://login.example.com")).toBe("login.example.com");
    expect(formHostOf("http://localhost:3000/", "http://127.0.0.1:3000")).toBe("127.0.0.1:3000");
  });

  it("is empty for a frame of the page's own site, another host of it included", () => {
    expect(formHostOf("https://www.example.com/", "https://www.example.com")).toBe("");
    expect(formHostOf("https://www.example.com/", "https://auth.example.com")).toBe("");
  });
});

describe("fieldOnScreen", () => {
  const sight = (over: Partial<FieldSight> = {}): FieldSight => ({ box: { x: 20, y: 40, width: 200, height: 24 }, shown: true, opacity: 1, viewWidth: 400, viewHeight: 300, ...over });
  const place = (over: Partial<FramePlace> = {}): FramePlace => ({ x: 100, y: 200, width: 400, height: 300, scale: 1, opacity: 1, shown: true, sandboxed: false, viewWidth: 1280, viewHeight: 800, ...over });

  it("gives the field's box in the page through each frame up the chain", () => {
    expect(fieldOnScreen(sight(), [place()])).toEqual({ x: 120, y: 240, width: 200, height: 24 });
    // A frame in a frame: the inner frame sits at (10, 5) in the outer one, which sits at (100, 200).
    expect(fieldOnScreen(sight(), [place({ x: 10, y: 5 }), place()])).toEqual({ x: 130, y: 245, width: 200, height: 24 });
    // A frame shown at half its size.
    expect(fieldOnScreen(sight(), [place({ scale: 0.5 })])).toEqual({ x: 110, y: 220, width: 100, height: 12 });
    // Partly scrolled out of its frame, but still seen.
    expect(fieldOnScreen(sight({ box: { x: 20, y: -10, width: 200, height: 24 } }), [place()])).not.toBeNull();
  });

  it("refuses a field the frame itself hides or makes nearly transparent", () => {
    expect(fieldOnScreen(sight({ shown: false }), [place()])).toBeNull();
    expect(fieldOnScreen(sight({ opacity: 0.3 }), [place()])).toBeNull();
    expect(fieldOnScreen(sight({ box: { x: 20, y: 400, width: 200, height: 24 } }), [place()])).toBeNull();
  });

  it("refuses hidden, transparent, zero-size, shrunk, sandboxed and off-screen frames (clickjacking)", () => {
    expect(fieldOnScreen(sight(), [place({ shown: false })])).toBeNull();
    expect(fieldOnScreen(sight(), [place({ opacity: 0 })])).toBeNull();
    expect(fieldOnScreen(sight(), [place({ opacity: 0.4 })])).toBeNull();
    // Each one half transparent: together too faint.
    expect(fieldOnScreen(sight({ opacity: 0.7 }), [place({ opacity: 0.7 })])).toBeNull();
    expect(fieldOnScreen(sight(), [place({ width: 0, height: 0 })])).toBeNull();
    expect(fieldOnScreen(sight(), [place({ scale: 0 })])).toBeNull();
    expect(fieldOnScreen(sight(), [place({ scale: 0.02 })])).toBeNull();
    expect(fieldOnScreen(sight(), [place({ sandboxed: true })])).toBeNull();
    expect(fieldOnScreen(sight(), [place({ x: -2000 })])).toBeNull();
    expect(fieldOnScreen(sight(), [place({ y: 5000 })])).toBeNull();
    // Off screen in the outer frame, the inner one with it.
    expect(fieldOnScreen(sight(), [place(), place({ x: 1300 })])).toBeNull();
    // Inside a frame cut down to 4 px, the field shows only 4 px.
    expect(fieldOnScreen(sight(), [place({ width: 4, height: 300, x: 100 })])).toBeNull();
  });

  it("needs a chain from a subframe to the page, no deeper than MAX_FRAME_DEPTH", () => {
    expect(fieldOnScreen(sight(), [])).toBeNull();
    expect(fieldOnScreen(sight(), Array.from({ length: MAX_FRAME_DEPTH }, () => place({ x: 0, y: 0, viewWidth: 400, viewHeight: 300 })))).not.toBeNull();
    expect(fieldOnScreen(sight(), Array.from({ length: MAX_FRAME_DEPTH + 1 }, () => place({ x: 0, y: 0, viewWidth: 400, viewHeight: 300 })))).toBeNull();
  });
});

describe("effectiveOpacity", () => {
  interface El {
    style: { opacity: string; filter?: string };
    parentElement: El | null;
    root?: { host?: El };
    getRootNode(): unknown;
  }
  const el = (style: El["style"], parent: El | null = null, host?: El): El => {
    const node: El = { style, parentElement: parent, getRootNode: () => (host ? { host } : {}) };
    return node;
  };
  const view = { getComputedStyle: (e: unknown) => (e as El).style };

  it("multiplies the element's opacity with its parents'", () => {
    expect(effectiveOpacity(el({ opacity: "1" }) as never, view as never)).toBe(1);
    expect(effectiveOpacity(el({ opacity: "0.5" }, el({ opacity: "0.5" })) as never, view as never)).toBe(0.25);
    expect(effectiveOpacity(el({ opacity: "1" }, el({ opacity: "1" }, el({ opacity: "0" }))) as never, view as never)).toBe(0);
  });

  it("counts opacity() filters", () => {
    expect(effectiveOpacity(el({ opacity: "1", filter: "opacity(0)" }) as never, view as never)).toBe(0);
    expect(effectiveOpacity(el({ opacity: "1", filter: "blur(1px) opacity(50%)" }) as never, view as never)).toBe(0.5);
    expect(effectiveOpacity(el({ opacity: "1", filter: "none" }) as never, view as never)).toBe(1);
  });

  it("goes on through the web component a field sits in", () => {
    const host = el({ opacity: "0.1" });
    const inside = el({ opacity: "1" }, null, host);
    expect(effectiveOpacity(inside as never, view as never)).toBeCloseTo(0.1);
  });
});
