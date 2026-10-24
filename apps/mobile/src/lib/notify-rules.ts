/**
 * What the phone notifies about: pages a computer sent to it, and watched pages that changed. Pure,
 * so the rules are unit tested; lib/notifications.ts shows them (native only).
 */
import type { SentTabRecord } from '@corvus/shared';

import type { WatchView } from '@/lib/watches';
import { t } from './i18n';

/** What was already notified (or seen in the app), kept between background checks. */
export interface NotifySeen {
  /** Sent pages, by record id. */
  sent: string[];
  /** Watched pages, by URL: the last change already notified. */
  watches: Record<string, number>;
}

export interface PhoneNotification {
  id: string;
  kind: 'sent' | 'watch';
  title: string;
  body: string;
  url: string;
}

/**
 * The notifications for what is new since `seen`, and what is seen afterwards. The first time
 * (no `seen` yet) everything there is counts as seen, so turning notifications on never floods.
 */
export function pendingNotifications(
  inbox: readonly SentTabRecord[],
  watches: readonly WatchView[],
  seen: NotifySeen | null,
): { notes: PhoneNotification[]; seen: NotifySeen } {
  const notes: PhoneNotification[] = [];
  const known = new Set(seen?.sent ?? []);
  for (const page of inbox) {
    if (seen && !known.has(page.id)) {
      notes.push({ id: `sent-${page.id}`, kind: 'sent', title: t('From {device}', { device: page.from || t('your computer') }), body: page.title || page.url, url: page.url });
    }
  }
  const watchSeen: Record<string, number> = {};
  for (const w of watches) {
    const changed = w.status?.lastChangedAt ?? 0;
    const before = seen?.watches[w.url];
    watchSeen[w.url] = Math.max(changed, before ?? 0);
    if (seen && before !== undefined && changed > before) {
      notes.push({ id: `watch-${w.url}`, kind: 'watch', title: t('{page} changed', { page: w.title || w.url }), body: w.status?.summary || w.url, url: w.url });
    }
  }
  return { notes, seen: { sent: inbox.map((p) => p.id), watches: watchSeen } };
}
