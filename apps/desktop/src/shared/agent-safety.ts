/**
 * Safety classification for Command Bar agent actions. Pure so it can be unit-tested. A short
 * allow-list of read-only actions runs without asking; anything that submits a form, logs in or
 * otherwise commits a change is "risky" and needs the user's approval (when the "ask before risky
 * actions" setting is on). Secrets are never typed by the agent: the loop hands those back to the
 * user. CAPTCHAs are different: the agent solves them with the visual tools, so acting inside a
 * CAPTCHA widget is allowed; it becomes a handoff only when the runner reports that solving failed.
 *
 * Some actions always ask, whatever the "ask before risky actions" setting says (`alwaysAsk`):
 * - anything that spends money (a click on "Buy now", "Place order", "Pagar", "Kinnita tellimus",
 *   or submitting a checkout or payment form), classified by the shared rules in @corvus/shared;
 * - the credential tools (fill_login, fill_totp): Corvus fills an opted-in saved login or 2FA code
 *   itself, by reference.
 */
import { isSpendClick, isSpendSubmit, spendHost, type SpendContext } from "@corvus/shared";
import { filenameOf } from "./link-grabber";
import { isActivationKey, parseKey } from "./visual-input";

export type { SpendContext } from "@corvus/shared";

/** Tools that fill a saved secret by reference. Always approved one use at a time. */
export const CREDENTIAL_TOOLS: ReadonlySet<string> = new Set(["fill_login", "fill_totp"]);

/** Tools that only read or move around, never commit a change. */
export const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  "page_snapshot",
  "screenshot",
  "extract",
  "wait",
  "list_tabs",
  "web_search",
  "scroll",
  "switch_tab",
  "ask_user",
  "hover_at",
  "scroll_at",
]);

/** Accessible names that mean an action commits something. */
const RISKY_NAME =
  /\b(buy|pay|payment|checkout|purchase|order|subscribe|confirm|submit|delete|remove|sign\s?in|log\s?in|logout|sign\s?out|sign\s?up|register|donate|send|transfer|book|reserve|apply|accept|agree|place\s?order|add\s?to\s?cart)\b/i;

/** URL fragments for pages where the agent must tread carefully. */
const RISKY_URL = /(checkout|payment|billing|\/login|signin|sign-in|password|account\/|\/pay\b|wallet)/i;

/** Field names that must never be filled automatically. */
const SECRET_NAME = /\b(password|passcode|pin|cvv|cvc|card\s?number|credit\s?card|security\s?code|otp|2fa)\b/i;

export interface ActionRisk {
  /** Needs the user's approval before running. */
  risky: boolean;
  /** A secret or challenge the agent must hand to the user instead of doing itself. */
  handoff: boolean;
  /** Short, human reason shown in the approval prompt. */
  reason: string;
  /** Ask even when "ask before risky actions" is off (spending money, saved logins, 2FA codes). */
  alwaysAsk?: boolean;
  /** The action spends money (always asks; a scheduled run never auto-approves it). */
  spend?: boolean;
  /** The action is inside a CAPTCHA / human-verification widget: allowed, solving it is the task. */
  challenge?: boolean;
}

const SAFE: ActionRisk = { risky: false, handoff: false, reason: "" };

function str(input: unknown, key: string): string {
  const v = (input && typeof input === "object" ? (input as Record<string, unknown>)[key] : undefined) as unknown;
  return typeof v === "string" ? v : "";
}

