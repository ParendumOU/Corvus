/**
 * Safety classification for Command Bar agent actions. Pure so it can be unit-tested. A short
 * allow-list of read-only actions runs without asking; anything that submits a form, spends money,
 * logs in or otherwise commits a change is "risky" and needs the user's approval (when the
 * "ask before risky actions" setting is on). Secrets and CAPTCHAs are never automated: the loop
 * hands those back to the user instead.
 */

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
}

const SAFE: ActionRisk = { risky: false, handoff: false, reason: "" };

function str(input: unknown, key: string): string {
  const v = (input && typeof input === "object" ? (input as Record<string, unknown>)[key] : undefined) as unknown;
  return typeof v === "string" ? v : "";
}

/**
 * Classifies one tool call. `elementName` is the accessible name of the target element (from the
 * last snapshot) when the tool acts on an element, so a click on "Buy now" is caught but a click on
 * a plain link is not.
 */
export function classifyAction(tool: string, input: unknown, elementName = ""): ActionRisk {
  switch (tool) {
    case "type": {
      const target = `${elementName} ${str(input, "ref")}`;
      if (SECRET_NAME.test(elementName)) return { risky: true, handoff: true, reason: "This field asks for a password or payment secret." };
      if ((input as { submit?: unknown })?.submit === true) return { risky: true, handoff: false, reason: `Submits the form by typing into ${elementName || "a field"}.` };
      if (RISKY_NAME.test(target)) return { risky: true, handoff: false, reason: `Enters text into "${elementName}".` };
      return SAFE;
    }
    case "fill_form":
      return { risky: true, handoff: false, reason: "Fills in form fields." };
    case "click":
      if (RISKY_NAME.test(elementName)) return { risky: true, handoff: false, reason: `Clicks "${elementName}".` };
      return SAFE;
    case "navigate":
    case "open_tab": {
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

/** Whether a snapshot's detected challenge (CAPTCHA etc.) must be handed to the user. */
export function isChallengeHandoff(kind: string | undefined): boolean {
  return kind !== undefined && kind.length > 0;
}
