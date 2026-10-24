/**
 * Human-verification challenges (reCAPTCHA, hCaptcha, Turnstile, Arkose, ...) and how an agent
 * should handle them.
 *
 * Corvus normally passes these automatically because it is a real browser with the user's own
 * session. When one still appears, the agent must work through it with the normal tools first:
 * click the checkbox, wait, read the prompt, use the screenshot plus coordinate tools on tile or
 * image grids, and verify. Handing it to the person is the fallback after two failed attempts or
 * when the challenge leaves the page (SMS, e-mail code, ID document, another account factor).
 */
import type { ChallengeKind } from "./agent.js";

/** Challenges an agent can realistically work through with click/type/screenshot tools. */
const SELF_SOLVABLE: ReadonlySet<ChallengeKind> = new Set([
  "recaptcha",
  "hcaptcha",
  "turnstile",
  "arkose",
  "geetest",
  "interstitial",
]);

/** True when the agent should attempt the challenge instead of handing it over immediately. */
export function isSelfSolvableChallenge(kind: ChallengeKind): boolean {
  return SELF_SOLVABLE.has(kind);
}

/** The tool that pauses the run and asks the person to take over, when the agent cannot finish. */
export type HandoffToolName = "ask_user" | "request_user_action";

/**
 * Trusted guidance to append to a snapshot / screenshot result or to a prompt. Explains exactly how
 * to solve the challenge, how many attempts to make, and when to hand it to the person.
 */
export function challengeGuidance(
  kind: ChallengeKind,
  detail?: string,
  handoffTool: HandoffToolName = "request_user_action",
): string {
  const label = detail ? `${kind} (${detail})` : kind;
  const head = `challenge_detected: ${label}. A human-verification check is on the page.`;
  const solve =
    kind === "datadome" || kind === "interstitial"
      ? "This is usually a waiting screen: wait a few seconds, re-read the page, and reload once if it does not clear."
      : "Solve it yourself: click the checkbox or widget once (click_at on its center) and wait for it to settle, " +
        "then re-read the page and take a screenshot. If it shows tiles, images or a puzzle, select exactly what it " +
        "asks for by clicking the centers of those cells and press Verify. Re-read the challenge after each " +
        "attempt; do not reload the page or resubmit the form to reset it.";
  const fallback =
    `If two attempts fail, or it asks for a phone number, an email code, an ID document or another account ` +
    `factor, stop trying and call ${handoffTool} so the person finishes it; then continue.`;
  return `${head} ${solve} ${fallback}`;
}
