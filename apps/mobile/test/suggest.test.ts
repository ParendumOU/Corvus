import type { Bookmark } from '@corvus/shared';
import { describe, expect, it } from 'vitest';

import { suggest } from '../src/lib/suggest';

const bookmark = (url: string, title: string): Bookmark => ({ id: url, parentId: 'other', kind: 'bookmark', url, title, position: 0, createdAt: 0, updatedAt: 0 });
const visit = (url: string, title: string, visitCount = 1, visitedAt = 0) => ({ url, title, visitCount, visitedAt });

describe('address bar suggestions', () => {
  const sources = {
    tabs: [{ id: 't1', url: 'https://news.example.com/today', title: 'Today’s news' }],
    bookmarks: [bookmark('https://en.wikipedia.org/wiki/Crow', 'Crow - Wikipedia'), { ...bookmark('', 'Folder'), kind: 'folder' as const, url: undefined }],
    history: [visit('https://www.example.com/', 'Example', 3, 1), visit('https://en.wikipedia.org/wiki/Crow', 'Crow', 9, 2), visit('https://crow.example.org/', 'Crow facts', 1, 3), visit('javascript:alert(1)', 'crow')],
  };

  it('finds pages with every word typed, address matches first, one row per page', () => {
    const rows = suggest('crow', sources);
    expect(rows.map((r) => [r.kind, r.url])).toEqual([
      ['history', 'https://crow.example.org/'],
      ['bookmark', 'https://en.wikipedia.org/wiki/Crow'],
    ]);
    expect(suggest('wikipedia crow', sources).map((r) => r.kind)).toEqual(['bookmark']);
  });

  it('offers to switch to a tab already open', () => {
    expect(suggest('news', sources)).toEqual([{ kind: 'tab', url: 'https://news.example.com/today', title: 'Today’s news', tabId: 't1' }]);
  });

  it('matches what people type before an address', () => {
    expect(suggest('example.com', sources)[0]!.url).toBe('https://www.example.com/');
    expect(suggest('https://www.exa', sources)[0]!.url).toBe('https://www.example.com/');
  });

  it('suggests nothing for nothing, and at most the number asked', () => {
    expect(suggest('  ', sources)).toEqual([]);
    expect(suggest('e', sources, 2)).toHaveLength(2);
  });
});
