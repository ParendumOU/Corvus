import { describe, expect, it } from 'vitest';
import { conversationList, searchConversations, withoutArtifacts } from '../src/lib/conversations';

const record = (updatedAt: number, messages: unknown[], url = 'https://www.google.com/travel/flights', pageTitle = 'Google Flights') => ({ url, pageTitle, updatedAt, messages });

describe('Assist conversations on the phone', () => {
  it('lists valid conversations newest first, named by their first question', () => {
    const list = conversationList({
      a: record(1, [{ id: 'm1', kind: 'ask', prompt: '  cheapest   flight to Lisbon ', text: 'Vueling, 111 €' }]),
      b: record(5, [{ id: 'm2', kind: 'summarize', prompt: '', text: 'A summary' }], 'https://news.example/', 'News'),
      broken: { url: 'x' },
      empty: record(9, []),
    });
    expect(list.map((c) => c.id)).toEqual(['b', 'a']);
    expect(list[1]).toMatchObject({ title: 'cheapest flight to Lisbon', pageTitle: 'Google Flights' });
    expect(list[0]!.title).toBe('');
    expect(list[1]!.turns[0]).toEqual({ id: 'm1', kind: 'ask', prompt: '  cheapest   flight to Lisbon ', text: 'Vueling, 111 €' });
  });

  it('finds a conversation by its question, page title or address', () => {
    const list = conversationList({ a: record(1, [{ id: 'm1', kind: 'ask', prompt: 'cheapest flight to Lisbon', text: 'x' }]) });
    expect(searchConversations(list, 'lisbon google')).toHaveLength(1);
    expect(searchConversations(list, 'travel/flights')).toHaveLength(1);
    expect(searchConversations(list, 'madrid')).toHaveLength(0);
  });
});

describe('artifacts in answers', () => {
  it('shows each one as its title instead of its JSON', () => {
    const fence = '```';
    const text = `Two options:\n${fence}artifact\n{"type":"table","title":"Flights","columns":[],"rows":[]}\n${fence}\nAnd a form:\n${fence}artifact\n{"type":"form","fields":[]}\n${fence}`;
    expect(withoutArtifacts(text)).toBe('Two options:\n[Flights]\nAnd a form:\n[form]');
    expect(withoutArtifacts(`Broken\n${fence}artifact\n{oops`)).toBe('Broken\n[…]');
    const list = conversationList({ a: record(1, [{ id: 'm1', kind: 'ask', prompt: 'q', text }]) });
    expect(list[0]!.turns[0]!.text).not.toContain('"type"');
  });
});
