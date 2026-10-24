/** Open tabs published by each device (sync collection `open_tabs`, one record per device). */
import { MAX_SYNCED_TABS, MAX_TAB_TITLE, isSyncableTabUrl, type DeviceTabs, type SyncedTab, type Tab, type TabGroup } from "@corvus/shared";

export { MAX_SYNCED_TABS, isSyncableTabUrl, parseDeviceTabs, type DeviceTabs, type SyncedTab } from "@corvus/shared";

/** A remote device's tabs as shown in corvus://history. */
export interface RemoteDeviceTabs extends DeviceTabs {
  deviceId: string;
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
        title: tab.title.slice(0, MAX_TAB_TITLE),
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
