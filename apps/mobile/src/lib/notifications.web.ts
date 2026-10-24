/** The web build (automated checks only) has no notifications: everything here does nothing. */
import type { ChainView } from '@/lib/session';

export interface NotificationTap {
  kind: 'sent' | 'watch';
  url: string;
  recordId?: string;
}

export async function notificationsOn(): Promise<boolean> {
  return false;
}

export async function setNotificationsOn(_on: boolean): Promise<boolean> {
  return false;
}

export async function notifyNew(_view: Pick<ChainView, 'inbox' | 'watches'>, _show: boolean): Promise<void> {}

export function onNotificationTap(_onTap: (tap: NotificationTap) => void): () => void {
  return () => undefined;
}
