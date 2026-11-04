/**
 * Filling a card or an address into the frame the person clicked, which may be a cross-origin iframe
 * (a payment provider's card fields). The tab preload of that frame reports the click; the main process
 * remembers the frame (its process and routing id, and its origin then) and, once the person picks,
 * sends the values to that frame alone, only while it is the same frame with the same origin. The
 * frame's preload fills them in its isolated world and answers with how many fields it wrote.
 * Login and 2FA fields are never taken from a subframe. Pure helpers, unit tested.
 */
import type { AddressFields } from "./addresses";
import { cleanAddressFields } from "./addresses";
import type { CardFields } from "./cards";
import { cleanCardFields } from "./cards";
import type { AutofillFieldKind } from "./credentials-ipc";

/** Main to a frame's preload: fill these values into the form of the field at `box`. */
export const AUTOFILL_FRAME_FILL_CHANNEL = "corvus:autofill-frame-fill";
/** A frame's preload to main: how many fields the fill with this token wrote. */
export const AUTOFILL_FRAME_FILLED_CHANNEL = "corvus:autofill-frame-filled";

export interface FrameBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The frame a card or address field was clicked in, as the main process remembers it. */
export interface FrameTarget {
  processId: number;
  routingId: number;
  origin: string;
  /** The clicked field, in the frame's own coordinates. */
  box: FrameBox;
}

export type FrameFillRequest = { token: number; origin: string; box: FrameBox; kind: "card"; card: CardFields; cvv: string } | { token: number; origin: string; box: FrameBox; kind: "address"; address: AddressFields };

/** Only card and address field clicks are taken from a subframe; login and 2FA stay top-frame only. */
export function subframeFieldAllowed(kind: AutofillFieldKind): boolean {
  return kind === "card" || kind === "address";
}

/** The frame found now is the one clicked: same process and routing id, still attached, same origin. */
export function frameIsTarget(target: Pick<FrameTarget, "processId" | "routingId" | "origin">, frame: { processId: number; routingId: number; origin: string; detached: boolean } | null | undefined): boolean {
  return Boolean(frame) && !frame!.detached && frame!.processId === target.processId && frame!.routingId === target.routingId && frame!.origin === target.origin;
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
 * document, or beyond the window's right edge. Self-contained (no imports, no outer names): the top
 * frame's address fill script embeds its source.
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

const MAX_COORD = 1_000_000;
const num = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && Math.abs(n) <= MAX_COORD;

function parseBox(raw: unknown): FrameBox | null {
  if (typeof raw !== "object" || raw === null) return null;
  const b = raw as Record<string, unknown>;
  return num(b.x) && num(b.y) && num(b.width) && num(b.height) ? { x: b.x, y: b.y, width: b.width, height: b.height } : null;
}

/** What a frame's preload accepts to fill (it re-checks its own origin against `origin`). Null when malformed. */
export function parseFrameFillRequest(raw: unknown): FrameFillRequest | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const box = parseBox(r.box);
  if (!Number.isSafeInteger(r.token) || typeof r.origin !== "string" || !r.origin || r.origin.length > 4096 || !box) return null;
  const token = r.token as number;
  if (r.kind === "card") {
    if (typeof r.card !== "object" || r.card === null || typeof r.cvv !== "string" || !validCvv(r.cvv)) return null;
    return { token, origin: r.origin, box, kind: "card", card: cleanCardFields(r.card as Record<string, unknown>), cvv: r.cvv };
  }
  if (r.kind === "address") {
    if (typeof r.address !== "object" || r.address === null) return null;
    return { token, origin: r.origin, box, kind: "address", address: cleanAddressFields(r.address as Record<string, unknown>) };
  }
  return null;
}

export function parseFrameFilled(raw: unknown): { token: number; filled: number } | null {
  if (typeof raw !== "object" || raw === null) return null;
  const { token, filled } = raw as Record<string, unknown>;
  return Number.isSafeInteger(token) && Number.isSafeInteger(filled) && (filled as number) >= 0 && (filled as number) <= 1000 ? { token: token as number, filled: filled as number } : null;
}
