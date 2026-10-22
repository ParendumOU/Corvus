import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FlowTarget } from "../src/shared/flow";
import {
  MAX_ENTRY_BYTES,
  MAX_HOSTS,
  entryBytes,
  extractLessons,
  hintKey,
  mergeLessons,
  type HostLessons,
  type SiteMemoryEntry,
  type TrailEvent,
} from "../src/shared/site-memory";
import {
  WIPE_RECORD_ID,
  entryFromSynced,
  markerRecord,
  mergeSiteMemory,
  parseSiteMemoryWipe,
  parseSyncedSiteMemory,
  removalKey,
  syncSafeTarget,
  toSyncedSiteMemory,
  type MergeContext,
  type SyncedSiteMemory,
} from "../src/shared/site-memory-sync";
import { SiteMemoryStore } from "../src/main/site-memory-store";

const HOST = "shop.example";
const U = `https://${HOST}/`;
const A = "aaaaaa11";
const B = "bbbbbb22";
const C = "cccccc33";
const DAY = 24 * 3600_000;
const T0 = 1_800_000_000_000;

const t = (role: string, name: string): FlowTarget => ({ role, name, index: 0, tag: "", selector: "" });
const nav = (url: string): TrailEvent => ({ type: "action", ok: true, action: { kind: "navigate", url } });
const click = (role: string, name: string, url = U): TrailEvent => ({ type: "action", ok: true, action: { kind: "click", url, target: t(role, name) } });
const typeInto = (role: string, name: string, value: string, opts: { secret?: boolean; submit?: boolean; url?: string } = {}): TrailEvent => ({
  type: "action",
  ok: true,
  action: opts.secret
    ? { kind: "type", url: opts.url ?? U, target: t(role, name), secret: true, submit: opts.submit === true }
    : { kind: "type", url: opts.url ?? U, target: t(role, name), value, submit: opts.submit === true, secret: false },
});
const visit = (url: string): TrailEvent => ({ type: "visit", url });

const SHOP_RUN: TrailEvent[] = [
  nav(U),
  visit(U),
  click("button", "Accept all"),
  typeInto("searchbox", "Search products", "red umbrella"),
  click("button", "Search"),
  visit(`${U}s?k=red+umbrella`),
  click("button", "Add to cart"),
  visit(`${U}cart`),
];

const lessonsOf = (trail: TrailEvent[]): HostLessons => extractLessons(trail)[0]!;
const ctx = (now: number, wipedAt = 0): MergeContext => ({ now, wipedAt });
const NONE = { clearedAt: 0, removed: {} };

/** A device's record after learning `runs` shop runs at T0, T0+1, ... */
function learned(replica: string, runs: number, start = T0, trail = SHOP_RUN): SiteMemoryEntry {
  let e: SiteMemoryEntry | undefined;
  for (let i = 0; i < runs; i++) e = mergeLessons(e, lessonsOf(trail), true, start + i, replica);
  return e!;
}
const recordOf = (replica: string, entry: SiteMemoryEntry, markers = NONE, now = T0 + DAY): SyncedSiteMemory => toSyncedSiteMemory(entry, entry.host, markers, replica, ctx(now));
const okOf = (r: SyncedSiteMemory, name: string): number => {
  const target = r.targets.find((x) => x.name === name);
  return target ? Object.values(target.by).reduce((n, c) => n + c[0], 0) : 0;
};

