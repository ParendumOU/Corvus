import { newAsk, stoppedAsk, type AskRecord, type DeviceInfo } from '@corvus/shared';
import { afterEach, describe, expect, it } from 'vitest';

import { NO_ANSWER_YET, answeredAlone, askPhase, assistContext, assistOrigin, chatList, followUpContext, isOnline, phoneThreads, plainText, replaceAsk, searchChats, threadAsks } from '../src/lib/chat';
import { conversationList } from '../src/lib/conversations';
import { setUiLanguage } from '../src/lib/i18n';

const PHONE = 'phone-0000-0001';
const DESK = 'desk-0000-0001';
const ask = (id: string, question: string, at: number, extra: Partial<AskRecord> = {}): AskRecord => ({ id, ...newAsk(question, DESK, PHONE, 'Pixel', at), ...extra });
const name = (id: string): string => (id === DESK ? 'Desk' : 'your computer');

const first = ask('ask-0001', 'How long do ravens live?', 1000, { state: 'done', answer: 'About **10-15 years** in the wild [1].', answeredBy: 'Desk', updatedAt: 1500 });
const second = ask('ask-0002', 'And in captivity?', 3000, { thread: 'ask-0001', state: 'answering', answer: 'Up to', updatedAt: 3500 });
const other = ask('ask-0003', 'Weather in Lisbon?', 2000, { state: 'error', error: 'No AI provider' });
const conversations = conversationList({
  'demo-assist': {
    url: 'https://en.wikipedia.org/wiki/Common_raven',
    pageTitle: 'Common raven - Wikipedia',
    updatedAt: 2500,
    messages: [{ id: 'm1', kind: 'summarize', prompt: '', text: 'The raven is a large **black** bird.' }],
  },
});

describe('the Assist list', () => {
  afterEach(() => setUiLanguage('en'));

  it('groups questions into conversations, oldest first inside, newest conversation first', () => {
    expect(phoneThreads([first, second, other]).map((list) => list.map((a) => a.id))).toEqual([['ask-0001', 'ask-0002'], ['ask-0003']]);
    expect(threadAsks([second, other, first], 'ask-0001').map((a) => a.id)).toEqual(['ask-0001', 'ask-0002']);
  });

  it('lists phone and desktop conversations together, newest first, with what to show', () => {
    const list = chatList([first, second, other], conversations, name);
    expect(list.map((c) => `${c.kind}:${c.id}`)).toEqual(['phone:ask-0001', 'assist:demo-assist', 'phone:ask-0003']);
    expect(list[0]).toMatchObject({ title: 'How long do ravens live?', snippet: 'Up to', where: 'Desk', pending: true, failed: false });
    expect(list[1]).toMatchObject({ title: 'Summary of “Common raven - Wikipedia”', snippet: 'The raven is a large black bird.', where: 'en.wikipedia.org', url: 'https://en.wikipedia.org/wiki/Common_raven' });
    expect(list[2]).toMatchObject({ failed: true, where: 'Desk' });
    expect(searchChats(list, 'captivity').map((c) => c.id)).toEqual(['ask-0001']);
    expect(searchChats(list, 'BLACK bird').map((c) => c.id)).toEqual(['demo-assist']);
    expect(searchChats(list, 'desk lisbon').map((c) => c.id)).toEqual(['ask-0003']);
  });

  it('turns Markdown into one plain line', () => {
    expect(plainText('## Title\n\n- **Bold** item [2]\n- see [MDN](https://developer.mozilla.org/) and `code`\n```js\nx()\n```')).toBe('Title Bold item see MDN and code');
  });
});

