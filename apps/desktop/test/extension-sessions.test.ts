import { describe, expect, it } from "vitest";
import { registerSessionApis, type SessionsAccess } from "../src/main/extension-apis";
import type { RouterCallback } from "../src/main/extensions";
import { closedSessions, deviceSessions, parseRemoteSessionId, remoteSessionId, type ClosedTabEntry } from "../src/shared/chrome-sessions";

const closed = (sessionId: string, closedAt: number, url = `https://${sessionId}.example/`): ClosedTabEntry => ({
  sessionId,
  windowId: 1,
  closedAt,
  url,
  title: sessionId,
  index: 0,
  pinned: false,
});

describe("chrome.sessions helpers", () => {
  it("lists closed tabs newest first, in seconds, at most 25", () => {
    const list = closedSessions([closed("a", 1_000), closed("b", 5_000), closed("c", 3_000)], 2);
    expect(list.map((s) => s.tab!.sessionId)).toEqual(["b", "c"]);
    expect(list[0]).toMatchObject({ lastModified: 5, tab: { url: "https://b.example/", active: false, windowId: 1 } });
    expect(closedSessions(Array.from({ length: 40 }, (_, i) => closed(`t${i}`, i)))).toHaveLength(25);
  });

  it("shows each other device's tabs as one window, restorable by id", () => {
    const [device] = deviceSessions([{ deviceId: "dev-1", device: "Laptop", platform: "linux", updatedAt: 9_000, tabs: [{ url: "https://a.example/", title: "A", pinned: true }] }]);
    expect(device).toMatchObject({ deviceName: "Laptop", sessions: [{ lastModified: 9, window: { sessionId: "remote:dev-1" } }] });
    const tab = device!.sessions[0]!.window!.tabs[0]!;
    expect(tab).toMatchObject({ url: "https://a.example/", pinned: true, index: 0, sessionId: remoteSessionId("dev-1", 0) });
    expect(parseRemoteSessionId(tab.sessionId!)).toEqual({ deviceId: "dev-1", index: 0 });
    expect(parseRemoteSessionId("c123")).toBeNull();
  });
});

describe("chrome.sessions for extensions", () => {
  it("answers behind the sessions permission and reports changes to the closed list", async () => {
    const list = [closed("a", 1_000)];
    const listeners: Array<() => void> = [];
    const access: SessionsAccess = {
      closed: () => list,
      devices: async () => [],
      restore: async (id) => {
        const at = list.findIndex((c) => c.sessionId === (id ?? list[0]?.sessionId));
        if (at < 0) return null;
        const [entry] = list.splice(at, 1);
        return { id: 42, index: 0, windowId: 1, url: entry!.url, title: entry!.title, pinned: false, active: true, highlighted: false, incognito: false, groupId: -1 };
      },
    };
    const handlers = new Map<string, { cb: RouterCallback; permission?: string }>();
    const events: string[] = [];
    registerSessionApis(
      {
        handle: (name, cb, permission) => void handlers.set(name, { cb, ...(permission ? { permission } : {}) }),
        emit: (_p, event) => void events.push(event),
        onWindowChanged: (l) => {
          listeners.push(l);
          return () => undefined;
        },
      },
      access,
    );
    const call = async (name: string, ...args: unknown[]): Promise<unknown> => handlers.get(name)!.cb({ type: "frame" }, ...args);
    expect([...handlers.values()].every((h) => h.permission === "sessions")).toBe(true);
    expect(await call("sessions.getRecentlyClosed", {})).toEqual([expect.objectContaining({ lastModified: 1, tab: expect.objectContaining({ sessionId: "a" }) })]);
    expect(await call("sessions.getDevices")).toEqual([]);
    expect(await call("sessions.restore", "a")).toMatchObject({ tab: { id: 42, url: "https://a.example/" } });
    await expect(call("sessions.restore", "zzz")).rejects.toThrow('Invalid session id: "zzz".');
    await expect(call("sessions.restore")).rejects.toThrow("There are no recently closed sessions.");
    listeners.forEach((l) => l());
    expect(events).toEqual(["sessions.onChanged"]);
    listeners.forEach((l) => l());
    expect(events).toHaveLength(1);
  });
});
