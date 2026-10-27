/**
 * The records of the public demo sync chain (repository corvus-sync-demo, seeder/demo-data.mjs), as
 * its two demo computers write them: open tabs with pins and groups, watched pages and their status,
 * bookmarks in folders under the bar and "Other bookmarks", a reading list, six days of history, two
 * Corvus Assist conversations, and the two pages the laptop sends to each phone that pairs. Every
 * time is relative to `now`, as on the demo server.
 */
import type { SyncItem } from '@corvus/shared';

export const LAPTOP = { id: 'a1b2c3d4e5f60718293a4b5c6d7e8f90', name: 'Demo laptop', platform: 'win32' };
export const DESKTOP = { id: '0f1e2d3c4b5a69788796a5b4c3d2e1f0', name: 'Work desktop', platform: 'darwin' };

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const item = (collection: SyncItem['collection'], id: string, payload: unknown): SyncItem => ({ collection, id, payload, deleted: false });

const LISBON = { title: 'Lisbon trip', color: 'blue' };
const WEBDEV = { title: 'Web dev', color: 'purple' };
const RELEASE = { title: 'Release', color: 'orange' };

const LAPTOP_TABS = [
  { url: 'https://en.wikipedia.org/wiki/Main_Page', title: 'Wikipedia, the free encyclopedia', pinned: true },
  { url: 'https://github.com/ParendumOU/Corvus', title: 'GitHub - ParendumOU/Corvus: AI-native desktop browser', pinned: true },
  { url: 'https://en.wikivoyage.org/wiki/Lisbon', title: 'Lisbon – Travel guide at Wikivoyage', pinned: false, group: LISBON },
  { url: 'https://en.wikivoyage.org/wiki/Sintra', title: 'Sintra – Travel guide at Wikivoyage', pinned: false, group: LISBON },
  { url: 'https://www.bbc.com/weather/2267057', title: 'Lisbon - BBC Weather', pinned: false, group: LISBON },
  { url: 'https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array/map', title: 'Array.prototype.map() - JavaScript | MDN', pinned: false, group: WEBDEV },
  { url: 'https://developer.mozilla.org/en-US/docs/Web/CSS/CSS_grid_layout', title: 'CSS grid layout - CSS | MDN', pinned: false, group: WEBDEV },
  { url: 'https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API', title: 'Fetch API - Web APIs | MDN', pinned: false, group: WEBDEV },
  { url: 'https://www.bbc.com/news', title: 'BBC News - Breaking news, video and the latest top stories', pinned: false },
  { url: 'https://www.bbcgoodfood.com/recipes/easy-pancakes', title: 'Easy pancakes recipe | Good Food', pinned: false },
  { url: 'https://www.openstreetmap.org/#map=13/38.7223/-9.1393', title: 'OpenStreetMap', pinned: false },
];

const DESKTOP_TABS = [
  { url: 'https://news.ycombinator.com/', title: 'Hacker News', pinned: true },
  { url: 'https://www.postgresql.org/docs/current/', title: 'PostgreSQL: Documentation', pinned: false },
  { url: 'https://docs.docker.com/compose/', title: 'Docker Compose | Docker Docs', pinned: false, group: RELEASE },
  { url: 'https://semver.org/', title: 'Semantic Versioning 2.0.0 | Semantic Versioning', pinned: false, group: RELEASE },
  { url: 'https://12factor.net/', title: 'The Twelve-Factor App', pinned: false },
];

const WATCHES = [
  {
    url: 'https://www.python.org/downloads/',
    title: 'Download Python | Python.org',
    intervalMinutes: 1440,
    condition: 'a new Python 3 release is out',
    createdDaysAgo: 21,
    status: (now: number) => ({ lastCheckedAt: now - 7 * MIN, lastChangedAt: now - 3 * HOUR, result: 'changed', summary: 'A newer Python 3 release now heads the downloads page.', conditionMet: true, conditionDetail: 'The download button shows a new version' }),
  },
  {
    url: 'https://en.wikivoyage.org/wiki/Lisbon',
    title: 'Lisbon – Travel guide at Wikivoyage',
    intervalMinutes: 360,
    createdDaysAgo: 9,
    status: (now: number) => ({ lastCheckedAt: now - 18 * MIN, lastChangedAt: now - 6 * HOUR, result: 'changed', summary: 'The Get around section has new notes on the metro and on tram 28.' }),
  },
  {
    url: 'https://www.bbc.com/weather/2267057',
    title: 'Lisbon - BBC Weather',
    intervalMinutes: 60,
    condition: 'rain is forecast for the weekend',
    createdDaysAgo: 4,
    status: (now: number) => ({ lastCheckedAt: now - 24 * MIN, lastChangedAt: now - 2 * DAY, result: 'ok', summary: 'The forecast now shows sunny spells for the next few days.', conditionMet: false, conditionDetail: 'Weekend: dry' }),
  },
];

