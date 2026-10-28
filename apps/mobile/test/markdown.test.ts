import { describe, expect, it } from 'vitest';

import { markdownBlocks, markdownInline } from '../src/lib/markdown';

describe('answers in Markdown', () => {
  it('splits an answer into headings, paragraphs, lists, quotes and code', () => {
    const md = ['## Best viewpoints', '', 'Lisbon has many:', 'more on one line', '', '- Senhora do Monte', '- Santa Catarina', '  wraps here', '', '3. third', '4. fourth', '', '> a quote', '', '```', 'code()', '```'].join('\n');
    expect(markdownBlocks(md)).toEqual([
      { kind: 'heading', text: 'Best viewpoints' },
      { kind: 'paragraph', text: 'Lisbon has many:\nmore on one line' },
      { kind: 'list', ordered: false, start: 1, items: ['Senhora do Monte', 'Santa Catarina wraps here'] },
      { kind: 'list', ordered: true, start: 3, items: ['third', 'fourth'] },
      { kind: 'quote', text: 'a quote' },
      { kind: 'code', text: 'code()' },
    ]);
    expect(markdownBlocks('')).toEqual([]);
    // Still being written: an unclosed code block holds what came so far.
    expect(markdownBlocks('```\nhalf')).toEqual([{ kind: 'code', text: 'half' }]);
  });

  it('marks bold, italics, code, links and citations of the sources it has', () => {
    expect(markdownInline('**Ravens** live *long*, see `x` and [MDN](https://developer.mozilla.org/) [1][3].', 2)).toEqual([
      { kind: 'bold', text: 'Ravens' },
      { kind: 'text', text: ' live ' },
      { kind: 'italic', text: 'long' },
      { kind: 'text', text: ', see ' },
      { kind: 'code', text: 'x' },
      { kind: 'text', text: ' and ' },
      { kind: 'link', text: 'MDN', url: 'https://developer.mozilla.org/' },
      { kind: 'text', text: ' ' },
      { kind: 'cite', n: 1 },
      { kind: 'text', text: '[3].' },
    ]);
    expect(markdownInline('2 * 3 * 4 and a **half', 0)).toEqual([{ kind: 'text', text: '2 * 3 * 4 and a **half' }]);
    expect(markdownInline('[link](javascript:alert(1))', 0)).toEqual([{ kind: 'text', text: '[link](javascript:alert(1))' }]);
  });
});
