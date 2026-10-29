import type { DeviceInfo, SyncCollection, SyncItem, SyncStateStorage } from "@corvus/shared";
import { describe, expect, it } from "vitest";
import { ago } from "../src/lib/format";
import { Replica, computerTabs, filterTabs, tabHost, type ReplicaClient } from "../src/lib/replica";

/** A chain's change log as the sync client hands it out: pullPages continues from its cursor. */
class FakeChain implements ReplicaClient {
  readonly log: SyncItem[] = [];
  readonly forgotten: SyncCollection[] = [];
  private position = 0;

  add(...items: SyncItem[]): void {
    this.log.push(...items);
  }
  async cursor(): Promise<number> {
    return this.position;
  }
  async pullPages(onPage: (items: SyncItem[]) => Promise<void> | void): Promise<number> {
    const fresh = this.log.slice(this.position);
    if (fresh.length > 0) await onPage(fresh);
    this.position = this.log.length;
    return fresh.length;
  }
  async pullCollection(collection: SyncCollection, onPage: (items: SyncItem[]) => Promise<void> | void): Promise<number> {
    const items = this.log.filter((i) => i.collection === collection);
    if (items.length > 0) await onPage(items);
    return items.length;
  }
  async forgetCollection(collection: SyncCollection): Promise<void> {
    this.forgotten.push(collection);
  }
}

function memory(): SyncStateStorage {
  const map = new Map<string, string>();
  return { get: async (k) => map.get(k), set: async (k, v) => void map.set(k, v) };
}

const tabsOf = (device: string, updatedAt: number, ...urls: string[]) => ({
  device,
  platform: "win32",
  updatedAt,
  tabs: urls.map((url) => ({ url, title: `Title of ${url}`, pinned: false })),
});

const item = (collection: SyncCollection, id: string, payload: unknown): SyncItem => ({ collection, id, payload, deleted: payload === null });

describe("replica", () => {
  it("keeps the collections the phone shows, across restarts, and applies deletions", async () => {
    const storage = memory();
    const chain = new FakeChain();
    chain.add(item("open_tabs", "desk", tabsOf("Desk", 1, "https://a.example/")), item("bookmarks", "b1", { url: "https://b.example/" }));
    const replica = new Replica(storage, "corvus-sync/chain/", ["open_tabs"]);
    expect(await replica.sync(chain)).toBe(1);
    expect(Object.keys(await replica.records("open_tabs"))).toEqual(["desk"]);
    expect(await replica.records("bookmarks")).toEqual({});

    const restarted = new Replica(storage, "corvus-sync/chain/", ["open_tabs"]);
    expect(Object.keys(await restarted.records("open_tabs"))).toEqual(["desk"]);
    chain.add(item("open_tabs", "laptop", tabsOf("Laptop", 2, "https://c.example/")), item("open_tabs", "desk", null));
    expect(await restarted.sync(chain)).toBe(2);
    expect(Object.keys(await restarted.records("open_tabs"))).toEqual(["laptop"]);
    expect(chain.forgotten).toEqual([]);
  });

  it("fetches a collection in full once when a newer app starts showing it", async () => {
    const storage = memory();
    const chain = new FakeChain();
    chain.add(item("open_tabs", "desk", tabsOf("Desk", 1, "https://a.example/")), item("bookmarks", "b1", { url: "https://b.example/" }));
    await new Replica(storage, "p/", ["open_tabs"]).sync(chain);

    const upgraded = new Replica(storage, "p/", ["open_tabs", "bookmarks"]);
    await upgraded.sync(chain);
    expect(chain.forgotten).toEqual(["bookmarks"]);
    expect(Object.keys(await upgraded.records("bookmarks"))).toEqual(["b1"]);
    await upgraded.sync(chain);
    expect(chain.forgotten).toEqual(["bookmarks"]);
  });
});

describe("replica: changes saved later", () => {
  it("keeps a browser visit in memory at once and saves it with flush or the next save", async () => {
    const storage = memory();
    const replica = new Replica(storage, "c/");
    await replica.putSoon("history", "https://a.com/", { url: "https://a.com/", title: "A", visitedAt: 1, visitCount: 1 });
    expect(Object.keys(await replica.records("history"))).toEqual(["https://a.com/"]);
    expect(await storage.get("c/data/history")).toBeUndefined();
    await replica.flush();
    expect(JSON.parse((await storage.get("c/data/history"))!)).toHaveProperty(["https://a.com/"]);
    await replica.putSoon("history", "https://b.com/", { url: "https://b.com/", title: "B", visitedAt: 2, visitCount: 1 });
    await replica.put("history", "https://c.com/", { url: "https://c.com/", title: "C", visitedAt: 3, visitCount: 1 });
    expect(Object.keys(JSON.parse((await storage.get("c/data/history"))!)).sort()).toEqual(["https://a.com/", "https://b.com/", "https://c.com/"]);
    expect(Object.keys(await new Replica(storage, "c/").records("history"))).toHaveLength(3);
  });
});

describe("tabs from your computers", () => {
  const device = (id: string): DeviceInfo => ({ id, name: id, platform: "win32", lastSeen: 0 });

  it("lists other devices' tabs, newest first, without this phone or devices that left the chain", () => {
    const records = {
      desk: tabsOf("Desk", 10, "https://a.example/", "file:///C:/secret.txt"),
      laptop: tabsOf("Laptop", 20, "https://b.example/"),
      gone: tabsOf("Old PC", 30, "https://c.example/"),
      empty: tabsOf("Empty", 40),
      phone: tabsOf("Phone", 50, "https://d.example/"),
      broken: { device: 1 },
    };
    const devices = ["desk", "laptop", "empty", "phone", "broken"].map(device);
    const list = computerTabs(records, devices, "phone");
    expect(list.map((c) => c.device)).toEqual(["Laptop", "Desk"]);
    expect(list[1]?.tabs.map((t) => t.url)).toEqual(["https://a.example/"]);
    expect(list[1]?.deviceId).toBe("desk");
    // Before the device list is known (offline), every record is shown.
    expect(computerTabs(records, [], "phone").map((c) => c.device)).toEqual(["Old PC", "Laptop", "Desk"]);
  });

  it("finds tabs by every word of the query, in the title or the address", () => {
    const list = computerTabs({ desk: tabsOf("Desk", 1, "https://news.example/today", "https://mail.example/inbox") }, [], null);
    expect(filterTabs(list, "").map((c) => c.tabs.length)).toEqual([2]);
    expect(filterTabs(list, "  NEWS today ")[0]?.tabs.map((t) => t.url)).toEqual(["https://news.example/today"]);
    expect(filterTabs(list, "news inbox")).toEqual([]);
  });

  it("shows hosts and times the short way", () => {
    expect(tabHost("https://www.example.com/a?b")).toBe("example.com");
    expect(tabHost("not a url")).toBe("");
    const now = 1_000_000_000;
    // No-break spaces keep a time on one line when the text around it wraps.
    const nbsp = (s: string): string => s.replace(/ /g, "\u00a0");
    expect(ago(now - 10_000, now)).toBe(nbsp("just now"));
    expect(ago(now - 5 * 60_000, now)).toBe(nbsp("5 min ago"));
    expect(ago(now - 3 * 3_600_000, now)).toBe(nbsp("3 h ago"));
    expect(ago(now - 2 * 86_400_000, now)).toBe(nbsp("2 d ago"));
  });
});
