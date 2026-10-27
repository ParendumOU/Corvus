/**
 * The background check behind notifications: about every 15 minutes, when the system allows it
 * (Android's WorkManager, iOS's background tasks decide the exact moment), the phone pulls the
 * chain and notifies what is new. Defined when the app loads, as the system requires.
 */
import * as BackgroundTask from 'expo-background-task';
import * as TaskManager from 'expo-task-manager';

import { notificationsOn, notifyNew, setNotificationsOn } from '@/lib/notifications';
import { watchdog } from '@/lib/refresh';
import { loadPairing, refreshView } from '@/lib/session';

const REFRESH_TASK = 'corvus-refresh';

TaskManager.defineTask(REFRESH_TASK, async () => {
  try {
    const pairing = await loadPairing();
    if (pairing && (await notificationsOn())) await notifyNew(await watchdog((progress) => refreshView(pairing, progress)), true);
    return BackgroundTask.BackgroundTaskResult.Success;
  } catch {
    return BackgroundTask.BackgroundTaskResult.Failed;
  }
});

/** Turns notifications and their background check on or off; returns whether they are on. */
export async function enableNotifications(on: boolean): Promise<boolean> {
  const enabled = await setNotificationsOn(on);
  const registered = await TaskManager.isTaskRegisteredAsync(REFRESH_TASK);
  if (enabled && !registered) await BackgroundTask.registerTaskAsync(REFRESH_TASK, { minimumInterval: 15 });
  if (!enabled && registered) await BackgroundTask.unregisterTaskAsync(REFRESH_TASK);
  return enabled;
}
