/** Open tabs published by each device (sync collection `open_tabs`, one record per device). */
import type { GroupColor, Tab, TabGroup } from "@corvus/shared";
import { GROUP_COLORS } from "./tab-strip";

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

/** A remote device's tabs as shown in corvus://history. */
export interface RemoteDeviceTabs extends DeviceTabs {
  deviceId: string;
}

export const MAX_SYNCED_TABS = 500;
const MAX_URL = 2048;
const MAX_TITLE = 300;

/** Only web pages are worth reopening elsewhere; internal, file: and about: URLs are device-specific. */
export function isSyncableTabUrl(url: string): boolean {
  return /^https?:\/\//i.test(url) && url.length <= MAX_URL;
}

export function collectTabs(windows: Array<{ tabs: Tab[]; groups: TabGroup[] }>): SyncedTab[] {
  const out: SyncedTab[] = [];
  for (const { tabs, groups } of windows) {
    const byId = new Map(groups.map((g) => [g.id, g]));
    for (const tab of tabs) {
      if (!isSyncableTabUrl(tab.url)) continue;
      const group = tab.groupId ? byId.get(tab.groupId) : undefined;
      out.push({
        url: tab.url,
        title: tab.title.slice(0, MAX_TITLE),
        pinned: tab.pinned,
        ...(group ? { group: { title: group.title.slice(0, 80), color: group.color } } : {}),
      });
      if (out.length >= MAX_SYNCED_TABS) return out;
    }
  }
  return out;
}

function sameContent(a: Omit<DeviceTabs, "updatedAt">, b: Omit<DeviceTabs, "updatedAt">): boolean {
  return a.device === b.device && a.platform === b.platform && JSON.stringify(a.tabs) === JSON.stringify(b.tabs);
}

/**
 * Keeps this device's published record. `updatedAt` only moves when the tab set changes, so an
 * unchanged browser never produces a new record (the sync engine diffs by payload fingerprint).
 */
export class OpenTabsPublisher {
  private current: DeviceTabs | null = null;

  constructor(
    private readonly source: () => Omit<DeviceTabs, "updatedAt">,
    private readonly now: () => number = Date.now,
  ) {}

  /** Re-read the open tabs; returns true when the published record changed. */
  refresh(): boolean {
    const next = this.source();
    if (this.current && sameContent(this.current, next)) return false;
    this.current = { ...next, updatedAt: this.now() };
    return true;
  }

  record(): DeviceTabs {
    if (!this.current) this.refresh();
    return this.current as DeviceTabs;
  }
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
      title: typeof t.title === "string" ? t.title.slice(0, MAX_TITLE) : "",
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