describe("site memory merge", () => {
  const now = T0 + DAY;

  it("combines counts per device and never counts the same data twice", () => {
    const a = recordOf(A, learned(A, 2));
    const b = recordOf(B, learned(B, 1, T0 + 100));
    const merged = mergeSiteMemory(a, b, ctx(now));
    expect(okOf(merged, "Add to cart")).toBe(3);
    expect(Object.keys(merged.runs).sort()).toEqual([A, B]);
    expect(entryFromSynced(merged)).toMatchObject({ runs: 3, firstSeen: T0, lastSeen: T0 + 100 });
    // The same data coming back (again and again) changes nothing.
    expect(mergeSiteMemory(merged, a, ctx(now))).toEqual(merged);
    expect(mergeSiteMemory(merged, b, ctx(now))).toEqual(merged);
    expect(mergeSiteMemory(merged, merged, ctx(now))).toEqual(merged);
    // A device that learned more since replaces only its own slot.
    const a3 = recordOf(A, learned(A, 3));
    expect(okOf(mergeSiteMemory(merged, a3, ctx(now)), "Add to cart")).toBe(4);
  });

  it("is idempotent, commutative and associative", () => {
    const a = recordOf(A, learned(A, 2), { clearedAt: 0, removed: { [removalKey("url", "opened|/")]: T0 - 10 } });
    const b = recordOf(B, learned(B, 1, T0 + 50, [nav(U), click("link", "Next"), click("button", "Search")]));
    const c = recordOf(C, learned(C, 3, T0 + 70));
    expect(mergeSiteMemory(a, a, ctx(now))).toEqual(a);
    expect(mergeSiteMemory(a, b, ctx(now))).toEqual(mergeSiteMemory(b, a, ctx(now)));
    expect(mergeSiteMemory(mergeSiteMemory(a, b, ctx(now)), c, ctx(now))).toEqual(mergeSiteMemory(a, mergeSiteMemory(b, c, ctx(now)), ctx(now)));
    expect(mergeSiteMemory(mergeSiteMemory(c, a, ctx(now)), b, ctx(now))).toEqual(mergeSiteMemory(mergeSiteMemory(a, b, ctx(now)), c, ctx(now)));
  });

  it("a forgotten hint stays forgotten when a stale device sends it back, until it is learned again", () => {
    const stale = recordOf(B, learned(B, 4));
    const key = hintKey("target", { intent: "add_to_cart", act: "click", role: "button", name: "Add to cart", ok: 0, fail: 0, last: 0 });
    const forgotAt = T0 + 1000;
    const forgetter = markerRecord(HOST, { clearedAt: 0, removed: { [removalKey("target", key)]: forgotAt } });
    const merged = mergeSiteMemory(forgetter, stale, ctx(now));
    expect(merged.targets.map((x) => x.name)).not.toContain("Add to cart");
    expect(merged.targets.map((x) => x.name)).toContain("Search");
    expect(merged.removed).toEqual({ [removalKey("target", key)]: forgotAt });
    // Learned again after the forget: it comes back with only the new count.
    const relearned = recordOf(B, learned(B, 1, forgotAt + 10));
    expect(okOf(mergeSiteMemory(merged, relearned, ctx(now)), "Add to cart")).toBe(1);
  });

  it("forget this site wins over older copies but keeps what was learned after it", () => {
    const stale = recordOf(B, learned(B, 3));
    const clearedAt = T0 + 1000;
    const merged = mergeSiteMemory(markerRecord(HOST, { clearedAt, removed: {} }), stale, ctx(now));
    expect(merged).toEqual(markerRecord(HOST, { clearedAt, removed: {} }));
    expect(entryFromSynced(merged)).toBeNull();
    const fresh = recordOf(C, learned(C, 1, clearedAt + 5));
    const later = mergeSiteMemory(merged, fresh, ctx(now));
    expect(okOf(later, "Add to cart")).toBe(1);
    expect(later.clearedAt).toBe(clearedAt);
    expect(Object.keys(later.runs)).toEqual([C]);
  });

  it("re-applies the caps and decay rules after merging, the same way on every device", () => {
    const many = (replica: string, offset: number): SiteMemoryEntry => {
      let e: SiteMemoryEntry | undefined;
      for (let i = 0; i < 30; i++) {
        e = mergeLessons(
          e,
          { host: HOST, targets: [{ intent: "other", act: "click", role: "link", name: `Category ${replica.slice(0, 1)}${i}` }], urls: [{ label: "opened", pattern: `/c${replica.slice(0, 1)}${i}/a/b/c` }], obstacles: [], sequence: [], failures: [] },
          true,
          T0 + offset + i,
          replica,
        );
      }
      return e!;
    };
    const a = recordOf(A, many(A, 0));
    const b = recordOf(B, many(B, 100));
    const ab = mergeSiteMemory(a, b, ctx(now));
    const ba = mergeSiteMemory(b, a, ctx(now));
    expect(ab).toEqual(ba);
    const entry = entryFromSynced(ab)!;
    expect(entryBytes(entry)).toBeLessThanOrEqual(MAX_ENTRY_BYTES);
    expect(entry.targets.length).toBeLessThanOrEqual(24);
    expect(entry.urls.length).toBeLessThanOrEqual(12);
    // Stable: merging the result with either side again keeps exactly the same items.
    expect(mergeSiteMemory(ab, a, ctx(now))).toEqual(ab);
    // Items unseen for 180 days expire, and a target that keeps failing goes.
    expect(entryFromSynced(mergeSiteMemory(ab, null, ctx(T0 + 200 * DAY)))).toBeNull();
    let failing = learned(A, 1);
    for (let i = 0; i < 3; i++) failing = mergeLessons(failing, { host: HOST, targets: [], urls: [], obstacles: [], sequence: [], failures: [{ role: "button", name: "Accept all" }] }, false, T0 + 10 + i, A);
    const tidy = mergeSiteMemory(recordOf(A, failing), recordOf(B, learned(B, 0 + 1, T0 + 20, [nav(U), click("button", "Search")])), ctx(now));
    expect(tidy.targets.map((x) => x.name)).not.toContain("Accept all");
    expect(tidy.obstacles).toEqual([]);
  });
});

