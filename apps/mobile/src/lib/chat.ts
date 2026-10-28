/**
 * The Assist tab's conversations: the phone's own (questions to a computer, sync collection `asks`,
 * grouped into conversations by their `thread`) and the Corvus Assist conversations had on the
 * computers (`assist_history`, read only on the phone), in one list. Pure, so it is tested as is.
 */
import { askThread, MAX_ASK_CONTEXT, MAX_CONTEXT_ANSWER, type AskOrigin, type AskRecord, type DeviceInfo, type SearchTurn } from '@corvus/shared';

import type { ConversationView } from './conversations';
import { contextPage } from './page-ask';
import { t } from './i18n';
import { tabHost } from './replica';

/** A row of the conversation list. */
export interface ChatSummary {
  /** The thread id (a phone conversation) or the `assist_history` record id. */
  id: string;
  kind: 'phone' | 'assist';
  title: string;
  /** The last answer (or question) as one plain line. */
  snippet: string;
  updatedAt: number;
  /** Who answered: the computer's name (phone conversations), or the page (desktop Assist). */
  where: string;
  /** The page a desktop Assist conversation was about. */
  url: string;
  /** A computer has yet to finish the last answer. */
  pending: boolean;
  /** No computer has started on the last question yet. */
  waiting: boolean;
  /** The last question could not be answered. */
  failed: boolean;
  /** Every question and answer, for the search. */
  text: string;
}

