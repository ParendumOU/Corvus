import { newAsk, parseAsk, type AskRecord } from '@corvus/shared';
import { describe, expect, it } from 'vitest';

import { answerParts, answering, askStatus, myAsks } from '../src/lib/asks';

const PHONE = 'phone-0000-0001';
const DESK = 'desk-0000-0001';
const OTHER = 'phone-0000-0002';
const record = (id: string, extra: Partial<AskRecord> = {}): AskRecord => ({ id, ...newAsk('How long do ravens live?', DESK, PHONE, 'Pixel', 1000), ...extra });

describe('questions to a computer', () => {
  it('reads valid records only, and only this phone\'s, newest first', () => {
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

  it('says where each question stands', () => {
    const name = (id: string): string => (id === DESK ? 'Desk' : 'your computer');
    expect(askStatus(record('a'), name)).toBe('Waiting for Desk (Corvus must be open there)…');
    expect(askStatus(record('a', { state: 'answering', answeredBy: 'Laptop' }), name)).toBe('Laptop is answering…');
    expect(askStatus(record('a', { state: 'done' }), name)).toBe('Answered by Desk');
    expect(askStatus(record('a', { state: 'error', error: 'No AI provider is set up.' }), name)).toBe('Desk could not answer: No AI provider is set up.');
    expect(answering([record('a', { state: 'done' }), record('b', { state: 'answering' })])).toBe(true);
    expect(answering([record('a', { state: 'done' }), record('b', { state: 'error' })])).toBe(false);
  });

  it('splits an answer into text and citations of its sources', () => {
    expect(answerParts('Ravens live 10-15 years [1] in the wild [2][7].', 2)).toEqual([
      { text: 'Ravens live 10-15 years ' },
      { cite: 1 },
      { text: ' in the wild ' },
      { cite: 2 },
      { text: '[7].' },
    ]);
    expect(answerParts('', 3)).toEqual([]);
    expect(answerParts('[1]', 1)).toEqual([{ cite: 1 }]);
  });
});