/** [id, parent, kind, title, url] */
const BOOKMARKS: [string, string, 'bookmark' | 'folder', string, string?][] = [
  ['demo-bm-wikipedia', 'bar', 'bookmark', 'Wikipedia', 'https://www.wikipedia.org/'],
  ['demo-bm-mdn', 'bar', 'bookmark', 'MDN Web Docs', 'https://developer.mozilla.org/en-US/'],
  ['demo-folder-travel', 'bar', 'folder', 'Travel'],
  ['demo-folder-recipes', 'bar', 'folder', 'Recipes'],
  ['demo-folder-dev', 'bar', 'folder', 'Developer docs'],
  ['demo-bm-wv-lisbon', 'demo-folder-travel', 'bookmark', 'Lisbon – Wikivoyage', 'https://en.wikivoyage.org/wiki/Lisbon'],
  ['demo-bm-wv-porto', 'demo-folder-travel', 'bookmark', 'Porto – Wikivoyage', 'https://en.wikivoyage.org/wiki/Porto'],
  ['demo-bm-metro', 'demo-folder-travel', 'bookmark', 'Metropolitano de Lisboa', 'https://www.metrolisboa.pt/en/'],
  ['demo-bm-belem', 'demo-folder-travel', 'bookmark', 'Belém Tower - Wikipedia', 'https://en.wikipedia.org/wiki/Bel%C3%A9m_Tower'],
  ['demo-bm-osm', 'demo-folder-travel', 'bookmark', 'OpenStreetMap', 'https://www.openstreetmap.org/'],
  ['demo-bm-pancakes', 'demo-folder-recipes', 'bookmark', 'Easy pancakes recipe | Good Food', 'https://www.bbcgoodfood.com/recipes/easy-pancakes'],
  ['demo-bm-shakshouka', 'demo-folder-recipes', 'bookmark', 'Shakshouka - Wikipedia', 'https://en.wikipedia.org/wiki/Shakshouka'],
  ['demo-bm-gazpacho', 'demo-folder-recipes', 'bookmark', 'Gazpacho - Wikipedia', 'https://en.wikipedia.org/wiki/Gazpacho'],
  ['demo-bm-nata', 'demo-folder-recipes', 'bookmark', 'Pastel de nata - Wikipedia', 'https://en.wikipedia.org/wiki/Pastel_de_nata'],
  ['demo-bm-js', 'demo-folder-dev', 'bookmark', 'JavaScript | MDN', 'https://developer.mozilla.org/en-US/docs/Web/JavaScript'],
  ['demo-bm-node', 'demo-folder-dev', 'bookmark', 'Node.js Documentation', 'https://nodejs.org/docs/latest/api/'],
  ['demo-bm-ts', 'demo-folder-dev', 'bookmark', 'TypeScript: Handbook', 'https://www.typescriptlang.org/docs/handbook/intro.html'],
  ['demo-bm-docker', 'demo-folder-dev', 'bookmark', 'Docker Docs', 'https://docs.docker.com/'],
  ['demo-bm-git', 'demo-folder-dev', 'bookmark', 'Git - Documentation', 'https://git-scm.com/doc'],
  ['demo-bm-archive', 'other', 'bookmark', 'Internet Archive', 'https://archive.org/'],
  ['demo-bm-hn', 'other', 'bookmark', 'Hacker News', 'https://news.ycombinator.com/'],
];

const READING = [
  { id: 'demo-read-raven', url: 'https://en.wikipedia.org/wiki/Common_raven', title: 'Common raven', siteName: 'Wikipedia', savedAgo: 2 * HOUR, wordCount: 4100, excerpt: 'The common raven is a large all-black bird of the crow family.', keyPoints: ['One of the largest songbirds', 'Lives in pairs', 'Known for problem solving and play'] },
  { id: 'demo-read-trams', url: 'https://en.wikipedia.org/wiki/Trams_in_Lisbon', title: 'Trams in Lisbon', siteName: 'Wikipedia', savedAgo: 26 * HOUR, wordCount: 2300, excerpt: "Lisbon's trams climb some of the steepest streets of any city tram network.", keyPoints: ['Electric since 1901', 'Line 28 crosses the old quarters'] },
  { id: 'demo-read-e2ee', url: 'https://en.wikipedia.org/wiki/End-to-end_encryption', title: 'End-to-end encryption', siteName: 'Wikipedia', savedAgo: 3 * DAY, wordCount: 1800, excerpt: 'Only the communicating devices can read the data.', keyPoints: ['Keys stay on the devices'] },
  { id: 'demo-read-12factor', url: 'https://12factor.net/', title: 'The Twelve-Factor App', siteName: '12factor.net', savedAgo: 5 * DAY, readAgo: 4 * DAY, wordCount: 2600, excerpt: 'A methodology for building software-as-a-service apps.', keyPoints: ['Config in the environment'] },
  { id: 'demo-read-sourdough', url: 'https://en.wikipedia.org/wiki/Sourdough', title: 'Sourdough', siteName: 'Wikipedia', savedAgo: 6 * DAY, readAgo: 6 * DAY - 3 * HOUR, wordCount: 1500, excerpt: 'Sourdough bread rises with a starter of wild yeasts.', keyPoints: ['A starter of flour and water'] },
];

