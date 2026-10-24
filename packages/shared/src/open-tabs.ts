/**
 * Open tabs published by each device (sync collection `open_tabs`, one record per device, keyed
 * by the device id). The desktop publishes its own and shows the others; the mobile app reads them.
 */
import { GROUP_COLORS, type GroupColor } from "./browser.js";

export interface SyncedTab {
  url: string;
  title: string;
  pinned: boolean;
  group?: { title: string; color: GroupColor };
}

export interface DeviceTabs {
  device: string;
  platform: string;
  /** When this device's tab set last changed (not when it was last published). */
  updatedAt: number;
  tabs: SyncedTab[];
}

export const MAX_SYNCED_TABS = 500;
export const MAX_TAB_URL = 2048;
export const MAX_TAB_TITLE = 300;

/** Only web pages are worth reopening elsewhere; internal, file: and about: URLs are device-specific. */
export function isSyncableTabUrl(url: string): boolean {
  return /^https?:\/\//i.test(url) && url.length <= MAX_TAB_URL;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Validate a record received from another device; invalid tabs are dropped, an invalid record is null. */
export function parseDeviceTabs(raw: unknown): DeviceTabs | null {
  if (!isObject(raw) || typeof raw.device !== "string" || typeof raw.updatedAt !== "number" || !Array.isArray(raw.tabs)) return null;
  const tabs: SyncedTab[] = [];
  for (const t of raw.tabs.slice(0, MAX_SYNCED_TABS)) {
    if (!isObject(t) || typeof t.url !== "string" || !isSyncableTabUrl(t.url)) continue;
    const g = t.group;
    const group =
      isObject(g) && typeof g.title === "string" && (GROUP_COLORS as readonly unknown[]).includes(g.color)
        ? { title: g.title.slice(0, 80), color: g.color as GroupColor }
        : undefined;
    tabs.push({
      url: t.url,
      title: typeof t.title === "string" ? t.title.slice(0, MAX_TAB_TITLE) : "",
      pinned: t.pinned === true,
      ...(group ? { group } : {}),
    });
  }
  return {
    device: raw.device.slice(0, 64),
    platform: typeof raw.platform === "string" ? raw.platform.slice(0, 32) : "",
    updatedAt: raw.updatedAt,
    tabs,
  };
}