/** Markdown as one plain line: no marks, citations, links' addresses or artifacts. */
export function plainText(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    .replace(/\s*\[(\d{1,2})\]/g, '')
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '$1')
    .replace(/^\s{0,3}(#{1,6}|[-*•]|\d+[.)])\s+/gm, '')
    .replace(/(\*\*|__|`)/g, '')
    .replace(/(^|\s)[*_]([^*_\n]+)[*_]/g, '$1$2')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The phone's questions grouped by conversation, each oldest first; conversations newest first. */
export function phoneThreads(asks: readonly AskRecord[]): AskRecord[][] {
  const byThread = new Map<string, AskRecord[]>();
  for (const ask of asks) {
    const id = askThread(ask);
    byThread.set(id, [...(byThread.get(id) ?? []), ask]);
  }
  return [...byThread.values()]
    .map((list) => [...list].sort((a, b) => a.askedAt - b.askedAt))
    .sort((a, b) => b[b.length - 1]!.askedAt - a[a.length - 1]!.askedAt);
}

/** The questions of one conversation, oldest first (empty when it is gone). */
export function threadAsks(asks: readonly AskRecord[], thread: string): AskRecord[] {
  return asks.filter((a) => askThread(a) === thread).sort((a, b) => a.askedAt - b.askedAt);
}

const pendingState = (a: AskRecord): boolean => a.state === 'waiting' || a.state === 'answering';

/** A desktop Assist conversation's name: its first question, else what it was about. */
export function assistTitle(c: ConversationView): string {
  if (c.title) return c.title;
  const page = c.pageTitle || tabHost(c.url);
  return c.turns[0]?.kind === 'summarize' ? t('Summary of “{title}”', { title: page }) : page;
}

/** Both kinds of conversations, newest first. */
export function chatList(asks: readonly AskRecord[], conversations: readonly ConversationView[], deviceName: (id: string) => string): ChatSummary[] {
  const phone = phoneThreads(asks).map((list): ChatSummary => {
    const first = list[0]!;
    const last = list[list.length - 1]!;
    const answer = plainText(last.answer);
    return {
      id: askThread(first),
      kind: 'phone',
      title: first.question,
      snippet: answer || (last.stopped ? t('Stopped') : list.length > 1 ? last.question : ''),
      updatedAt: Math.max(last.askedAt, last.updatedAt),
      where: last.answeredBy || deviceName(last.to),
      url: first.origin?.url ?? contextPage(first.context)?.url ?? '',
      pending: pendingState(last),
      waiting: last.state === 'waiting',
      failed: last.state === 'error',
      text: list.map((a) => `${a.question} ${a.answer}`).join(' ') + (first.origin ? ` ${first.origin.title}` : ''),
    };
  });
  const assist = conversations.map((c): ChatSummary => {
    const last = c.turns[c.turns.length - 1];
    return {
      id: c.id,
      kind: 'assist',
      title: assistTitle(c),
      snippet: plainText(last?.text ?? ''),
      updatedAt: c.updatedAt,
      where: tabHost(c.url) || c.pageTitle,
      url: c.url,
      pending: false,
      waiting: false,
      failed: false,
      text: `${c.pageTitle} ${c.url} ${c.turns.map((x) => `${x.prompt} ${x.text}`).join(' ')}`,
    };
  });
  return [...phone, ...assist].sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Conversations with every word of the query in a question, an answer, a page or a computer. */
export function searchChats(list: readonly ChatSummary[], query: string): ChatSummary[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...list];
  return list.filter((c) => {
    const hay = `${c.title} ${c.where} ${c.text}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

const turn = (question: string, answer: string): SearchTurn => ({ question: question.slice(0, 1000), answer: plainText(answer).slice(0, MAX_CONTEXT_ANSWER) });

/** What a question stopped before any answer came carries as its answer (for the computer's AI). */
export const NO_ANSWER_YET = '(no answer yet)';

/**
 * What a follow-up carries: the conversation's answered turns, last ones first to go when there are
 * too many, after the desktop conversation it continues (if any). A stopped answer counts with what
 * had come of it, so a message sent to add to a question answers that question with it.
 */
export function followUpContext(thread: readonly AskRecord[]): SearchTurn[] {
  const first = thread[0];
  const answered = thread
    .filter((a) => a.state === 'done' && (a.answer.trim() || a.stopped))
    .map((a) => (a.answer.trim() ? turn(a.question, a.answer) : turn(a.question, NO_ANSWER_YET)));
  return [...(first?.context ?? []), ...answered].slice(-MAX_ASK_CONTEXT);
}

/** The conversation once `next` took the place of question `id` (its answer stopped), oldest first. */
export function replaceAsk(thread: readonly AskRecord[], id: string, next: AskRecord): AskRecord[] {
  return [...thread.filter((a) => a.id !== id && a.id !== next.id), next].sort((a, b) => a.askedAt - b.askedAt);
}

/** A desktop Assist conversation as the context of a phone conversation that continues it. */
export function assistContext(c: ConversationView): SearchTurn[] {
  const page = c.pageTitle || tabHost(c.url);
  return c.turns
    .filter((x) => x.text.trim())
    .map((x) => turn(x.prompt.trim() || (x.kind === 'summarize' ? t('Summarize the page “{title}” ({url})', { title: page, url: c.url }) : page), x.text))
    .slice(-MAX_ASK_CONTEXT);
}

/** How a phone conversation continuing a desktop one names it. */
export function assistOrigin(c: ConversationView): AskOrigin {
  return { conversation: c.id, title: assistTitle(c).slice(0, 300), url: c.url };
}

/** How long a computer's last contact with the sync server can be for it to count as running Corvus (it checks for questions every 2 s; older ones every 5 s). */
export const ONLINE_MS = 90_000;
/** A question nobody picked up for this long while its computer runs Corvus: its setting may be off. */
export const UNANSWERED_MS = 45_000;
/** An answer that has not moved for this long: the computer stopped writing it. */
export const STALLED_MS = 2 * 60_000;

export type AskPhase = 'waiting' | 'offline' | 'unanswered' | 'answering' | 'stalled' | 'done' | 'stopped' | 'error';

/**
 * Where a question stands, telling a computer without Corvus open apart from one that is slow.
 * `movedAt` is when the phone last saw the question change, on its own clock (lib/answer-follow.ts);
 * without it the computer's `updatedAt` is used, which is off by however far the clocks are apart.
 */
export function askPhase(ask: AskRecord, computer: DeviceInfo | undefined, now: number, movedAt: number = ask.updatedAt): AskPhase {
  if (ask.stopped) return 'stopped';
  if (ask.state === 'done' || ask.state === 'error') return ask.state;
  if (ask.state === 'answering') return now - movedAt > STALLED_MS ? 'stalled' : 'answering';
  if (computer && now - computer.lastSeen > ONLINE_MS) return 'offline';
  return now - ask.askedAt > UNANSWERED_MS ? 'unanswered' : 'waiting';
}

/** True when a computer counts as running Corvus right now. */
export function isOnline(computer: DeviceInfo | undefined, now: number): boolean {
  return !!computer && now - computer.lastSeen <= ONLINE_MS;
}

/** A follow-up the computer answered without its conversation (a Corvus that predates follow-ups). */
export function answeredAlone(ask: AskRecord): boolean {
  return ask.state === 'done' && !ask.stopped && (ask.context?.length ?? 0) > 0 && !ask.withContext;
}