/** [url, title, how long ago, visits] */
const HISTORY: [string, string, number, number][] = [
  ['https://en.wikivoyage.org/wiki/Lisbon', 'Lisbon – Travel guide at Wikivoyage', 6 * MIN, 4],
  ['https://www.bbc.com/weather/2267057', 'Lisbon - BBC Weather', 14 * MIN, 6],
  ['https://en.wikivoyage.org/wiki/Sintra', 'Sintra – Travel guide at Wikivoyage', 22 * MIN, 2],
  ['https://en.wikipedia.org/wiki/Pastel_de_nata', 'Pastel de nata - Wikipedia', 35 * MIN, 1],
  ['https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API', 'Fetch API - Web APIs | MDN', 58 * MIN, 3],
  ['https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array/map', 'Array.prototype.map() - JavaScript | MDN', 70 * MIN, 5],
  ['https://developer.mozilla.org/en-US/docs/Web/CSS/CSS_grid_layout', 'CSS grid layout - CSS | MDN', 85 * MIN, 2],
  ['https://www.bbc.com/news', 'BBC News - Breaking news, video and the latest top stories', 2 * HOUR, 9],
  ['https://en.wikipedia.org/wiki/Common_raven', 'Common raven - Wikipedia', 2 * HOUR + 10 * MIN, 1],
  ['https://github.com/ParendumOU/Corvus', 'GitHub - ParendumOU/Corvus: AI-native desktop browser', 3 * HOUR, 7],
  ['https://www.bbcgoodfood.com/recipes/easy-pancakes', 'Easy pancakes recipe | Good Food', 4 * HOUR, 2],
  ['https://news.ycombinator.com/', 'Hacker News', 5 * HOUR, 12],
  ['https://en.wikipedia.org/wiki/Trams_in_Lisbon', 'Trams in Lisbon - Wikipedia', 26 * HOUR, 1],
  ['https://www.metrolisboa.pt/en/', 'Metropolitano de Lisboa, EPE - English', 27 * HOUR, 2],
  ['https://en.wikivoyage.org/wiki/Porto', 'Porto – Travel guide at Wikivoyage', 28 * HOUR, 1],
  ['https://en.wikipedia.org/wiki/Bel%C3%A9m_Tower', 'Belém Tower - Wikipedia', 29 * HOUR, 1],
  ['https://www.openstreetmap.org/#map=13/38.7223/-9.1393', 'OpenStreetMap', 30 * HOUR, 3],
  ['https://docs.docker.com/compose/', 'Docker Compose | Docker Docs', 31 * HOUR, 4],
  ['https://semver.org/', 'Semantic Versioning 2.0.0 | Semantic Versioning', 32 * HOUR, 1],
  ['https://www.postgresql.org/docs/current/', 'PostgreSQL: Documentation', 33 * HOUR, 3],
  ['https://en.wikipedia.org/wiki/End-to-end_encryption', 'End-to-end encryption - Wikipedia', 3 * DAY, 1],
  ['https://www.python.org/downloads/', 'Download Python | Python.org', 3 * DAY + 2 * HOUR, 2],
  ['https://en.wikipedia.org/wiki/Shakshouka', 'Shakshouka - Wikipedia', 3 * DAY + 4 * HOUR, 1],
  ['https://en.wikipedia.org/wiki/Gazpacho', 'Gazpacho - Wikipedia', 3 * DAY + 5 * HOUR, 1],
  ['https://nodejs.org/docs/latest/api/', 'Node.js Documentation', 4 * DAY, 3],
  ['https://www.typescriptlang.org/docs/handbook/intro.html', 'TypeScript: Handbook - The TypeScript Handbook', 4 * DAY + HOUR, 2],
  ['https://12factor.net/', 'The Twelve-Factor App', 5 * DAY, 2],
  ['https://en.wikipedia.org/wiki/Sourdough', 'Sourdough - Wikipedia', 6 * DAY, 1],
  ['https://archive.org/', 'Internet Archive: Digital Library of Free & Borrowable Texts, Movies, Music & Wayback Machine', 6 * DAY + 2 * HOUR, 1],
];