function clip(text: string, max = 80): string {
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

/** "Downloads 3 files into "Movie": Movie.part1.rar, Movie.part2.rar, Movie.part3.rar." */
function queueReason(input: unknown): string {
  const links = (input as { links?: unknown } | null)?.links;
  const list = Array.isArray(links) ? links.filter((l): l is string => typeof l === "string") : [];
  const names = list.slice(0, 5).map((l) => filenameOf(l) || l);
  const more = list.length > 5 ? ` and ${list.length - 5} more` : "";
  const into = str(input, "packageName") ? ` into "${clip(str(input, "packageName"), 60)}"` : "";
  return `Downloads ${list.length} ${list.length === 1 ? "file" : "files"}${into} with the download queue: ${clip(names.join(", "), 240)}${more}.`;
}

function spendSubmitReason(field: string, ctx: SpendContext): string {
  const into = field ? ` in "${clip(field)}"` : "";
  if (ctx.form?.submitName && isSpendClick(ctx.form.submitName, { role: ctx.form.submitRole || "button", ...(ctx.url ? { url: ctx.url } : {}) })) {
    return `Spends money: presses Enter${into}, which submits "${clip(ctx.form.submitName)}".`;
  }
  const host = spendHost(ctx.url);
  return `Spends money: submits a form on a checkout or payment page${host ? ` (${host})` : ""}.`;
}

/**
 * Classifies one tool call. `elementName` is the accessible name of the target element (from the
 * last snapshot, or read live) when the tool acts on an element, so a click on "Buy now" is caught
 * but a click on a plain link is not. `ctx` adds the element's role, the page URL and its form,
 * which the spend rules use (a "Books" link is not a purchase; Enter on a checkout page is).
 */
export function classifyAction(tool: string, input: unknown, elementName = "", ctx: SpendContext = {}): ActionRisk {
  switch (tool) {
    case "type": {
      const target = `${elementName} ${str(input, "ref")}`;
      if (SECRET_NAME.test(elementName)) return { risky: true, handoff: true, reason: "This field asks for a password or payment secret." };
      if ((input as { submit?: unknown })?.submit === true) {
        if (isSpendSubmit(ctx)) return { risky: true, handoff: false, alwaysAsk: true, spend: true, reason: spendSubmitReason(elementName, ctx) };
        return { risky: true, handoff: false, reason: `Submits the form by typing into ${elementName || "a field"}.` };
      }
      if (RISKY_NAME.test(target)) return { risky: true, handoff: false, reason: `Enters text into "${elementName}".` };
      return SAFE;
    }
    case "fill_form":
      return { risky: true, handoff: false, reason: "Fills in form fields." };
    case "fill_login":
      return { risky: true, handoff: false, alwaysAsk: true, reason: "Signs in with a saved login. The agent never sees the password." };
    case "fill_totp":
      return { risky: true, handoff: false, alwaysAsk: true, reason: "Fills a 2FA code. The agent never sees the code." };
    case "queue_downloads":
      return { risky: true, handoff: false, alwaysAsk: true, reason: queueReason(input) };
    case "click":
      if (isSpendClick(elementName, ctx)) return { risky: true, handoff: false, alwaysAsk: true, spend: true, reason: `Spends money: clicks "${clip(elementName)}".` };
      if (RISKY_NAME.test(elementName)) return { risky: true, handoff: false, reason: `Clicks "${elementName}".` };
      return SAFE;
    case "click_at":
    case "press_key":
    case "type_text":
      // Without a live read of the target: the conservative verdict (callers pass the target).
      return classifyPointAction(tool, input, null);
    case "close_tab":
      // Only a tab the run itself opened (RunTabs refuses the person's tabs).
      return SAFE;
    case "navigate":
    case "open_tab": {
      // Opening a checkout page is risky, not a spend: nothing is bought until a button says so.
      const url = str(input, "url");
      if (RISKY_URL.test(url)) return { risky: true, handoff: false, reason: "Opens a sign-in or payment page." };
      return SAFE;
    }
    default:
      if (READ_ONLY_TOOLS.has(tool)) return SAFE;
      // Unknown tools are treated as risky so a new capability cannot slip past the gate.
      return { risky: true, handoff: false, reason: `Runs "${tool}".` };
  }
}

/** Severity order: a handoff (secret, CAPTCHA) beats an always-ask, which beats plain risky. */
function rank(r: ActionRisk): number {
  if (r.handoff) return 3;
  if (r.alwaysAsk) return 2;
  return r.risky ? 1 : 0;
}

/** The stricter of two classifications of the same action (e.g. the snapshot name and the live one). */
export function stricterRisk(a: ActionRisk, b: ActionRisk): ActionRisk {
  return rank(b) > rank(a) ? b : a;
}

/**
 * What sits under a screen point (click_at) or has keyboard focus (press_key, type_text), read live
 * from the page with elementFromPoint / activeElement. role and name are computed like
 * page_snapshot (for the nearest clickable ancestor); `text` is the hit element's own text.
 */
export interface PointTarget {
  url: string;
  role: string;
  name: string;
  tag: string;
  text?: string;
  form?: SpendContext["form"];
  /** A password, one-time-code or card field. */
  secret?: boolean;
  /** Inside a CAPTCHA / human-verification widget. */
  captcha?: boolean;
  /** A cross-origin frame: its host (the element inside cannot be read). */
  frame?: string;
  /** A cross-origin frame served by a payment provider (Stripe, PayPal, Adyen, ...). */
  payFrame?: boolean;
  /** Nothing has focus (press_key / type_text). */
  none?: boolean;
}

function pointLabel(input: unknown): string {
  const o = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  return typeof o.x === "number" && typeof o.y === "number" ? ` at (${Math.round(o.x)}, ${Math.round(o.y)})` : "";
}

/**
 * Classifies a coordinate or keyboard action by what is really under the point / in focus, through
 * the same rules as click and type, so the spend gate cannot be sidestepped with coordinates:
 * - click_at on "Buy now" (or inside a payment provider's frame) spends money and always asks;
 * - press_key Enter/Space activates the focused control or submits its form, classified like a
 *   click on it or a type with submit;
 * - type_text into a password, one-time-code or card field is handed to the person;
 * - a CAPTCHA widget is allowed: solving it with the visual tools is the intended path, so the gate
 *   marks it (challenge: true) instead of blocking it;
 * - when Corvus cannot read the target at all, a click or activation always asks.
 * hover_at and scroll_at only move the pointer or the page and never ask.
 */
export function classifyPointAction(tool: string, input: unknown, target: PointTarget | null): ActionRisk {
  if (tool === "hover_at" || tool === "scroll_at") return SAFE;
  const press = tool === "press_key" ? parseKey(str(input, "key"), (input as { modifiers?: unknown } | null)?.modifiers) : null;
  const ctx = (t: PointTarget): SpendContext => ({ role: t.role, url: t.url, ...(t.form ? { form: t.form } : {}) });
  const unreadable: ActionRisk = { risky: true, handoff: false, alwaysAsk: true, reason: `Acts${pointLabel(input)} on something Corvus cannot read.` };
  if (target?.captcha) return { risky: false, handoff: false, challenge: true, reason: "Acts inside a CAPTCHA or human check to solve it." };

  if (tool === "click_at" || (press && isActivationKey(press))) {
    if (!target) return unreadable;
    if (tool === "press_key" && target.none) return SAFE;
    if (target.payFrame) return { risky: true, handoff: false, alwaysAsk: true, spend: true, reason: `Spends money: acts inside a payment form${target.frame ? ` (${target.frame})` : ""}.` };
    if (target.frame && RISKY_URL.test(target.url)) {
      return { risky: true, handoff: false, alwaysAsk: true, reason: `Acts inside an embedded frame (${target.frame}) on a sign-in or payment page.` };
    }
    const field = target.role === "textbox" || target.role === "searchbox" || target.role === "combobox";
    if (tool === "press_key" && field) return classifyAction("type", { submit: true }, target.name, ctx(target));
    const byName = classifyAction("click", input, target.name, ctx(target));
    const byText = target.text && target.text !== target.name ? classifyAction("click", input, target.text, ctx(target)) : SAFE;
    return stricterRisk(byName, byText);
  }
  if (tool === "type_text") {
    if (!target) return { risky: true, handoff: false, reason: "Types into a field Corvus cannot read." };
    if (target.none) return SAFE;
    if (target.secret || SECRET_NAME.test(target.name)) return { risky: true, handoff: true, reason: "This field asks for a password, code or payment secret." };
    return classifyAction("type", { text: str(input, "text") }, target.name, ctx(target));
  }
  if (tool === "press_key") return SAFE;
  return classifyAction(tool, input);
}

/** Whether a snapshot reports a human-verification challenge the agent must address. */
export function isChallengeDetected(kind: string | undefined): boolean {
  return kind !== undefined && kind.length > 0;
}

/** @deprecated The agent now solves challenges; use isChallengeDetected. */
export const isChallengeHandoff = isChallengeDetected;
