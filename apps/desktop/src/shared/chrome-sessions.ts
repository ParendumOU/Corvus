import type { RemoteDeviceTabs } from "./open-tabs";

/**
 * chrome.sessions over Corvus: recently closed tabs (each window keeps its last 25) and the tabs
 * open on the person's other devices (from sync). Chrome's shapes; times in seconds, as Chrome
 * reports them. Pure, for the main process and the tests.
 */
export const MAX_SESSION_RESULTS = 25;

export interface ChromeSessionTab {
  id?: number;
  sessionId?: string;
  index: number;
  windowId: number;
  url: string;
  title: string;
  pinned: boolean;
  active: boolean;
  highlighted: boolean;
  incognito: boolean;
  groupId: number;
}

export interface ChromeSession {
  lastModified: number;
  tab?: ChromeSessionTab;
  window?: { sessionId: string; tabs: ChromeSessionTab[]; focused: boolean; incognito: boolean; alwaysOnTop: boolean };
}

export interface ChromeDevice {
  deviceName: string;
  sessions: ChromeSession[];
}

/** A closed tab as the window layer reports it. */
export interface ClosedTabEntry {
  sessionId: string;
  windowId: number;
  closedAt: number;
  url: string;
  title: string;
  index: number;
  pinned: boolean;
}

const seconds = (ms: number): number => Math.floor(ms / 1000);

const sessionTab = (t: { url: string; title: string; index: number; pinned: boolean }, windowId: number, sessionId: string): ChromeSessionTab => ({
  sessionId,
  index: t.index,
  windowId,
  url: t.url,
  title: t.title,
  pinned: t.pinned,
  active: false,
  highlighted: false,
  incognito: false,
  groupId: -1,
});

/** chrome.sessions.getRecentlyClosed(): newest first, at most maxResults (and 25). */
export function closedSessions(entries: readonly ClosedTabEntry[], maxResults?: number): ChromeSession[] {
  const max = Math.max(0, Math.min(MAX_SESSION_RESULTS, Math.floor(maxResults ?? MAX_SESSION_RESULTS)));
  return [...entries]
    .sort((a, b) => b.closedAt - a.closedAt)
    .slice(0, max)
    .map((e) => ({ lastModified: seconds(e.closedAt), tab: sessionTab(e, e.windowId, e.sessionId) }));
}

/** Session ids of another device's tabs: "remote:<device id>:<index>". */
export const remoteSessionId = (deviceId: string, index: number): string => `remote:${deviceId}:${index}`;

export function parseRemoteSessionId(id: string): { deviceId: string; index: number } | null {
  const m = /^remote:(.+):(\d+)$/.exec(id);
  return m ? { deviceId: m[1]!, index: Number(m[2]) } : null;
}

/** chrome.sessions.getDevices(): each other device with its open tabs as one window. */
export function deviceSessions(devices: readonly RemoteDeviceTabs[], maxResults?: number): ChromeDevice[] {
  const max = Math.max(0, Math.min(MAX_SESSION_RESULTS, Math.floor(maxResults ?? MAX_SESSION_RESULTS)));
  return devices.map((d) => ({
    deviceName: d.device,
    sessions:
      max === 0
        ? []
        : [
            {
              lastModified: seconds(d.updatedAt),
              window: {
                sessionId: `remote:${d.deviceId}`,
                tabs: d.tabs.map((t, i) => sessionTab({ ...t, index: i }, -1, remoteSessionId(d.deviceId, i))),
                focused: false,
                incognito: false,
                alwaysOnTop: false,
              },
            },
          ],
  }));
}
