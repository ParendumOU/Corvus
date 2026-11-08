/**
 * Filling into the frame the person clicked, which may be an iframe of another site (a payment
 * provider's card fields, a sign-in form embedded in a page). The frame's tab preload reports the click
 * with its document's token and what the field looks like there; each frame up the chain says, from its
 * own preload (an isolated world the page cannot fool), where its child frame is and whether it shows.
 * The main process remembers the frame (its process and routing id, its origin and document then) and,
 * once the person picks, sends the values to that frame alone, only while it is the same frame with the
 * same origin and document, still shows, and (for a login or a 2FA code) still holds the keyboard. The
 * frame's preload fills them in its isolated world and answers with how many fields it wrote.
 *
 * Logins and 2FA codes offered in a frame are those saved for the frame's own origin, never the page's:
 * a sign-in form of another site must not get the page's password. Pure helpers, unit tested.
 */
import type { AddressFields } from "./addresses";
import { cleanAddressFields } from "./addresses";
import { autofillSiteOf } from "./autofill-sites";
import type { CardFields } from "./cards";
import { cleanCardFields } from "./cards";

/** Main to a frame's preload: a fill, a probe of the frame's fields, or where one of its child frames is. */
export const AUTOFILL_FRAME_FILL_CHANNEL = "corvus:autofill-frame-fill";
/** A frame's preload to main: its answer to the request with that token. */
export const AUTOFILL_FRAME_FILLED_CHANNEL = "corvus:autofill-frame-filled";

/** Frames deeper than this are never filled. */
export const MAX_FRAME_DEPTH = 8;
/** What a field in a frame needs to count as seen: this much of its box on screen, at this opacity or more. */
export const MIN_SEEN_PX = 8;
export const MIN_FRAME_OPACITY = 0.5;

export interface FrameBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The frame a field was clicked in, as the main process remembers it. */
export interface FrameTarget {
  processId: number;
  routingId: number;
  origin: string;
  /** The clicked field, in the frame's own coordinates. */
  box: FrameBox;
  /** The frame's document then (its preload's random token): a fill goes nowhere else, not even to the frame's next page. */
  doc: string;
}

/** The clicked field as its own frame sees it. */
export interface FieldSight {
  /** The field's box in the frame's viewport. */
  box: FrameBox;
  /** Shown in its frame as fieldShown decides. */
  shown: boolean;
  /** Its opacity with its parents' (see effectiveOpacity). */
  opacity: number;
  /** The frame's viewport. */
  viewWidth: number;
  viewHeight: number;
}

/** Where a child frame is in its parent, as the parent's preload sees its frame element. */
export interface FramePlace {
  /** The frame's content box in the parent's viewport (untransformed size; `scale` maps it to the screen). */
  x: number;
  y: number;
  width: number;
  height: number;
  /** Its size on screen to its layout size (a transform shrinks it). */
  scale: number;
  /** The frame element's opacity with its parents'. */
  opacity: number;
  /** Rendered, not visibility: hidden, and at least 2 px each way. */
  shown: boolean;
  /** The frame element has a sandbox attribute. */
  sandboxed: boolean;
  /** The parent's viewport. */
  viewWidth: number;
  viewHeight: number;
}

/** What a frame's fields hold, as the login probe finds them (see detectLoginScript). */
export interface FrameFound {
  login: boolean;
  identifier: boolean;
  otp: boolean;
}

interface FillBase {
  token: number;
  origin: string;
  doc: string;
  box: FrameBox;
}

export type FrameFillRequest =
  | (FillBase & { kind: "card"; card: CardFields; cvv: string })
  | (FillBase & { kind: "address"; address: AddressFields })
  /** The frame's login, two-step and 2FA fields, and how the field at `box` shows. */
  | (FillBase & { kind: "probe" })
  /** A saved login: its username alone on a two-step sign-in's first step, else username and password. */
  | (FillBase & { kind: "login"; username: string; password: string; usernameOnly: boolean; keepTyped: boolean })
  | (FillBase & { kind: "otp"; code: string })
  /** Asked of a parent frame: where its child frame number `index` (window.frames order) is. */
  | { token: number; kind: "place"; index: number };