describe('follow-ups', () => {
  it('carry the answered turns, after the desktop conversation they continue', () => {
    const origin = assistContext(conversations[0]!);
    const root = { ...first, context: origin };
    expect(origin[0]!.question).toBe('Summarize the page “Common raven - Wikipedia” (https://en.wikipedia.org/wiki/Common_raven)');
    expect(followUpContext([root, second])).toEqual([...origin, { question: 'How long do ravens live?', answer: 'About 10-15 years in the wild.' }]);
    expect(assistOrigin(conversations[0]!)).toEqual({ conversation: 'demo-assist', title: 'Summary of “Common raven - Wikipedia”', url: 'https://en.wikipedia.org/wiki/Common_raven' });
    const many = Array.from({ length: 6 }, (_, i) => ask(`ask-001${i}`, `q${i}`, i, { state: 'done', answer: `a${i}` }));
    expect(followUpContext(many).map((t) => t.question)).toEqual(['q2', 'q3', 'q4', 'q5']);
  });

  it('notice a computer that answered without the conversation', () => {
    const withContext = { ...second, state: 'done' as const, context: [{ question: 'q', answer: 'a' }] };
    expect(answeredAlone(withContext)).toBe(true);
    expect(answeredAlone({ ...withContext, withContext: true })).toBe(false);
    expect(answeredAlone(first)).toBe(false);
    // A question stopped before its computer took it up was not answered alone.
    expect(answeredAlone({ ...withContext, stopped: true })).toBe(false);
  });
});

describe('stopping an answer', () => {
  afterEach(() => setUiLanguage('en'));

  it('keeps the stopped answer in its place in the conversation, with what had come of it', () => {
    const stopped = { id: 'ask-0009', ...stoppedAsk({ ...second, answer: 'Up to **40** years [1]' }, 4000) };
    const thread = replaceAsk([first, second], second.id, stopped);
    expect(thread.map((a) => a.id)).toEqual(['ask-0001', 'ask-0009']);
    expect(askPhase(stopped, undefined, 5000)).toBe('stopped');
    // A message sent while it was coming is answered with it, as the next turn.
    expect(followUpContext(thread)).toEqual([
      { question: 'How long do ravens live?', answer: 'About 10-15 years in the wild.' },
      { question: 'And in captivity?', answer: 'Up to 40 years' },
    ]);
    // Replacing again (the list already had the copy) keeps one of it.
    expect(replaceAsk(thread, second.id, stopped).map((a) => a.id)).toEqual(['ask-0001', 'ask-0009']);
  });

  it('says so when it was stopped before any answer came', () => {
    const waiting = ask('ask-0005', 'What is the weather', 5000);
    const stopped = { id: 'ask-0006', ...stoppedAsk(waiting, 6000) };
    expect(stopped).toMatchObject({ thread: 'ask-0005', askedAt: 5000, state: 'done', answer: '', stopped: true });
    expect(followUpContext(replaceAsk([waiting], waiting.id, stopped))).toEqual([{ question: 'What is the weather', answer: NO_ANSWER_YET }]);
    // A conversation stopped this way lists as stopped, under its first question.
    const [chat] = chatList([stopped], [], name);
    expect(chat).toMatchObject({ id: 'ask-0005', title: 'What is the weather', snippet: 'Stopped', pending: false });
    setUiLanguage('es');
    expect(chatList([stopped], [], name)[0]!.snippet).toBe('Detenida');
  });

  it('a done answer that was not stopped is not taken for one, and an empty one adds nothing', () => {
    expect(askPhase(first, undefined, 1e9)).toBe('done');
    expect(followUpContext([{ ...first, answer: ' ' }])).toEqual([]);
  });
});

describe('where a question stands', () => {
  const desk = (lastSeen: number): DeviceInfo => ({ id: DESK, name: 'Desk', platform: 'win32', lastSeen });
  const waiting = ask('ask-0004', 'q', 100_000);

  it('tells a computer without Corvus open from one that is slow or stuck', () => {
    expect(askPhase(waiting, desk(99_000), 110_000)).toBe('waiting');
    expect(askPhase(waiting, desk(99_000), 150_000)).toBe('unanswered');
    expect(askPhase(waiting, desk(0), 110_000)).toBe('offline');
    expect(askPhase({ ...waiting, state: 'answering', updatedAt: 100_000 }, desk(0), 150_000)).toBe('answering');
    expect(askPhase({ ...waiting, state: 'answering', updatedAt: 100_000 }, desk(0), 300_000)).toBe('stalled');
    expect(askPhase({ ...waiting, state: 'done' }, undefined, 1e9)).toBe('done');
    // The computer's clock is 5 min behind: what counts is when the phone saw the answer move.
    expect(askPhase({ ...waiting, state: 'answering', updatedAt: 0 }, desk(0), 400_000, 395_000)).toBe('answering');
    expect(isOnline(desk(100_000), 150_000)).toBe(true);
    expect(isOnline(undefined, 0)).toBe(false);
  });
});
