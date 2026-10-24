/**
 * Asking Corvus from the phone: the question goes to one of the chain's computers, which answers
 * it with its AI search and writes the answer back as it comes (sync collection `asks`).
 */
import { askList, type AskRecord } from '@corvus/shared';

import { t } from './i18n';

/** This phone's questions, newest first. */
export function myAsks(records: Record<string, unknown>, self: string | null): AskRecord[] {
  return self ? askList(records, (a) => a.fromId === self) : [];
}

/** True while a computer has yet to finish one of them (the screen keeps refreshing). */
export function answering(asks: readonly AskRecord[]): boolean {
  return asks.some((a) => a.state === 'waiting' || a.state === 'answering');
}

/** One line on where a question stands. */
export function askStatus(ask: AskRecord, deviceName: (id: string) => string): string {
  const computer = ask.answeredBy || deviceName(ask.to);
  switch (ask.state) {
    case 'waiting':
      return t('Waiting for {computer} (Corvus must be open there)…', { computer: deviceName(ask.to) });
    case 'answering':
      return t('{computer} is answering…', { computer });
    case 'done':
      return t('Answered by {computer}', { computer });
    case 'error':
      return t('{computer} could not answer: {error}', { computer, error: ask.error || t('something went wrong') });
  }
}

export type AnswerPart = { text: string } | { cite: number };

/** The answer as text and [n] citations of its sources (marks for sources it does not have stay text). */
export function answerParts(answer: string, sources: number): AnswerPart[] {
  const parts: AnswerPart[] = [];
  let at = 0;
  for (const m of answer.matchAll(/\[(\d{1,2})\]/g)) {
    const n = Number(m[1]);
    if (n < 1 || n > sources) continue;
    if (m.index > at) parts.push({ text: answer.slice(at, m.index) });
    parts.push({ cite: n });
    at = m.index + m[0].length;
  }
  if (at < answer.length) parts.push({ text: answer.slice(at) });
  return parts;
}