/** A frame's answer: how many fields it wrote, and for a probe or a place what it found. */
export interface FrameAnswer {
  token: number;
  filled: number;
  sight?: FieldSight;
  found?: FrameFound;
  place?: FramePlace;
}

/** A frame's origin a field there may be filled for: a web page's, never an opaque one ("null": a sandboxed frame, a data: URL). */
export function frameOriginUsable(origin: string): boolean {
  try {
    const u = new URL(origin);
    return (u.protocol === "https:" || u.protocol === "http:") && u.origin === origin;
  } catch {
    return false;
  }
}

/**
 * The host a frame's login dropdown names, as "This form is on {host}": the frame's when it is of
 * another site than the page's (the address bar shows the page's), else "".
 */
export function formHostOf(pageUrl: string, frameOrigin: string): string {
  const site = autofillSiteOf(frameOrigin);
  return site && site !== autofillSiteOf(pageUrl) ? new URL(frameOrigin).host : "";
}

/** The frame found now is the one clicked: same process and routing id, still attached, same origin. */
export function frameIsTarget(target: Pick<FrameTarget, "processId" | "routingId" | "origin">, frame: { processId: number; routingId: number; origin: string; detached: boolean } | null | undefined): boolean {
  return Boolean(frame) && !frame!.detached && frame!.processId === target.processId && frame!.routingId === target.routingId && frame!.origin === target.origin;
}

function intersect(a: FrameBox, b: FrameBox): FrameBox {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  return { x, y, width: Math.max(0, Math.min(a.x + a.width, b.x + b.width) - x), height: Math.max(0, Math.min(a.y + a.height, b.y + b.height) - y) };
}

/**
 * Where a field of a subframe shows in the tab's page, or null when the person cannot see it there: a
 * page must not get a login or a card into a frame it hides (clickjacking). `places` go from the
 * field's frame up to the top. Each frame must be rendered, unsandboxed, at least 2 px each way; the
 * field must show at least MIN_SEEN_PX each way inside every frame's box and viewport; and its opacity
 * with every frame's must stay at MIN_FRAME_OPACITY or more.
 */
export function fieldOnScreen(sight: FieldSight, places: FramePlace[]): FrameBox | null {
  if (!sight.shown || places.length === 0 || places.length > MAX_FRAME_DEPTH) return null;
  let box = sight.box;
  let seen = intersect(box, { x: 0, y: 0, width: sight.viewWidth, height: sight.viewHeight });
  let opacity = sight.opacity;
  for (const p of places) {
    if (!p.shown || p.sandboxed || !(p.scale > 0) || p.width < 2 || p.height < 2) return null;
    seen = intersect(seen, { x: 0, y: 0, width: p.width, height: p.height });
    const out = (b: FrameBox): FrameBox => ({ x: p.x + b.x * p.scale, y: p.y + b.y * p.scale, width: b.width * p.scale, height: b.height * p.scale });
    box = out(box);
    seen = intersect(out(seen), { x: 0, y: 0, width: p.viewWidth, height: p.viewHeight });
    opacity *= p.opacity;
  }
  return opacity >= MIN_FRAME_OPACITY && seen.width >= MIN_SEEN_PX && seen.height >= MIN_SEEN_PX ? box : null;
}

export const validCvv = (cvv: string): boolean => /^\d{3,4}$/.test(cvv);

/**
 * A page or frame a card may be filled in: a secure context as Chromium has it, https or http on this
 * computer (localhost, 127.0.0.1, [::1]). Over plain http elsewhere the card could be read on the way.
 */
export function secureCardContext(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  return u.protocol === "https:" || (u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname));
}

/** Cards are offered and filled only when both the tab's page and the frame filled are secure contexts. */
export function cardFillAllowed(pageUrl: string, frameOrigin: string): boolean {
  return secureCardContext(pageUrl) && secureCardContext(frameOrigin);
}

