/**
 * Questions asked from the phone and answered by one of the user's computers with its AI search
 * (sync collection `asks`, one record per question, keyed by a random id). The phone writes the
 * question; the computer it went to writes the answer into the same record as it streams in, then
 * once more when it is done. The phone deletes a question to take it off its list.
 * Stopping an answer replaces the question with a "done" copy marked `stopped` (see stoppedAsk) and
 * deletes it, which stops the computer at its next write.
 *
 * Conversations: a follow-up carries `thread` (the id of the conversation's first question) and
 * `context` (the earlier questions and answers, oldest first), so the computer answers it in that
 * context and says so with `withContext`. All three are optional: a computer that predates them
 * answers the question alone, and a phone that predates them shows each question on its own.
 */
import type { SearchTurn } from "./search.js";
import { SENT_TAB_ID_RE } from "./sent-tabs.js";

export type AskState = "waiting" | "answering" | "done" | "error";

export interface AskSource {
  title: string;
  url: string;
}

/** A desktop Corvus Assist conversation a phone conversation continues (shown quoted on top of it). */
export interface AskOrigin {
  /** Its `assist_history` record id. */
  conversation: string;
  /** Its first question, or the title of its page. */
  title: string;
  /** The page it was about. */
  url: string;
}

export interface Ask {
  question: string;
  /** Device id of the computer asked. */
  to: string;
  /** Device id and display name of the phone that asked. */
  fromId: string;
  from: string;
  askedAt: number;
  state: AskState;
  /** The answer so far, with [n] marks citing `sources` (1-based). */
  answer: string;
  sources: AskSource[];
  /** Questions to ask next, as the search suggests them. */
  followUps: string[];
  /** Why the computer could not answer (state "error"). */
  error: string;
  /** Name of the computer that answered. */
  answeredBy: string;
  updatedAt: number;
  /** Id of the conversation's first question; absent on a first question (its own id is the thread). */
  thread?: string;
  /** Earlier turns of the conversation, oldest first (at most MAX_ASK_CONTEXT). */
  context?: SearchTurn[];
  /** The desktop Assist conversation this conversation continues (on its first question). */
  origin?: AskOrigin;
  /** Set by the computer when it answered with `context` (computers that predate it never set it). */
  withContext?: boolean;
  /**
   * The person stopped the answer on the phone: this record took the question's place (a new id, the
   * same conversation and `askedAt`) with the answer so far, marked "done", and the question was
   * deleted, which stops the computer. Computers only answer "waiting" questions, so they leave it be.
   */
  stopped?: boolean;
}

export interface AskRecord extends Ask {
  id: string;
}

export const ASK_ID_RE = SENT_TAB_ID_RE;
export const MAX_QUESTION = 1000;
export const MAX_ANSWER = 20_000;
export const MAX_ASK_SOURCES = 10;
/** Earlier turns a follow-up carries, and how much of each answer. */
export const MAX_ASK_CONTEXT = 4;
export const MAX_CONTEXT_ANSWER = 1500;
const DEVICE_ID_RE = /^[A-Za-z0-9-]{8,64}$/;
const STATES: readonly AskState[] = ["waiting", "answering", "done", "error"];

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const text = (v: unknown, max: number): string => (typeof v === "string" ? v.slice(0, max) : "");
const isUrl = (v: unknown): v is string => typeof v === "string" && /^https?:\/\//i.test(v) && v.length <= 2048;

function sources(raw: unknown): AskSource[] {
  if (!Array.isArray(raw)) return [];
  const out: AskSource[] = [];
  for (const s of raw) {
    if (!isObject(s) || !isUrl(s.url)) continue;
    out.push({ title: text(s.title, 300), url: s.url });
    if (out.length >= MAX_ASK_SOURCES) break;
  }
  return out;
}

/** The last MAX_ASK_CONTEXT valid turns, each trimmed to the limits. */
export function askContext(raw: unknown): SearchTurn[] {
  if (!Array.isArray(raw)) return [];
  const out: SearchTurn[] = [];
  for (const t of raw) {
    if (!isObject(t) || typeof t.question !== "string" || !t.question.trim()) continue;
    out.push({ question: t.question.trim().slice(0, MAX_QUESTION), answer: text(t.answer, MAX_CONTEXT_ANSWER).trim() });
  }
  return out.slice(-MAX_ASK_CONTEXT);
}