describe("site memory privacy in records", () => {
  it("never puts credential fields or typed values in a record, whatever tool typed them", () => {
    // What a sign-in helper (fill_login / fill_totp) would leave in a trail: typed user name and
    // e-mail fields, a secret password, a one-time code.
    const trail: TrailEvent[] = [
      nav(U),
      typeInto("textbox", "Username", "alice"),
      typeInto("textbox", "Email", "alice@example.com"),
      typeInto("textbox", "Password", "", { secret: true }),
      typeInto("textbox", "Enter the code we sent", "123456"),
      typeInto("textbox", "Verification code", "654321", { submit: true }),
      click("button", "Sign in"),
      typeInto("searchbox", "Search products", "umbrella"),
    ];
    const entry = learned(A, 1, T0, trail);
    const record = recordOf(A, entry);
    expect(record.targets.map((x) => `${x.act}:${x.name}`).sort()).toEqual(["click:Sign in", "type:Search products"]);
    const json = JSON.stringify(record);
    expect(json).not.toMatch(/alice|123456|654321|umbrella|Password|Username|Email/);
  });

  it("a record survives the round trip unchanged", () => {
    const record = recordOf(A, learned(A, 2), { clearedAt: T0 - 5, removed: { [removalKey("url", "opened|/x")]: T0 - 1 } });
    expect(parseSyncedSiteMemory(JSON.parse(JSON.stringify(record)), HOST)).toEqual(record);
    expect(mergeSiteMemory(record, null, ctx(T0 + DAY))).toEqual(record);
  });

  it("filters what arrives too", () => {
    const evil = {
      v: 1,
      host: HOST,
      runs: { [A]: [1, 0, T0, T0] },
      targets: [
        { intent: "login", act: "type", role: "textbox", name: "E-mail address", by: { [A]: [1, 0, T0] } },
        { intent: "other", act: "type", role: "textbox", name: "Card number", by: { [A]: [1, 0, T0] } },
        { intent: "other", act: "click", role: "button", name: "jane@example.com", by: { [A]: [1, 0, T0] } },
        { intent: "search", act: "type", role: "searchbox", name: "Search", by: { [A]: [1, 0, T0], "NOT A REPLICA": [9, 9, 9] } },
      ],
      urls: [
        { label: "opened", pattern: "/u/jane@example.com", by: { [A]: [1, 0, T0] } },
        { label: "opened", pattern: "/reset?token=abc", by: { [A]: [1, 0, T0] } },
        { label: "search results", pattern: "/s?k=*", by: { [A]: [1, 0, T0] } },
      ],
      obstacles: [{ kind: "popup", how: 'click button "Hi, Jane"', by: { [A]: [1, 0, T0] } }],
      sequences: [],
      removed: {},
      clearedAt: 0,
    };
    const parsed = parseSyncedSiteMemory(evil, HOST)!;
    expect(parsed.targets.map((x) => x.name)).toEqual(["Search"]);
    expect(Object.keys(parsed.targets[0]!.by)).toEqual([A]);
    expect(parsed.urls.map((u) => u.pattern)).toEqual(["/s?k=*"]);
    expect(parsed.obstacles).toEqual([]);
    expect(syncSafeTarget({ intent: "login", act: "click", role: "button", name: "Sign in" })).toBe(true);
    // A newer format, another host or garbage is declined.
    expect(parseSyncedSiteMemory({ ...evil, v: 2 }, HOST)).toBeNull();
    expect(parseSyncedSiteMemory(evil, "other.example")).toBeNull();
    expect(parseSyncedSiteMemory("nope", HOST)).toBeNull();
    expect(parseSiteMemoryWipe({ v: 1, wipedAt: 5 })).toEqual({ v: 1, wipedAt: 5 });
    expect(parseSiteMemoryWipe({ v: 1, wipedAt: "x" })).toBeNull();
  });
});