/** The parts of a form field fieldShown reads (the preload is type-checked without the DOM library). */
export interface ShownElement {
  getBoundingClientRect(): { left: number; top: number; right: number; bottom: number; width: number; height: number };
  readonly parentElement: ShownElement | null;
}

/** The parts of the field's window fieldShown reads. */
export interface ShownView {
  getComputedStyle(el: ShownElement): { visibility: string; display: string; opacity: string };
  readonly scrollX: number;
  readonly scrollY: number;
  readonly innerWidth: number;
}

/**
 * A field an address or card fill may write besides the one clicked: one the person can see. A page
 * can hide fields to collect a phone or e-mail the person never sees filled: nearly transparent (on
 * the field or any parent), a box under 2 px (screen-reader-only fields), placed left of or above the
 * document, or beyond the window's right edge.
 */
export function fieldShown(el: ShownElement, view: ShownView): boolean {
  const r = el.getBoundingClientRect();
  if (r.width < 2 || r.height < 2 || r.right + view.scrollX <= 0 || r.bottom + view.scrollY <= 0 || r.left >= view.innerWidth) return false;
  const s = view.getComputedStyle(el);
  if (s.visibility === "hidden" || s.display === "none") return false;
  for (let node: ShownElement | null = el; node; node = node.parentElement) {
    if (parseFloat(view.getComputedStyle(node).opacity) < 0.1) return false;
  }
  return true;
}

/** The parts of an element effectiveOpacity reads. */
export interface OpaqueElement {
  readonly parentElement: OpaqueElement | null;
  getRootNode(): unknown;
}

/**
 * How opaque an element shows: its opacity times every parent's, through the shadow roots of the web
 * components it sits in, with any opacity() filter on the way.
 */
export function effectiveOpacity(el: OpaqueElement, view: { getComputedStyle(el: OpaqueElement): { opacity: string; filter?: string } }): number {
  let opacity = 1;
  for (let node: OpaqueElement | null = el, depth = 0; node && depth < 500; depth++) {
    const s = view.getComputedStyle(node);
    const own = parseFloat(s.opacity);
    if (Number.isFinite(own)) opacity *= Math.max(0, Math.min(1, own));
    for (const m of (s.filter ?? "").matchAll(/opacity\(\s*([\d.]+)(%?)\s*\)/g)) {
      const f = parseFloat(m[1] ?? "1") / (m[2] ? 100 : 1);
      if (Number.isFinite(f)) opacity *= Math.max(0, Math.min(1, f));
    }
    const root: { host?: OpaqueElement } | null = node.parentElement ? null : (node.getRootNode() as { host?: OpaqueElement } | null);
    node = node.parentElement ?? root?.host ?? null;
  }
  return opacity;
}

const MAX_COORD = 1_000_000;
const MAX_SECRET = 4096;
const num = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && Math.abs(n) <= MAX_COORD;
const flag = (b: unknown): b is boolean => typeof b === "boolean";
const DOC_TOKEN = /^[0-9a-f]{32}$/;

/** A document token as the preload makes it (see newDocToken). */
export const validDocToken = (doc: unknown): doc is string => typeof doc === "string" && DOC_TOKEN.test(doc);

