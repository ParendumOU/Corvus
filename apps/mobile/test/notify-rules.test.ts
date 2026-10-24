import type { SentTabRecord } from '@corvus/shared';
import { describe, expect, it } from 'vitest';

import { pendingNotifications } from '../src/lib/notify-rules';
import { inbox } from '../src/lib/send';
import type { WatchView } from '../src/lib/watches';

const PHONE = 'phone-0000000001';
const DESK = 'desk-00000000001';
const page = (id: string, url: string, to = PHONE): SentTabRecord => ({ id, url, title: '', to, fromId: DESK, from: 'Desk', sentAt: 1 });
const watch = (url: string, changed: number | null, summary = ''): WatchView => ({
  url,
  title: 'Shop',
  paused: false,
  createdAt: 1,
  intervalMinutes: 60,
  status: { url, lastCheckedAt: changed, lastChangedAt: changed, result: 'changed', summary, device: 'Desk' },
});

describe('notifications', () => {
  it('lists the pages sent to this phone, not the ones it sent', () => {
    const records = {
      'sent-0001': { url: 'https://a.example/', title: 'A', to: PHONE, fromId: DESK, from: 'Desk', sentAt: 2 },
      'sent-0002': { url: 'https://b.example/', title: 'B', to: DESK, fromId: PHONE, from: 'Pixel', sentAt: 1 },
    };
    expect(inbox(records, PHONE).map((p) => p.url)).toEqual(['https://a.example/']);
    expect(inbox(records, null)).toEqual([]);
  });

  it('counts everything as seen the first time, so turning them on never floods', () => {
    const first = pendingNotifications([page('p1', 'https://a.example/')], [watch('https://shop.example/', 100)], null);
    expect(first.notes).toEqual([]);
    expect(first.seen).toEqual({ sent: ['p1'], watches: { 'https://shop.example/': 100 } });
  });

  it('notifies new pages and new changes once', () => {
    const seen = { sent: ['p1'], watches: { 'https://shop.example/': 100 } };
    const next = pendingNotifications(
      [page('p1', 'https://a.example/'), page('p2', 'https://b.example/')],
      [watch('https://shop.example/', 200, 'The price dropped to 89'), watch('https://new.example/', 150)],
      seen,
    );
    expect(next.notes).toEqual([
      { id: 'sent-p2', kind: 'sent', title: 'From Desk', body: 'https://b.example/', url: 'https://b.example/' },
      { id: 'watch-https://shop.example/', kind: 'watch', title: 'Shop changed', body: 'The price dropped to 89', url: 'https://shop.example/' },
    ]);
    // A watch seen for the first time only sets where it starts; opened pages leave the list.
    expect(next.seen).toEqual({ sent: ['p1', 'p2'], watches: { 'https://shop.example/': 200, 'https://new.example/': 150 } });
    expect(pendingNotifications([page('p2', 'https://b.example/')], [watch('https://shop.example/', 200)], next.seen).notes).toEqual([]);
  });
});
