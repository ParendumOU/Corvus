/** Sending a page from the phone to one of the user's computers (sync collection `sent_tabs`). */
import { sentTabs, type DeviceInfo, type SentTabRecord } from '@corvus/shared';

import type { ComputerTabs } from './replica';

/** Platforms of devices that cannot open a sent page (yet): phones and the app's web build. */
const PHONE_PLATFORMS = new Set(['android', 'ios', 'web']);

/**
 * The computers on the chain a page can go to, the likeliest first: the one whose tabs changed
 * last (the one in use), then by when each was last seen.
 */
export function sendTargets(devices: readonly DeviceInfo[], self: string | null, computers: readonly ComputerTabs[]): DeviceInfo[] {
  const active = new Map(computers.map((c) => [c.deviceId, c.updatedAt]));
  return devices
    .filter((d) => d.id !== self && !PHONE_PLATFORMS.has(d.platform))
    .sort((a, b) => (active.get(b.id) ?? 0) - (active.get(a.id) ?? 0) || b.lastSeen - a.lastSeen);
}

/** Pages this phone sent that their computer has not opened yet, oldest first. */
export function outbox(records: Record<string, unknown>, self: string | null): SentTabRecord[] {
  return self ? sentTabs(records, (t) => t.fromId === self) : [];
}

/** The text shared from another app: a link alone, or a sentence with a link in it. */
export function sharedText(payloads: ReadonlyArray<{ value: string; shareType: string }>): string {
  return payloads.find((p) => p.shareType === 'url')?.value ?? payloads.find((p) => p.shareType === 'text')?.value ?? '';
}