function openTabs(computer: typeof LAPTOP, tabs: unknown[], updatedAt: number): SyncItem {
  return item('open_tabs', computer.id, { device: computer.name, platform: computer.platform, updatedAt, tabs });
}

function conversations(now: number): SyncItem[] {
  return [
    item('assist_history', 'demo-assist-lisbon', {
      url: 'https://en.wikivoyage.org/wiki/Lisbon',
      pageTitle: 'Lisbon – Travel guide at Wikivoyage',
      createdAt: now - 50 * MIN,
      updatedAt: now - 44 * MIN,
      messages: [
        { id: 'demo-assist-lisbon-1', kind: 'ask', prompt: 'Which viewpoints in Lisbon are best at sunset?', text: "Lisbon's viewpoints (miradouros):\n\n- Senhora do Monte\n- São Pedro de Alcântara\n- Santa Catarina\n\nGet there early.", status: 'done' },
        { id: 'demo-assist-lisbon-2', kind: 'ask', prompt: 'How do I get to Sintra from the city centre?', text: 'Take the train from Rossio station: about 40 minutes.', status: 'done' },
      ],
    }),
    item('assist_history', 'demo-assist-raven', {
      url: 'https://en.wikipedia.org/wiki/Common_raven',
      pageTitle: 'Common raven - Wikipedia',
      createdAt: now - 2 * HOUR,
      updatedAt: now - 2 * HOUR,
      messages: [{ id: 'demo-assist-raven-1', kind: 'summarize', prompt: '', text: 'The common raven is a large, all-black member of the crow family.\n\n- It eats almost anything.', status: 'done' }],
    }),
  ];
}

/** The two pages the Demo laptop sends to a phone once it has paired. */
export function welcomePages(phoneId: string, now: number): SyncItem[] {
  return [
    { n: 1, url: 'https://en.wikipedia.org/wiki/Pastel_de_nata', title: 'Pastel de nata - Wikipedia', ago: 3 * MIN },
    { n: 2, url: 'https://en.wikivoyage.org/wiki/Sintra', title: 'Sintra – Travel guide at Wikivoyage', ago: 9 * MIN },
  ].map((w) => item('sent_tabs', `demo-sent-${phoneId.slice(0, 24)}-${w.n}`, { url: w.url, title: w.title, to: phoneId, fromId: LAPTOP.id, from: LAPTOP.name, sentAt: now - w.ago }));
}

/** The whole demo chain, by the computer that writes it. */
export function demoRecords(now: number): { laptop: SyncItem[]; desktop: SyncItem[] } {
  const positions = new Map<string, number>();
  const bookmarks = BOOKMARKS.map(([id, parentId, kind, title, url], i) => {
    const position = positions.get(parentId) ?? 0;
    positions.set(parentId, position + 1);
    const createdAt = now - (40 - i) * DAY;
    return item('bookmarks', id, { id, parentId, kind, title, ...(url ? { url } : {}), position, createdAt, updatedAt: createdAt });
  });
  const reading = READING.map((r) =>
    item('reading', r.url, {
      id: r.id,
      url: r.url,
      title: r.title,
      siteName: r.siteName,
      byline: '',
      excerpt: r.excerpt,
      markdown: `# ${r.title}\n\n${r.excerpt}\n`,
      keyPoints: r.keyPoints,
      wordCount: r.wordCount,
      readingMinutes: Math.max(1, Math.round(r.wordCount / 230)),
      savedAt: now - r.savedAgo,
      ...(r.readAgo !== undefined ? { readAt: now - r.readAgo } : {}),
    }),
  );
  const watches = WATCHES.map((w) => item('watches', w.url, { url: w.url, title: w.title, intervalMinutes: w.intervalMinutes, paused: false, createdAt: now - w.createdDaysAgo * DAY, ...(w.condition ? { condition: w.condition } : {}) }));
  const watchStatus = item('watch_status', LAPTOP.id, { device: LAPTOP.name, platform: LAPTOP.platform, updatedAt: now - 7 * MIN, watches: WATCHES.map((w) => ({ url: w.url, ...w.status(now) })) });
  const history = HISTORY.map(([url, title, ago, visitCount]) => item('history', url, { url, title, visitedAt: now - ago, visitCount }));
  return {
    laptop: [openTabs(LAPTOP, LAPTOP_TABS, now - 25 * MIN), watchStatus, ...watches, ...bookmarks, ...reading, ...history, ...conversations(now)],
    desktop: [openTabs(DESKTOP, DESKTOP_TABS, now - 3 * HOUR)],
  };
}
