/**
 * Safety classification for Command Bar agent actions. Pure so it can be unit-tested. A short
 * allow-list of read-only actions runs without asking; anything that submits a form, logs in or
 * otherwise commits a change is "risky" and needs the user's approval (when the "ask before risky
 * actions" setting is on). CAPTCHAs are never automated, and secrets are never typed by the agent:
 * the loop hands those back to the user.
 *
 * Some actions always ask, whatever the "ask before risky actions" setting says (`alwaysAsk`):
 * - anything that spends money (a click on "Buy now", "Place order", "Pagar", "Kinnita tellimus",
 *   or submitting a checkout or payment form), classified by the shared rules in @corvus/shared;
 * - the credential tools (fill_login, fill_totp): Corvus fills an opted-in saved login or 2FA code
 *   itself, by reference.
 */
import { isSpendClick, isSpendSubmit, spendHost, type SpendContext } from "@corvus/shared";

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
}

const SAFE: ActionRisk = { risky: false, handoff: false, reason: "" };

function str(input: unknown, key: string): string {
  const v = (input && typeof input === "object" ? (input as Record<string, unknown>)[key] : undefined) as unknown;
  return typeof v === "string" ? v : "";
}

function clip(text: string, max = 80): string {
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
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
    case "click":
      if (isSpendClick(elementName, ctx)) return { risky: true, handoff: false, alwaysAsk: true, spend: true, reason: `Spends money: clicks "${clip(elementName)}".` };
      if (RISKY_NAME.test(elementName)) return { risky: true, handoff: false, reason: `Clicks "${elementName}".` };
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

/** Whether a snapshot's detected challenge (CAPTCHA etc.) must be handed to the user. */
export function isChallengeHandoff(kind: string | undefined): boolean {
  return kind !== undefined && kind.length > 0;
}