function origin(raw: unknown): AskOrigin | null {
  if (!isObject(raw) || typeof raw.conversation !== "string" || !raw.conversation || raw.conversation.length > 128) return null;
  return { conversation: raw.conversation, title: text(raw.title, 300), url: isUrl(raw.url) ? raw.url : "" };
}

/** Validate a record received from another device; null when it is not a question. */
export function parseAsk(raw: unknown): Ask | null {
  if (!isObject(raw) || typeof raw.question !== "string" || !raw.question.trim()) return null;
  if (typeof raw.to !== "string" || !DEVICE_ID_RE.test(raw.to)) return null;
  if (typeof raw.fromId !== "string" || !DEVICE_ID_RE.test(raw.fromId)) return null;
  if (typeof raw.askedAt !== "number" || !Number.isFinite(raw.askedAt)) return null;
  const state = STATES.includes(raw.state as AskState) ? (raw.state as AskState) : "waiting";
  const context = askContext(raw.context);
  const from = origin(raw.origin);
  return {
    question: raw.question.trim().slice(0, MAX_QUESTION),
    to: raw.to,
    fromId: raw.fromId,
    from: text(raw.from, 64),
    askedAt: raw.askedAt,
    state,
    answer: text(raw.answer, MAX_ANSWER),
    sources: sources(raw.sources),
    followUps: Array.isArray(raw.followUps) ? raw.followUps.filter((q): q is string => typeof q === "string" && q.trim() !== "").slice(0, 5).map((q) => q.slice(0, 300)) : [],
    error: text(raw.error, 500),
    answeredBy: text(raw.answeredBy, 64),
    updatedAt: typeof raw.updatedAt === "number" && Number.isFinite(raw.updatedAt) ? raw.updatedAt : raw.askedAt,
    ...(typeof raw.thread === "string" && ASK_ID_RE.test(raw.thread) ? { thread: raw.thread } : {}),
    ...(context.length ? { context } : {}),
    ...(from ? { origin: from } : {}),
    ...(raw.withContext === true ? { withContext: true } : {}),
    ...(raw.stopped === true ? { stopped: true } : {}),
  };
}

/** The valid records of an `asks` replica that match `filter`, newest first. */
export function askList(records: Record<string, unknown>, filter: (ask: Ask) => boolean): AskRecord[] {
  const out: AskRecord[] = [];
  for (const [id, raw] of Object.entries(records)) {
    if (!ASK_ID_RE.test(id)) continue;
    const ask = parseAsk(raw);
    if (ask && filter(ask)) out.push({ id, ...ask });
  }
  return out.sort((a, b) => b.askedAt - a.askedAt);
}

/** The conversation a question belongs to: the id of its first question. */
export function askThread(ask: AskRecord): string {
  return ask.thread ?? ask.id;
}

/** A follow-up's place in a conversation (see newAsk). */
export interface AskFollowUp {
  thread?: string;
  context?: SearchTurn[];
  origin?: AskOrigin;
}

/** A new question from the phone, waiting for its computer. */
export function newAsk(question: string, to: string, fromId: string, from: string, now: number, follow: AskFollowUp = {}): Ask {
  const context = askContext(follow.context);
  return {
    question: question.trim().slice(0, MAX_QUESTION),
    to,
    fromId,
    from: from.slice(0, 64),
    askedAt: now,
    state: "waiting",
    answer: "",
    sources: [],
    followUps: [],
    error: "",
    answeredBy: "",
    updatedAt: now,
    ...(follow.thread ? { thread: follow.thread } : {}),
    ...(context.length ? { context } : {}),
    ...(follow.origin ? { origin: follow.origin } : {}),
  };
}

/**
 * What takes the place of a question whose answer the person stopped (see `stopped`): the answer
 * so far and its sources, "done" without follow-ups, in the same conversation (a first question's
 * replacement names it as its thread) and at the same `askedAt`, so it keeps its place.
 */
export function stoppedAsk(ask: AskRecord, now: number): Ask {
  const { id, ...rest } = ask;
  return { ...rest, thread: ask.thread ?? id, state: "done", followUps: [], error: "", updatedAt: now, stopped: true };
}
