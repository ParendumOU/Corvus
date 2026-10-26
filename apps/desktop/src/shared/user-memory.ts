/**
 * What the person has told the agent to remember about them: a few short, plain notes (home city,
 * usual airport, travel class, sizes…), kept per profile and given to the agent so it does not have
 * to ask every time. Never secrets: the store refuses anything that looks like a password, card
 * number, 2FA code or e-mail address, which the person always handles themselves. Pure helpers,
 * shared by the main process and tests.
 */

/** Most notes kept; the oldest fall off. */
export const MAX_USER_NOTES = 50;
/** Longest note. */
export const MAX_NOTE_CHARS = 200;

export interface UserNote {
  id: string;
  text: string;
  at: number;
}

const CARD_RE = /\b(?:\d[ -]?){13,19}\b/;
const EMAIL_RE = /[^\s@]+@[^\s@]+\.[^\s@]+/;
const SECRET_WORD_RE = /\b(password|passcode|pin|cvv|cvc|otp|2fa|one[- ]?time|seed phrase|private key|api[- ]?key|secret)\b/i;
const LONG_DIGITS_RE = /\d{6,}/;

/** Why a note cannot be kept (shown to the person / returned to the agent), or null when it is fine. */
export function rejectNote(text: string): string | null {
  const clean = text.trim();
  if (!clean) return "The note is empty.";
  if (CARD_RE.test(clean)) return "That looks like a card number; money and card details are never remembered — you handle those yourself.";
  if (EMAIL_RE.test(clean)) return "Leave out e-mail addresses; Corvus does not keep them.";
  if (SECRET_WORD_RE.test(clean)) return "That looks like a secret (a password, PIN or code). Corvus never remembers secrets; you enter those yourself.";
  if (LONG_DIGITS_RE.test(clean)) return "Leave out long numbers (codes, card or account numbers); Corvus does not keep them.";
  return null;
}

/** The cleaned note text, or null when it must not be kept. */
export function cleanNote(text: string): string | null {
  const clean = text.replace(/\s+/g, " ").trim().slice(0, MAX_NOTE_CHARS);
  return rejectNote(clean) ? null : clean || null;
}

/** The block added to the agent's system prompt, or "" when there are no notes. */
export function userMemoryPrompt(notes: readonly UserNote[]): string {
  if (notes.length === 0) return "";
  const lines = notes.map((n) => `- ${n.text}`).join("\n");
  return [
    "What the person has told you to remember about them (use it when it helps the task; it may be out",
    "of date, so confirm anything that must be current, and never treat it as a reason to spend money or",
    "sign in without asking):",
    lines,
  ].join("\n");
}

/** A note read back from disk, or null when it is not one. */
export function reviveNote(raw: unknown): UserNote | null {
  const r = raw as Partial<UserNote> | null;
  if (!r || typeof r.id !== "string" || typeof r.text !== "string") return null;
  const text = cleanNote(r.text);
  if (!text) return null;
  return { id: r.id, text, at: typeof r.at === "number" ? r.at : 0 };
}