/** A random token for a frame's document, made once by its preload (crypto.getRandomValues: secure context or not). */
export function newDocToken(random: (bytes: Uint8Array) => Uint8Array): string {
  return Array.from(random(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
}

function parseBox(raw: unknown): FrameBox | null {
  if (typeof raw !== "object" || raw === null) return null;
  const b = raw as Record<string, unknown>;
  return num(b.x) && num(b.y) && num(b.width) && num(b.height) ? { x: b.x, y: b.y, width: b.width, height: b.height } : null;
}

const opacityOk = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1;

/** How a clicked field shows in its frame, as its preload reports it. Null when malformed. */
export function parseFieldSight(raw: unknown): FieldSight | null {
  if (typeof raw !== "object" || raw === null) return null;
  const s = raw as Record<string, unknown>;
  const box = parseBox(s.box);
  return box && flag(s.shown) && opacityOk(s.opacity) && num(s.viewWidth) && num(s.viewHeight) ? { box, shown: s.shown, opacity: s.opacity, viewWidth: s.viewWidth, viewHeight: s.viewHeight } : null;
}

function parsePlace(raw: unknown): FramePlace | null {
  if (typeof raw !== "object" || raw === null) return null;
  const p = raw as Record<string, unknown>;
  if (!num(p.x) || !num(p.y) || !num(p.width) || !num(p.height) || !num(p.scale) || !opacityOk(p.opacity) || !flag(p.shown) || !flag(p.sandboxed) || !num(p.viewWidth) || !num(p.viewHeight)) return null;
  return { x: p.x, y: p.y, width: p.width, height: p.height, scale: p.scale, opacity: p.opacity, shown: p.shown, sandboxed: p.sandboxed, viewWidth: p.viewWidth, viewHeight: p.viewHeight };
}

const text = (s: unknown): s is string => typeof s === "string" && s.length <= MAX_SECRET;

/** What a frame's preload accepts (it re-checks its own origin against `origin`, its document against `doc`). Null when malformed. */
export function parseFrameFillRequest(raw: unknown): FrameFillRequest | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (!Number.isSafeInteger(r.token)) return null;
  const token = r.token as number;
  if (r.kind === "place") return Number.isSafeInteger(r.index) && (r.index as number) >= 0 && (r.index as number) < 1000 ? { token, kind: "place", index: r.index as number } : null;
  const box = parseBox(r.box);
  if (typeof r.origin !== "string" || !r.origin || r.origin.length > 4096 || !validDocToken(r.doc) || !box) return null;
  const base: FillBase = { token, origin: r.origin, doc: r.doc, box };
  switch (r.kind) {
    case "card":
      if (typeof r.card !== "object" || r.card === null || typeof r.cvv !== "string" || !validCvv(r.cvv)) return null;
      return { ...base, kind: "card", card: cleanCardFields(r.card as Record<string, unknown>), cvv: r.cvv };
    case "address":
      if (typeof r.address !== "object" || r.address === null) return null;
      return { ...base, kind: "address", address: cleanAddressFields(r.address as Record<string, unknown>) };
    case "probe":
      return { ...base, kind: "probe" };
    case "login":
      if (!text(r.username) || !text(r.password) || !flag(r.usernameOnly) || !flag(r.keepTyped) || (!r.username && !r.password)) return null;
      return { ...base, kind: "login", username: r.username, password: r.usernameOnly ? "" : r.password, usernameOnly: r.usernameOnly, keepTyped: r.keepTyped };
    case "otp":
      return typeof r.code === "string" && /^[0-9A-Za-z]{4,10}$/.test(r.code) ? { ...base, kind: "otp", code: r.code } : null;
    default:
      return null;
  }
}

/** A frame's answer, as main takes it. Null when malformed. */
export function parseFrameAnswer(raw: unknown): FrameAnswer | null {
  if (typeof raw !== "object" || raw === null) return null;
  const a = raw as Record<string, unknown>;
  if (!Number.isSafeInteger(a.token) || !Number.isSafeInteger(a.filled) || (a.filled as number) < 0 || (a.filled as number) > 1000) return null;
  const answer: FrameAnswer = { token: a.token as number, filled: a.filled as number };
  if (a.sight !== undefined) {
    const sight = parseFieldSight(a.sight);
    if (!sight) return null;
    answer.sight = sight;
  }
  if (a.found !== undefined) {
    const f = a.found as Record<string, unknown> | null;
    if (typeof f !== "object" || f === null || !flag(f.login) || !flag(f.identifier) || !flag(f.otp)) return null;
    answer.found = { login: f.login, identifier: f.identifier, otp: f.otp };
  }
  if (a.place !== undefined) {
    const place = parsePlace(a.place);
    if (!place) return null;
    answer.place = place;
  }
  return answer;
}
