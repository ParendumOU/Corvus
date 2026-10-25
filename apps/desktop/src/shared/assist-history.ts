/**
 * Assist conversation history: each conversation of the side panel is kept per profile (never for
 * private windows) with the page it was on, so the person can find it again and carry on there.
 * Pure helpers shared by the main process and tests.
 */
import type { AssistActionKind, AssistMessage } from "./assist-ipc";

/** Conversations kept per profile, newest first. */
export const MAX_CONVERSATIONS = 200;
/** Messages kept per conversation (the latest). */
export const MAX_CONVERSATION_MESSAGES = 60;
/** Characters kept of each answer. */
const MAX_TEXT = 20_000;

/** The kinds of message that make a conversation worth keeping (not page translation or writing). */
export const HISTORY_KINDS: ReadonlySet<AssistActionKind> = new Set<AssistActionKind>(["ask", "summarize", "explain", "translate-selection", "compare"]);

export interface AssistConversation {
  id: string;
  /** The page the conversation was last on: opening it from the history goes back there. */
  url: string;
  pageTitle: string;
  createdAt: number;
  updatedAt: number;
  messages: AssistMessage[];
}

/** One line of the history list. */
export interface AssistConversationSummary {
  id: string;
  /** The first question, or "" when the conversation started with a summary or a selection. */
  title: string;
  /** What it started with, to name it when there is no question. */
  kind: AssistActionKind;
  url: string;
  pageTitle: string;
  updatedAt: number;
  count: number;
}

export function summarizeConversation(c: AssistConversation): AssistConversationSummary {
  const first = c.messages[0];
  const question = c.messages.find((m) => m.kind === "ask" && m.prompt.trim());
  return {
    id: c.id,
    title: (question?.prompt ?? "").replace(/\s+/g, " ").trim().slice(0, 120),
    kind: first?.kind ?? "ask",
    url: c.url,
    pageTitle: c.pageTitle,
    updatedAt: c.updatedAt,
    count: c.messages.length,
  };
}

/** The messages worth keeping, finished, without screenshots or pending prompts. */
export function keptMessages(messages: readonly AssistMessage[]): AssistMessage[] {
  return messages
    .filter((m) => HISTORY_KINDS.has(m.kind) && m.status !== "streaming")
    .slice(-MAX_CONVERSATION_MESSAGES)
    .map((m) => {
      const { agent, ...rest } = m;
      const text = m.text.length > MAX_TEXT ? `${m.text.slice(0, MAX_TEXT)}…` : m.text;
      if (!agent) return { ...rest, text };
      const steps = agent.steps.map(({ thumb: _thumb, ...s }) => s);
      const { takenOver: _takenOver, ...view } = agent;
      return { ...rest, text, agent: { ...view, steps, approval: null } };
    });
}

/** Messages and characters of each answer a synced conversation carries (a record stays small). */
export const SYNC_MESSAGES = 30;
const SYNC_TEXT = 8000;

/** The conversation as synced to the person's other devices: its latest messages, answers capped. */
export function syncedConversation(c: AssistConversation): AssistConversation {
  return {
    ...c,
    messages: c.messages.slice(-SYNC_MESSAGES).map((m) => (m.text.length > SYNC_TEXT ? { ...m, text: `${m.text.slice(0, SYNC_TEXT)}…` } : m)),
  };
}

/** Search the history: every word must appear in the question, the page title or its address. */
export function matchesConversation(s: AssistConversationSummary, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const hay = `${s.title} ${s.pageTitle} ${s.url}`.toLowerCase();
  return words.every((w) => hay.includes(w));
}

const STATUSES: ReadonlySet<string> = new Set(["done", "error", "cancelled"]);

/** A conversation read back from disk, or null when it is not one. */
export function reviveConversation(raw: unknown): AssistConversation | null {
  const r = raw as Partial<AssistConversation> | null;
  if (!r || typeof r.id !== "string" || typeof r.url !== "string" || !Array.isArray(r.messages)) return null;
  const messages = r.messages
    .filter((m): m is AssistMessage => {
      const x = m as Partial<AssistMessage> | null;
      return Boolean(x) && typeof x!.id === "string" && typeof x!.kind === "string" && HISTORY_KINDS.has(x!.kind as AssistActionKind) && typeof x!.prompt === "string" && typeof x!.text === "string";
    })
    .map((m) => ({ ...m, status: STATUSES.has(m.status) ? m.status : "cancelled", at: typeof m.at === "number" ? m.at : 0 }))
    .slice(-MAX_CONVERSATION_MESSAGES);
  if (messages.length === 0) return null;
  return {
    id: r.id,
    url: r.url,
    pageTitle: typeof r.pageTitle === "string" ? r.pageTitle : "",
    createdAt: typeof r.createdAt === "number" ? r.createdAt : 0,
    updatedAt: typeof r.updatedAt === "number" ? r.updatedAt : 0,
    messages,
  };
}
