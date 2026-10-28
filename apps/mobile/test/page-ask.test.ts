import { MAX_CONTEXT_ANSWER, askContext } from '@corvus/shared';
import { describe, expect, it } from 'vitest';

import { contextPage, pageContext, parsePageText } from '../src/lib/page-ask';

describe('asking Corvus about a page', () => {
  it('sends the page as the first turn of the conversation', () => {
    const turns = pageContext({ url: 'https://en.wikipedia.org/wiki/Crow', title: 'Crow - Wikipedia' }, { title: 'x', description: 'Crows are birds.', text: 'A crow is a bird of the genus Corvus.\n\n  It is   clever.' });
    expect(turns).toEqual([{ question: 'The page I am reading: “Crow - Wikipedia” (https://en.wikipedia.org/wiki/Crow)', answer: 'Crows are birds. A crow is a bird of the genus Corvus. It is clever.' }]);
    // It survives the chain's own checks of a context.
    expect(askContext(turns)).toEqual(turns);
  });

  it('keeps within what the computer reads of a turn', () => {
    const [turn] = pageContext({ url: `https://a.com/${'p'.repeat(400)}`, title: 'T'.repeat(300) }, { title: '', description: '', text: 'word '.repeat(2000) });
    expect(turn!.question.length).toBeLessThanOrEqual(300);
    expect(turn!.answer.length).toBeLessThanOrEqual(MAX_CONTEXT_ANSWER);
    expect(turn!.answer.endsWith('…')).toBe(true);
  });

  it('leaves out a description the text starts with, and works without any text', () => {
    const [turn] = pageContext({ url: 'https://a.com/', title: '' }, { title: 'Page', description: 'Hello world, this is a page about things.', text: 'Hello world, this is a page about things. More.' });
    expect(turn).toEqual({ question: 'The page I am reading: “Page” (https://a.com/)', answer: 'Hello world, this is a page about things. More.' });
    expect(pageContext({ url: 'https://a.com/', title: '' }, null)).toEqual([{ question: 'The page I am reading: (https://a.com/)', answer: '' }]);
  });

  it('finds the page of a chat about one again', () => {
    expect(contextPage(pageContext({ url: 'https://a.com/x?y=(1)', title: 'A “quoted” page' }, null))).toEqual({ url: 'https://a.com/x?y=(1)', title: 'A “quoted” page' });
    expect(contextPage(pageContext({ url: 'https://a.com/', title: '' }, null))).toEqual({ url: 'https://a.com/', title: '' });
    expect(contextPage([{ question: 'What about winter?', answer: 'Cold.' }])).toBeNull();
    expect(contextPage(undefined)).toBeNull();
  });

  it('reads what the page script returned', () => {
    expect(parsePageText(JSON.stringify(JSON.stringify({ title: 'T', description: 'D', text: 'X' })))).toEqual({ title: 'T', description: 'D', text: 'X' });
    expect(parsePageText('{"title":1}')).toEqual({ title: '', description: '', text: '' });
    expect(parsePageText('null')).toBeNull();
    expect(parsePageText('not json')).toBeNull();
    expect(parsePageText(null)).toBeNull();
  });
});
