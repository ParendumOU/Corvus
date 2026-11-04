import { describe, expect, it } from "vitest";
import { fillAddressScript } from "../src/main/credential-scripts";
import { emptyAddressFields } from "../src/shared/addresses";
import { cardFillAllowed, fieldShown, frameIsTarget, parseFrameFilled, parseFrameFillRequest, secureCardContext, subframeFieldAllowed, validCvv } from "../src/shared/frame-fill";

const target = { processId: 4, routingId: 7, origin: "https://pay.example", box: { x: 1, y: 2, width: 3, height: 4 } };
const card = { label: "", nameOnCard: "Ana Example", number: "4111111111111111", expMonth: "08", expYear: "2028" };

describe("subframe field clicks", () => {
  it("are taken for card and address fields only, never login or 2FA fields", () => {
    expect(subframeFieldAllowed("card")).toBe(true);
    expect(subframeFieldAllowed("address")).toBe(true);
    expect(subframeFieldAllowed("login")).toBe(false);
    expect(subframeFieldAllowed("otp")).toBe(false);
  });
});

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

  it("is self-contained, so the fill script can embed its source", () => {
    const embedded = new Function(`return (${String(fieldShown)});`)() as typeof fieldShown;
    expect(embedded(node() as never, view() as never)).toBe(true);
    expect(embedded(node({ style: { opacity: "0" } }) as never, view() as never)).toBe(false);
  });

  it("decides which fields the top frame's address fill writes, in a valid script", () => {
    const script = fillAddressScript(emptyAddressFields(), target.box, "https://shop.example");
    expect(() => new Function(script)).not.toThrow();
    expect(script).toContain("fieldShown(el, window)");
  });
});

describe("the fill request a frame takes", () => {
  it("parses a card fill with its CVV, and an address fill", () => {
    expect(parseFrameFillRequest({ token: 3, origin: "https://pay.example", box: target.box, kind: "card", card, cvv: "123" })).toEqual({ token: 3, origin: "https://pay.example", box: target.box, kind: "card", card, cvv: "123" });
    const address = { name: "Ana" };
    expect(parseFrameFillRequest({ token: 3, origin: "https://pay.example", box: target.box, kind: "address", address })).toMatchObject({ kind: "address", address: { name: "Ana" } });
  });

  it("refuses anything malformed", () => {
    expect(parseFrameFillRequest({ token: 3, origin: "https://pay.example", box: target.box, kind: "card", card, cvv: "12" })).toBeNull();
    expect(parseFrameFillRequest({ token: 3, origin: "", box: target.box, kind: "card", card, cvv: "123" })).toBeNull();
    expect(parseFrameFillRequest({ token: 3, origin: "https://pay.example", box: { x: "1" }, kind: "card", card, cvv: "123" })).toBeNull();
    expect(parseFrameFillRequest({ token: 3, origin: "https://pay.example", box: target.box, kind: "login" })).toBeNull();
    expect(parseFrameFillRequest(null)).toBeNull();
  });

  it("parses the reply", () => {
    expect(parseFrameFilled({ token: 3, filled: 4 })).toEqual({ token: 3, filled: 4 });
    expect(parseFrameFilled({ token: 3, filled: -1 })).toBeNull();
    expect(parseFrameFilled({ token: "3", filled: 1 })).toBeNull();
  });
});