describe("site memory stores exchanging records", () => {
  let dirs: string[] = [];
  const store = (): SiteMemoryStore => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "corvus-memsync-"));
    dirs.push(dir);
    return new SiteMemoryStore(dir);
  };
  beforeEach(() => {
    dirs = [];
  });
  afterEach(() => {
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  });

  /** One direction of a sync: `to` merges everything `from` lists. */
  const send = (from: SiteMemoryStore, to: SiteMemoryStore, now: number): void => {
    to.applyRemote(
      from.syncList(now).map((r) => ({ id: r.id, record: r.payload })),
      now,
    );
  };
  const hosts = (s: SiteMemoryStore): string[] => s.list().map((e) => e.host).sort();

  it("converges both ways and stays quiet once in sync", () => {
    const now = Date.now();
    const a = store();
    const b = store();
    expect(a.replica).not.toBe(b.replica);
    a.learn(SHOP_RUN, true, now - 1000);
    b.learn(SHOP_RUN, true, now - 500);
    b.learn([nav("https://news.example/"), click("link", "Next", "https://news.example/")], true, now - 400);
    send(a, b, now);
    send(b, a, now);
    expect(a.syncList(now)).toEqual(b.syncList(now));
    expect(hosts(a)).toEqual(["news.example", HOST]);
    expect(a.get(HOST)!.targets.find((x) => x.name === "Add to cart")!.ok).toBe(2);
    // Sending the same data again does not double count.
    send(a, b, now);
    send(b, a, now);
    expect(a.get(HOST)!.targets.find((x) => x.name === "Add to cart")!.ok).toBe(2);
  });

  it("forget this hint and forget this site propagate and survive a stale device", () => {
    const now = Date.now();
    const a = store();
    const b = store();
    a.learn(SHOP_RUN, true, now - 5000);
    send(a, b, now - 4000);
    const stale = store();
    send(a, stale, now - 4000); // a device that goes offline with the old copy

    const cart = a.get(HOST)!.targets.find((x) => x.name === "Add to cart")!;
    b.removeHint(HOST, "target", hintKey("target", cart), now - 3000);
    send(b, a, now - 2000);
    expect(a.get(HOST)!.targets.map((x) => x.name)).not.toContain("Add to cart");

    // The stale device syncs its old copy back: the hint does not return anywhere.
    send(stale, a, now - 1000);
    send(a, stale, now - 1000);
    expect(a.get(HOST)!.targets.map((x) => x.name)).not.toContain("Add to cart");
    expect(stale.get(HOST)!.targets.map((x) => x.name)).not.toContain("Add to cart");

    b.forget(HOST, now - 900);
    send(b, a, now - 800);
    expect(a.get(HOST)).toBeUndefined();
    const stale2 = store();
    stale2.learn(SHOP_RUN, true, now - 5000); // learned before the forget, never synced
    send(stale2, a, now - 700);
    expect(a.get(HOST)).toBeUndefined();
    send(a, stale2, now - 700);
    expect(stale2.get(HOST)).toBeUndefined();
  });

  it("forget everything wipes every device, beats a stale peer and keeps what is learned after it", () => {
    const now = Date.now();
    const a = store();
    const b = store();
    a.learn(SHOP_RUN, true, now - 9000);
    b.learn([nav("https://docs.example/"), click("link", "Next", "https://docs.example/")], true, now - 8000);
    send(a, b, now - 7000);
    send(b, a, now - 7000);
    // A stale peer: learned hosts nobody else has seen, before the wipe, and never synced.
    const stale = store();
    stale.learn([nav("https://old.example/"), click("button", "Search", "https://old.example/")], true, now - 6500);
    send(a, stale, now - 6400);

    b.forgetAll(now - 6000);
    expect(b.list()).toEqual([]);
    const records = b.syncList(now - 5900);
    expect(records.find((r) => r.id === WIPE_RECORD_ID)?.payload).toEqual({ v: 1, wipedAt: now - 6000 });
    // Each host b knew is overwritten with an empty tombstone record.
    for (const r of records.filter((x) => x.id !== WIPE_RECORD_ID)) expect(entryFromSynced(r.payload as SyncedSiteMemory)).toBeNull();

    send(b, a, now - 5800);
    expect(a.list()).toEqual([]);
    send(stale, a, now - 5700);
    expect(a.list()).toEqual([]);
    send(a, stale, now - 5600);
    expect(stale.list()).toEqual([]);

    // Learning after the wipe syncs normally.
    stale.learn([nav("https://new.example/"), click("button", "Search", "https://new.example/")], true, now - 5000);
    send(stale, a, now - 4000);
    expect(hosts(a)).toEqual(["new.example"]);
  });

  it("keeps the 200-host cap (least recently seen first) after merging", () => {
    const now = Date.now();
    const a = store();
    const b = store();
    for (let i = 0; i < 150; i++) a.learn([nav(`https://a${i}.example/`), click("link", "Next", `https://a${i}.example/`)], true, now - 100_000 + i);
    for (let i = 0; i < 120; i++) b.learn([nav(`https://b${i}.example/`), click("link", "Next", `https://b${i}.example/`)], true, now - 50_000 + i);
    send(b, a, now);
    expect(a.size).toBe(MAX_HOSTS);
    expect(a.get("b119.example")).toBeDefined();
    expect(a.get("a0.example")).toBeUndefined();
    expect(a.get("a149.example")).toBeDefined();
  });

  it("joining a chain drops tombstones recorded while not syncing", () => {
    const now = Date.now();
    const a = store();
    a.learn(SHOP_RUN, true, now - 1000);
    a.forget(HOST, now - 500);
    expect(a.syncList(now).map((r) => r.id)).toEqual([HOST]);
    a.resetSyncMarkers();
    expect(a.syncList(now)).toEqual([]);
  });
});
