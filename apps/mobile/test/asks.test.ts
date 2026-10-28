import { newAsk, parseAsk, stoppedAsk } from '@corvus/shared';
import { describe, expect, it } from 'vitest';

import { myAsks } from '../src/lib/asks';

const PHONE = 'phone-0000-0001';
const DESK = 'desk-0000-0001';
const OTHER = 'phone-0000-0002';

describe('questions to a computer', () => {
  it("reads valid records only, and only this phone's, newest first", () => {
    const records = {
      'ask-0001': newAsk('First?', DESK, PHONE, 'Pixel', 1000),
      'ask-0002': { ...newAsk('Second?', DESK, PHONE, 'Pixel', 2000), state: 'answering', answer: 'Partly [1]', sources: [{ title: 'R', url: 'https://r.example/' }, { title: 'bad', url: 'javascript:x' }] },
      'ask-0003': newAsk('Someone else?', DESK, OTHER, 'Tablet', 3000),
      'ask-0004': { question: '', to: DESK, fromId: PHONE, askedAt: 1 },
      bad: newAsk('Bad id', DESK, PHONE, 'Pixel', 4000),
    };
    const mine = myAsks(records, PHONE);
    expect(mine.map((a) => a.question)).toEqual(['Second?', 'First?']);
    expect(mine[0]).toMatchObject({ state: 'answering', answer: 'Partly [1]', sources: [{ title: 'R', url: 'https://r.example/' }] });
    expect(myAsks(records, null)).toEqual([]);
    expect(parseAsk({ ...newAsk('x', DESK, PHONE, 'p', 1), state: 'nonsense' })?.state).toBe('waiting');
  });

  it('reads a stopped answer, and only a real flag', () => {
    const done = { ...newAsk('Stopped?', DESK, PHONE, 'Pixel', 1000), state: 'done', answer: 'Partly', stopped: true };
    expect(parseAsk(done)).toMatchObject({ state: 'done', answer: 'Partly', stopped: true });
    expect(Object.keys(parseAsk({ ...done, stopped: 'yes' })!)).not.toContain('stopped');
    expect(Object.keys(parseAsk(newAsk('x', DESK, PHONE, 'p', 1))!)).not.toContain('stopped');
  });

  it('stops a question with a copy in its place: same conversation and time, done, the answer so far', () => {
    const answering = { id: 'ask-0007', ...newAsk('Why?', DESK, PHONE, 'Pixel', 1000, { context: [{ question: 'q', answer: 'a' }] }), state: 'answering' as const, answer: 'Because [1]', sources: [{ title: 'R', url: 'https://r.example/' }], answeredBy: 'Desk', withContext: true };
    const copy = stoppedAsk(answering, 2000);
    expect(copy).toEqual({ ...newAsk('Why?', DESK, PHONE, 'Pixel', 1000, { context: [{ question: 'q', answer: 'a' }] }), thread: 'ask-0007', state: 'done', answer: 'Because [1]', sources: [{ title: 'R', url: 'https://r.example/' }], answeredBy: 'Desk', withContext: true, updatedAt: 2000, stopped: true });
    // A follow-up keeps its conversation's id; the copy reads back the same from the chain.
    expect(stoppedAsk({ ...answering, thread: 'ask-0001' }, 2000).thread).toBe('ask-0001');
    expect(parseAsk(JSON.parse(JSON.stringify(copy)))).toEqual(copy);
  });

  it('keeps a follow-up in its conversation, with the earlier turns', () => {
    const follow = newAsk('And in captivity?', DESK, PHONE, 'Pixel', 2000, { thread: 'ask-0001', context: [{ question: 'How long do ravens live?', answer: '10-15 years.' }] });
    const [ask] = myAsks({ 'ask-0002': follow }, PHONE);
    expect(ask).toMatchObject({ thread: 'ask-0001', context: [{ question: 'How long do ravens live?', answer: '10-15 years.' }] });
  });
});
