/** Watched pages as the phone shows them: what to watch, and what the computers last saw. */
import { isSyncedWatch, parseDeviceWatchStatus, type DeviceInfo, type SyncedWatch, type WatchStatus } from '@corvus/shared';

export interface WatchView extends SyncedWatch {
  /** The most recent check by any computer of the chain; absent until one has checked it. */
  status?: WatchStatus & { device: string };
}

/** How often the phone offers to check a page, in minutes. */
export const INTERVAL_CHOICES: readonly number[] = [15, 60, 360, 1440];
export const CONDITION_CHARS = 300;

export function describeInterval(minutes: number): string {
  if (minutes < 60) return `every ${minutes} min`;
  if (minutes === 60) return 'every hour';
  if (minutes < 1440) return `every ${Math.round(minutes / 60)} hours`;
  return minutes === 1440 ? 'every day' : `every ${Math.round(minutes / 1440)} days`;
}

/**
 * Each watch with the freshest status any computer published for it, the most recently changed
 * first. Status from devices that left the chain is ignored once the device list is known.
 */
export function watchList(
  watchRecords: Record<string, unknown>,
  statusRecords: Record<string, unknown>,
  devices: readonly DeviceInfo[],
): WatchView[] {
  const known = new Set(devices.map((d) => d.id));
  const best = new Map<string, WatchStatus & { device: string }>();
  for (const [deviceId, raw] of Object.entries(statusRecords)) {
    if (devices.length > 0 && !known.has(deviceId)) continue;
    const record = parseDeviceWatchStatus(raw);
    if (!record) continue;
    for (const s of record.watches) {
      const current = best.get(s.url);
      if (!current || (s.lastCheckedAt ?? 0) > (current.lastCheckedAt ?? 0)) best.set(s.url, { ...s, device: record.device });
    }
  }
  const out: WatchView[] = [];
  for (const [url, raw] of Object.entries(watchRecords)) {
    if (!isSyncedWatch(raw)) continue;
    const status = best.get(url);
    out.push({ ...raw, url, ...(status ? { status } : {}) });
  }
  return out.sort((a, b) => (b.status?.lastChangedAt ?? 0) - (a.status?.lastChangedAt ?? 0) || a.title.localeCompare(b.title));
}

/** A watch made on the phone, or an existing one with a new interval and condition. */
export function watchFor(url: string, title: string, intervalMinutes: number, condition: string, now: number, existing?: SyncedWatch): SyncedWatch {
  const cleaned = condition.replace(/\s+/g, ' ').trim().slice(0, CONDITION_CHARS);
  const base = existing ?? { url, title, paused: false, createdAt: now, intervalMinutes };
  const { condition: _previous, ...rest } = base;
  return { ...rest, url, title: title || base.title, intervalMinutes, paused: false, ...(cleaned ? { condition: cleaned } : {}) };
}

/** Watches whose page changed in the last day (for the home screen). */
export function changedRecently(watches: readonly WatchView[], now: number = Date.now()): number {
  return watches.filter((w) => w.status?.lastChangedAt && now - w.status.lastChangedAt < 86_400_000).length;
}
