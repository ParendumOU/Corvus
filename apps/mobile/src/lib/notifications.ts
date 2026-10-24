/**
 * Local notifications (no push service: the phone itself checks the sync chain). Off until the
 * person turns them on in Settings, which asks the system's permission.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

import { pendingNotifications, type NotifySeen } from '@/lib/notify-rules';
import type { ChainView } from '@/lib/session';

const ENABLED_KEY = 'corvus.notify';
const SEEN_KEY = 'corvus.notify.seen';
const CHANNEL = 'corvus';

/** What a tapped notification is about. */
export interface NotificationTap {
  kind: 'sent' | 'watch';
  url: string;
  /** The sent page's record id. */
  recordId?: string;
}

Notifications.setNotificationHandler({
  handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: false, shouldSetBadge: false }),
});

export async function notificationsOn(): Promise<boolean> {
  return (await AsyncStorage.getItem(ENABLED_KEY)) === '1';
}

/** Turns notifications on (asking the system first) or off; returns whether they are on now. */
export async function setNotificationsOn(on: boolean): Promise<boolean> {
  if (on) {
    if (Platform.OS === 'android') {
      await Notifications.setNotificationChannelAsync(CHANNEL, { name: 'Corvus', importance: Notifications.AndroidImportance.DEFAULT });
    }
    const current = await Notifications.getPermissionsAsync();
    const granted = current.granted || (await Notifications.requestPermissionsAsync()).granted;
    if (!granted) return false;
  }
  await AsyncStorage.setItem(ENABLED_KEY, on ? '1' : '0');
  return on;
}

/**
 * Notifies about pages sent to this phone and watched pages that changed since the last check.
 * With `show` false (the app is open and shows them anyway) they only count as seen.
 */
export async function notifyNew(view: Pick<ChainView, 'inbox' | 'watches'>, show: boolean): Promise<void> {
  let seen: NotifySeen | null = null;
  try {
    seen = JSON.parse((await AsyncStorage.getItem(SEEN_KEY)) ?? 'null') as NotifySeen | null;
  } catch {
    seen = null;
  }
  const next = pendingNotifications(view.inbox, view.watches, seen);
  await AsyncStorage.setItem(SEEN_KEY, JSON.stringify(next.seen));
  if (!show || !(await notificationsOn())) return;
  for (const note of next.notes) {
    const data: NotificationTap = { kind: note.kind, url: note.url, ...(note.kind === 'sent' ? { recordId: note.id.slice('sent-'.length) } : {}) };
    await Notifications.scheduleNotificationAsync({
      identifier: note.id,
      content: { title: note.title, body: note.body, data: { ...data } },
      trigger: Platform.OS === 'android' ? { channelId: CHANNEL } : null,
    });
  }
}

/** Calls `onTap` for each notification the person taps (also the one that opened the app). */
export function onNotificationTap(onTap: (tap: NotificationTap) => void): () => void {
  const handle = (response: Notifications.NotificationResponse | null): void => {
    const data = response?.notification.request.content.data as Partial<NotificationTap> | undefined;
    if (data && (data.kind === 'sent' || data.kind === 'watch') && typeof data.url === 'string') {
      onTap({ kind: data.kind, url: data.url, ...(typeof data.recordId === 'string' ? { recordId: data.recordId } : {}) });
    }
  };
  void Notifications.getLastNotificationResponseAsync().then((r) => {
    handle(r);
    if (r) void Notifications.clearLastNotificationResponseAsync();
  });
  const subscription = Notifications.addNotificationResponseReceivedListener(handle);
  return () => subscription.remove();
}
