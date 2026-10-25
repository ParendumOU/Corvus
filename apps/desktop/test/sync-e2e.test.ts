import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseDeviceWatchStatus, sentTabs, type SyncStateStorage } from "@corvus/shared";
import { SyncEngine, createSyncClient, type CorvusSyncClient, type SyncAdapter } from "@corvus/sync-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer } from "../../../services/sync-server/src/app";
import { AnnotationStore } from "../src/main/annotation-store";
import { CommandHistoryStore } from "../src/main/command-history-store";
import { CredentialVault } from "../src/main/credential-store";
import { FlowStore } from "../src/main/flow-store";
import { SiteMemoryStore } from "../src/main/site-memory-store";
import { ReadingStore } from "../src/main/reading-store";
import { SettingsStore, type SecretCipher } from "../src/main/settings-store";
import { BookmarkStore, HistoryStore } from "../src/main/stores";
import { SyncRemoteStore, createSyncAdapters, type ProfileMeta } from "../src/main/sync-adapters";
import { SyncConflictStore } from "../src/main/sync-conflict-store";
import { CONFLICT_COLLECTIONS, conflictView, freshVersion } from "../src/shared/sync-conflicts";
import { WatchStore } from "../src/main/watch-store";
import { WorkspaceStore } from "../src/main/workspace-store";
import type { ReadingItem } from "../src/shared/reading";
import { BAR_FOLDER_ID, OTHER_FOLDER_ID, ROOT_IDS, toTree } from "../src/shared/bookmark-tree";
import { extensionSuggestions, webstoreExtensions } from "../src/shared/extension-suggestions";
import type { ExtensionInfo } from "../src/shared/ipc";
import { OpenTabsPublisher, parseDeviceTabs, type SyncedTab } from "../src/shared/open-tabs";
import { toWatchStatus } from "../src/shared/page-watch";
import { StampedRecord } from "../src/shared/stamped-record";
import type { FlowStep } from "../src/shared/flow";
import { hintKey, type TrailEvent } from "../src/shared/site-memory";

const PHRASE = `${"abandon ".repeat(23)}art`;
const UBLOCK = "cjpalhdlnbpafiamejdnhcphjbkeiagm";
const DARK = "eimadpbcbfnmbkopoojfekhnkhdbieeh";

const cipher: SecretCipher = {
  isEncryptionAvailable: () => true,
  encryptString: (plain) => Buffer.from(`enc:${plain}`),
  decryptString: (enc) => enc.toString().slice(4),
};

function memoryStorage(): SyncStateStorage {
  const data = new Map<string, string>();
  return { get: async (k) => data.get(k), set: async (k, v) => void data.set(k, v) };
}

let server: Awaited<ReturnType<typeof buildServer>>;
let serverUrl: string;
const dirs: string[] = [];

beforeAll(async () => {
  server = await buildServer({ dbPath: ":memory:" });
  await server.listen({ port: 0, host: "127.0.0.1" });
  const addr = server.server.address();
  if (!addr || typeof addr === "string") throw new Error("no address");
  serverUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await server.close();
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

class Device {
  readonly dir = fs.mkdtempSync(path.join(os.tmpdir(), "corvus-sync-e2e-"));
  readonly bookmarks = new BookmarkStore(this.dir);
  readonly history = new HistoryStore(this.dir);
  readonly credentials = new CredentialVault(this.dir, cipher);
  readonly reading = new ReadingStore(this.dir);
  readonly annotations = new AnnotationStore(this.dir);
  readonly watches = new WatchStore(this.dir, () => 100);
  readonly workspaces = new WorkspaceStore(this.dir);
  readonly flows = new FlowStore(this.dir);
  readonly memory = new SiteMemoryStore(this.dir);
  readonly commands = new CommandHistoryStore(this.dir);
  readonly settings = new SettingsStore(this.dir, cipher, {});
  readonly remote = new SyncRemoteStore(path.join(this.dir, "sync-remote.json"));
  readonly conflicts = new SyncConflictStore(path.join(this.dir, "sync-conflicts.json"));
  readonly client: CorvusSyncClient;
  readonly engine: SyncEngine;
  readonly adapters: Partial<Record<string, SyncAdapter>>;
  meta: ProfileMeta;
  tabs: SyncedTab[] = [];
  installed: ExtensionInfo[] = [];
  shareUrls = false;

  constructor(
    readonly name: string,
    profileName: string,
  ) {
    dirs.push(this.dir);
    this.meta = { name: profileName };
    this.client = createSyncClient({ serverUrl, phrase: PHRASE, deviceName: name, platform: "linux", storage: memoryStorage() });
    const publisher = new OpenTabsPublisher(() => ({ device: name, platform: "linux", tabs: this.tabs }));
    const status = new StampedRecord(() => ({ device: name, platform: "linux", watches: this.watches.list().map(toWatchStatus) }));
    this.adapters = createSyncAdapters({
      bookmarks: this.bookmarks,
      history: this.history,
      credentials: this.credentials,
      reading: this.reading,
      watches: this.watches,
      workspaces: this.workspaces,
      annotations: this.annotations,
      workflows: this.flows,
      siteMemory: this.memory,
      commands: this.commands,
      settings: this.settings,
      includeServiceUrls: () => this.shareUrls,
      profile: { get: () => this.meta, set: (m) => (this.meta = m) },
      remote: this.remote,
      ownDeviceId: () => this.client.getDeviceId(),
      openTabs: () => {
        publisher.refresh();
        return publisher.record();
      },
      extensions: () => ({ device: name, extensions: webstoreExtensions(this.installed) }),
      watchStatus: () => status.record(),
    });
    this.engine = new SyncEngine({
      client: this.client,
      storage: memoryStorage(),
      adapters: this.adapters,
      conflictCollections: CONFLICT_COLLECTIONS,
      onConflict: (c) => this.conflicts.add(c),
    });
  }

  sync() {
    return this.engine.sync();
  }

  nonRootBookmarks() {
    return this.bookmarks
      .list()
      .filter((b) => !ROOT_IDS.has(b.id))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  historyByUrl() {
    return Object.fromEntries(this.history.all().map((e) => [e.url, { title: e.title, visitCount: e.visitCount, visitedAt: e.visitedAt }]));
  }

  remoteTabs() {
    return Object.values(this.remote.records("open_tabs").all()).map((r) => parseDeviceTabs(r));
  }

  async suggestions() {
    return extensionSuggestions(this.remote.records("extensions").all(), await this.client.getDeviceId(), this.installed.map((e) => e.id), this.remote.dismissed());
  }

  credentialsById() {
    return this.credentials.all().slice().sort((a, b) => a.id.localeCompare(b.id));
  }

  close() {
    this.bookmarks.flush();
    this.history.flush();
    this.credentials.flush();
    this.reading.flush();
    this.annotations.flush();
    this.watches.flush();
    this.workspaces.flush();
    this.flows.flush();
    this.memory.flush();
    this.commands.flush();
    this.settings.flush();
  }
}

function ext(id: string, name: string): ExtensionInfo {
  return { id, name, version: "1", description: "", source: "webstore", path: `/x/${id}`, iconUrl: "", enabled: true, pinned: false, hasAction: false, manifestVersion: 3, permissions: [], hostPermissions: [], warnings: [], unsupported: [], optionsUrl: null, homepageUrl: null, storeUrl: null, errors: [] };
}

const QUIET = { applied: 0, pushed: 0, deleted: 0, conflicts: 0 };

describe("desktop sync adapters end to end (two devices, one phrase, real server)", () => {
  it("converges every collection, keeps local-only settings local and propagates deletions", async () => {
    const a = new Device("Laptop", "Work");
    const b = new Device("Desktop", "Personal");
    await a.client.register();
    await b.client.register();

    // Device A: the existing chain owner.
    const folder = a.bookmarks.create({ parentId: BAR_FOLDER_ID, kind: "folder", title: "Projects" });
    a.bookmarks.create({ parentId: folder.id, kind: "bookmark", title: "Corvus", url: "https://corvus.example/" });
    a.history.recordVisit("https://a.example/", "A page");
    a.history.recordVisit("https://a.example/", "A page");
    a.history.recordVisit("https://shared.example/", "Shared (old title)");
    a.settings.update({ appearance: { theme: "dark" }, ai: { model: "claude-test-model", searxngUrl: "http://searx-a:8080" }, mcp: { port: 1111 } });
    a.meta = { name: "Work", avatar: "#f28b82" };
    a.tabs = [
      { url: "https://docs.example/", title: "Docs", pinned: true },
      { url: "https://issue.example/1", title: "Issue", pinned: false, group: { title: "Bugs", color: "red" } },
    ];
    a.installed = [ext(UBLOCK, "uBlock Origin")];
    const totp = { secret: "JBSWY3DPEHPK3PXP", algorithm: "SHA1" as const, digits: 6, period: 30 };
    const login = a.credentials.add({ origin: "https://corvus.example/login", username: "alice", password: "s3cret", notes: "primary", totp, agentTotp: true });
    const readingItem: ReadingItem = {
      id: "read-1",
      url: "https://read.example/article",
      title: "An Article",
      siteName: "Read",
      byline: "",
      excerpt: "",
      markdown: "# An Article\n\n<https://read.example/article>\n\nbody",
      keyPoints: ["point one"],
      wordCount: 42,
      readingMinutes: 1,
      savedAt: Date.now(),
    };
    a.reading.save(readingItem);
    const annotation = a.annotations.add({
      url: "https://anno.example/page#section",
      pageTitle: "Anno Page",
      color: "yellow",
      note: "my note",
      anchor: { quote: "hello world", prefix: "say ", suffix: " now" },
    });
    const watch = a.watches.add({ url: "https://watch.example/page", title: "Watched page", intervalMinutes: 60 });
    const workspace = a.workspaces.save("Research", [{ url: "https://ws.example/a", title: "WS tab", pinned: false }], [])[0];

    // Device B: joins later with some local data of its own.
    b.bookmarks.create({ parentId: OTHER_FOLDER_ID, kind: "bookmark", title: "B site", url: "https://b.example/" });
    await new Promise((r) => setTimeout(r, 5));
    b.history.recordVisit("https://shared.example/", "Shared (new title)");
    b.settings.update({ appearance: { theme: "light" }, ai: { searxngUrl: "http://searx-b:8080" }, mcp: { port: 2222 } });
    b.tabs = [{ url: "https://news.example/", title: "News", pinned: false }];
    b.installed = [ext(DARK, "Dark Reader")];

    await a.sync();
    await b.sync();
    await a.sync();
    expect(await b.sync()).toEqual(QUIET);
    expect(await a.sync()).toEqual(QUIET);

    // bookmarks: union, identical on both devices, tree intact on the joiner
    expect(b.nonRootBookmarks()).toEqual(a.nonRootBookmarks());
    expect(a.nonRootBookmarks()).toHaveLength(3);
    const bar = toTree(b.bookmarks.list())[0];
    expect(bar?.children.map((n) => n.title)).toEqual(["Projects"]);
    expect(bar?.children[0]?.children.map((n) => n.title)).toEqual(["Corvus"]);

    // history: keyed by URL, merged (newest title, max visit count)
    expect(b.historyByUrl()).toEqual(a.historyByUrl());
    expect(Object.keys(a.historyByUrl()).sort()).toEqual(["https://a.example/", "https://shared.example/"]);
    expect(a.historyByUrl()["https://shared.example/"]?.title).toBe("Shared (new title)");
    expect(a.historyByUrl()["https://a.example/"]?.visitCount).toBe(2);

    // settings: the chain wins on join; machine-specific values stay local
    expect(b.settings.get().appearance.theme).toBe("dark");
    expect(b.settings.get().ai.model).toBe("claude-test-model");
    expect(b.settings.get().mcp.port).toBe(2222);
    expect(b.settings.get().ai.searxngUrl).toBe("http://searx-b:8080");
    expect(a.settings.get().mcp.port).toBe(1111);

    // profiles: the joining profile adopts the chain's profile name and avatar
    expect(b.meta).toEqual({ name: "Work", avatar: "#f28b82" });

    // credentials: the encrypted login (with its password) reaches the other device intact
    expect(b.credentialsById()).toEqual(a.credentialsById());
    expect(b.credentials.get(login.id)).toMatchObject({ origin: "https://corvus.example", username: "alice", password: "s3cret", notes: "primary", totp, agentTotp: true });

    // open tabs: each device sees the other's tabs, never its own
    expect(a.remoteTabs()).toEqual([expect.objectContaining({ device: "Desktop", tabs: b.tabs })]);
    expect(b.remoteTabs()).toEqual([expect.objectContaining({ device: "Laptop", tabs: a.tabs })]);

    // extensions: suggested, not installed
    expect(await a.suggestions()).toEqual([{ id: DARK, name: "Dark Reader", devices: ["Desktop"] }]);
    expect(await b.suggestions()).toEqual([{ id: UBLOCK, name: "uBlock Origin", devices: ["Laptop"] }]);
    expect(b.installed.map((e) => e.id)).toEqual([DARK]);

    // reading library: the saved article (with its Markdown body) reaches the other device, keyed by URL
    expect(b.reading.allItems()).toEqual(a.reading.allItems());
    expect(b.reading.get("read-1")).toMatchObject({ url: "https://read.example/article", markdown: readingItem.markdown });

    // annotations: the highlight (with its text-quote anchor and note) reaches the other device, keyed by id
    expect(b.annotations.all()).toEqual(a.annotations.all());
    expect(b.annotations.get(annotation!.id)).toMatchObject({ url: "https://anno.example/page", note: "my note", color: "yellow" });
    expect(b.annotations.forUrl("https://anno.example/page")).toHaveLength(1);

    // watched pages: the definition travels (URL-keyed); the joining device materializes its own id
    const bWatch = b.watches.list().find((w) => w.url === "https://watch.example/page");
    expect(bWatch).toMatchObject({ title: "Watched page", intervalMinutes: 60, paused: false });
    expect(bWatch?.lastResult).toBe("pending");

    // workspaces: the saved set is reproduced on the other device, keyed by its stable id
    const bWorkspace = b.workspaces.get(workspace!.id);
    expect(bWorkspace).toMatchObject({ name: "Research" });
    expect(bWorkspace?.tabs.map((t) => t.url)).toEqual(["https://ws.example/a"]);

    // Opting in to service URLs on both devices shares the SearXNG URL from the device that opted in first.
    a.shareUrls = true;
    await a.sync();
    b.shareUrls = true;
    await b.sync();
    expect(b.settings.get().ai.searxngUrl).toBe("http://searx-a:8080");

    // Tab changes republish; deletions propagate both ways.
    b.tabs = [];
    b.bookmarks.remove(folder.id);
    a.history.clear();
    a.credentials.remove(login.id);
    expect(await b.sync()).toMatchObject({ pushed: 1, deleted: 2 });
    await a.sync();
    await b.sync();
    expect(a.nonRootBookmarks().map((n) => n.title)).toEqual(["B site"]);
    expect(b.history.all()).toEqual([]);
    expect(a.remoteTabs()).toEqual([expect.objectContaining({ device: "Desktop", tabs: [] })]);
    expect(a.credentials.all()).toEqual([]);
    expect(b.credentials.all()).toEqual([]);

    // Removing device B drops its records chain-wide; a restored device only sees A.
    const bId = await b.client.getDeviceId();
    await a.client.removeDevice(bId);
    a.remote.forgetDevice(bId);
    // B's open tabs, extensions and watch status.
    expect(await a.sync()).toMatchObject({ deleted: 3 });

    const c = new Device("Restored", "Personal");
    await c.client.register();
    await c.sync();
    expect(c.meta).toEqual({ name: "Work", avatar: "#f28b82" });
    expect(c.nonRootBookmarks()).toEqual(a.nonRootBookmarks());
    expect(c.remoteTabs()).toEqual([expect.objectContaining({ device: "Laptop" })]);
    expect(await c.suggestions()).toEqual([{ id: UBLOCK, name: "uBlock Origin", devices: ["Laptop"] }]);
    expect(c.reading.allItems()).toEqual(a.reading.allItems());
    expect(c.annotations.all()).toEqual(a.annotations.all());
    expect(c.watches.list().map((w) => w.url)).toContain("https://watch.example/page");
    expect(c.workspaces.get(workspace!.id)).toMatchObject({ name: "Research" });
    expect(await c.sync()).toEqual(QUIET);

    // A new-collection deletion propagates: removing the saved article on A tombstones it everywhere.
    a.reading.remove("read-1");
    a.annotations.remove(annotation!.id);
    await a.sync();
    await c.sync();
    expect(a.reading.allItems()).toEqual([]);
    expect(c.reading.allItems()).toEqual([]);
    expect(c.annotations.all()).toEqual([]);

    for (const d of [a, b, c]) d.close();
  });

  it("syncs workflows and site memory both ways, and forgets stick against a stale device", async () => {
    const a = new Device("Laptop", "Work");
    const b = new Device("Desktop", "Work");
    await a.client.register();
    await a.client.wipeChain(); // start from an empty chain
    await a.client.register();
    await b.client.register();

    const steps: FlowStep[] = [
      { kind: "navigate", url: "https://shop.example/", label: "Go to shop.example" },
      { kind: "type", url: "https://shop.example/", label: "Search", target: { role: "searchbox", name: "Search", index: 0, tag: "", selector: "" }, value: "{{query}}", submit: true, secret: false },
      { kind: "type", url: "https://shop.example/login", label: "Pass", target: { role: "textbox", name: "Password", index: 0, tag: "", selector: "" }, secret: true },
    ];
    const agentFlow = a.flows.create("Reorder", "https://shop.example/", steps, { origin: "agent", sourceRunId: "run-1", description: "Search and buy", params: [{ name: "query", label: "Query", default: "umbrella" }] })!;
    const recorded = a.flows.create("Recorded", "https://shop.example/", steps.slice(0, 2))!;
    a.flows.recordRun(agentFlow.id, { status: "ok", by: "agent" });
    a.flows.recordRun(agentFlow.id, { status: "ok", by: "user" });
    const target = (role: string, name: string) => ({ role, name, index: 0, tag: "", selector: "" });
    const shopRun: TrailEvent[] = [
      { type: "action", ok: true, action: { kind: "navigate", url: "https://shop.example/" } },
      { type: "action", ok: true, action: { kind: "click", url: "https://shop.example/", target: target("button", "Accept all") } },
      { type: "action", ok: true, action: { kind: "type", url: "https://shop.example/", target: target("textbox", "Username"), value: "alice", submit: false, secret: false } },
      { type: "action", ok: true, action: { kind: "type", url: "https://shop.example/", target: target("searchbox", "Search products"), value: "umbrella", submit: true, secret: false } },
      { type: "action", ok: true, action: { kind: "click", url: "https://shop.example/", target: target("button", "Add to cart") } },
    ];
    a.memory.learn(shopRun, true);

    await a.sync();
    await b.sync();
    await a.sync();
    expect(await b.sync()).toEqual(QUIET);
    expect(await a.sync()).toEqual(QUIET);

    // Both workflows (agent and recorded) arrive, with usage and without any secret.
    expect(b.flows.list().map((f) => f.name).sort()).toEqual(["Recorded", "Reorder"]);
    expect(b.flows.get(agentFlow.id)).toMatchObject({ origin: "agent", sourceRunId: "run-1", usage: { runs: 2, ok: 2 } });
    expect(b.flows.get(agentFlow.id)!.steps[2]).toMatchObject({ secret: true });
    expect(b.flows.get(agentFlow.id)!.steps[2]!.value).toBeUndefined();
    // Site memory arrives without the credential-like field or any typed value.
    const learned = b.memory.get("shop.example")!;
    expect(learned.targets.map((t) => t.name).sort()).toEqual(["Accept all", "Add to cart", "Search products"]);
    expect(JSON.stringify(learned)).not.toMatch(/alice|umbrella|Username/);

    // Edits, runs and learning on B merge back: last writer wins, counts add up once.
    await new Promise((r) => setTimeout(r, 5));
    b.flows.rename(recorded.id, "Recorded (renamed on B)");
    b.flows.recordRun(agentFlow.id, { status: "failed", by: "user", error: "Step 2 broke", brokenStep: 1 });
    b.memory.learn(shopRun, true);
    await b.sync();
    await a.sync();
    await b.sync();
    expect(await a.sync()).toEqual(QUIET);
    for (const d of [a, b]) {
      expect(d.flows.get(recorded.id)?.name).toBe("Recorded (renamed on B)");
      expect(d.flows.get(agentFlow.id)!.usage).toMatchObject({ runs: 3, ok: 2, failed: 1, lastStatus: "failed", lastBrokenStep: 1 });
      expect(d.memory.get("shop.example")!.targets.find((t) => t.name === "Add to cart")!.ok).toBe(2);
      expect(d.memory.get("shop.example")!.runs).toBe(2);
    }

    // A third device joins, then goes offline with the old data.
    const stale = new Device("Old phone", "Work");
    await stale.client.register();
    await stale.sync();
    expect(stale.flows.get(agentFlow.id)).toBeDefined();
    expect(stale.memory.get("shop.example")).toBeDefined();
    // While offline it learns about another site, before the "Forget everything" below.
    stale.memory.learn(
      [
        { type: "action", ok: true, action: { kind: "navigate", url: "https://old.example/" } },
        { type: "action", ok: true, action: { kind: "click", url: "https://old.example/", target: target("link", "Next") } },
      ],
      true,
    );

    // Deletes and forgets on one device reach the others.
    await new Promise((r) => setTimeout(r, 5));
    a.flows.remove(agentFlow.id);
    const cart = b.memory.get("shop.example")!.targets.find((t) => t.name === "Add to cart")!;
    b.memory.removeHint("shop.example", "target", hintKey("target", cart));
    await a.sync();
    await b.sync();
    await a.sync();
    expect(b.flows.get(agentFlow.id)).toBeUndefined();
    expect(a.memory.get("shop.example")!.targets.map((t) => t.name)).not.toContain("Add to cart");

    b.memory.forgetAll();
    await new Promise((r) => setTimeout(r, 5));
    await b.sync();
    await a.sync();
    expect(a.memory.list()).toEqual([]);

    // The stale device comes back: it receives the deletions and nothing old comes back anywhere.
    await stale.sync();
    await a.sync();
    await b.sync();
    expect(stale.flows.get(agentFlow.id)).toBeUndefined();
    expect(stale.memory.list()).toEqual([]);
    expect(a.memory.list()).toEqual([]);
    expect(b.memory.list()).toEqual([]);
    expect(a.flows.list().map((f) => f.id)).toEqual([recorded.id]);

    // Learning after the wipe syncs as usual.
    stale.memory.learn(shopRun, true);
    await stale.sync();
    await a.sync();
    expect(a.memory.get("shop.example")!.targets.find((t) => t.name === "Add to cart")!.ok).toBe(1);
    expect(await stale.sync()).toMatchObject({ pushed: 0, deleted: 0 });

    for (const d of [a, b, stale]) d.close();
  });

  it("delivers a page sent from the phone to its computer only, and deletes it once it is opened there", async () => {
    const desk = new Device("Desk", "Work");
    const other = new Device("Other", "Work");
    await desk.client.register();
    await other.client.register();
    await desk.sync();
    await other.sync();
    const phone = createSyncClient({ serverUrl, phrase: PHRASE, deviceName: "Phone", platform: "android", storage: memoryStorage() });
    await phone.register();
    await phone.pull();

    const deskId = await desk.client.getDeviceId();
    const page = { url: "https://sent.example/article", title: "An article", to: deskId, fromId: await phone.getDeviceId(), from: "Phone", sentAt: 1 };
    expect(await desk.client.hasNew("sent_tabs")).toBe(false);
    await phone.push([
      { collection: "sent_tabs", id: "sent-page-0001", payload: page, deleted: false },
      { collection: "sent_tabs", id: "sent-bad-00001", payload: { ...page, url: "javascript:alert(1)" }, deleted: false },
    ]);
    // A cheap look at the server notices it without moving anything.
    expect(await desk.client.hasNew("sent_tabs")).toBe(true);
    expect(await desk.client.hasNew("sent_tabs")).toBe(true);

    await desk.sync();
    await other.sync();
    expect(await desk.client.hasNew("sent_tabs")).toBe(false);
    const mine = sentTabs(desk.remote.records("sent_tabs").all(), (t) => t.to === deskId);
    expect(mine.map((t) => [t.id, t.url])).toEqual([["sent-page-0001", "https://sent.example/article"]]);
    // The page for Desk stays on Other untouched (no deletion on Desk's behalf).
    expect(Object.keys(other.remote.records("sent_tabs").all())).toEqual(["sent-page-0001"]);
    expect(await other.sync()).toMatchObject({ deleted: 0 });

    // Desk opens it (SyncService drops the record); the next cycle deletes it on the chain.
    desk.remote.records("sent_tabs").delete("sent-page-0001");
    expect(await desk.sync()).toMatchObject({ deleted: 1 });
    const seen = await phone.pull();
    expect(seen.filter((i) => i.collection === "sent_tabs").map((i) => [i.id, i.deleted])).toEqual([["sent-page-0001", true]]);
    await other.sync();
    expect(other.remote.records("sent_tabs").all()).toEqual({});

    for (const d of [desk, other]) d.close();
  });

  it("monitors a watch added on the phone and publishes what it saw, only when that changes", async () => {
    const desk = new Device("Desk", "Work");
    await desk.client.register();
    await desk.sync();
    const phone = createSyncClient({ serverUrl, phrase: PHRASE, deviceName: "Phone", platform: "android", storage: memoryStorage() });
    await phone.register();
    await phone.pull();

    const url = "https://shop.example/item";
    await phone.push([
      { collection: "watches", id: url, payload: { url, title: "", intervalMinutes: 60, paused: false, createdAt: 5, condition: "the price is under 100" }, deleted: false },
    ]);
    await desk.sync();
    const watch = desk.watches.list().find((w) => w.url === url);
    expect(watch).toMatchObject({ intervalMinutes: 60, condition: "the price is under 100", lastResult: "pending" });

    // The monitor checks it (simulated): the next sync publishes the result for the phone.
    desk.watches.update(watch!.id, { lastCheckedAt: 100, lastChangedAt: 100, lastResult: "changed", changeSummary: "Price dropped to 89", conditionMet: true, conditionDetail: "Price: 89" });
    await desk.sync();
    const deskId = await desk.client.getDeviceId();
    const published = (await phone.pull()).filter((i) => i.collection === "watch_status" && i.id === deskId);
    const status = parseDeviceWatchStatus(published[published.length - 1]?.payload);
    expect(status?.device).toBe("Desk");
    expect(status?.watches.find((w) => w.url === url)).toEqual({
      url,
      lastCheckedAt: 100,
      lastChangedAt: 100,
      result: "changed",
      summary: "Price dropped to 89",
      conditionMet: true,
      conditionDetail: "Price: 89",
    });
    // Nothing changed since: no new record.
    expect(await desk.sync()).toMatchObject({ pushed: 0 });
    desk.close();
  });

  it("keeps a change another device replaced, and brings it back as a new change", async () => {
    const a = new Device("Conflict laptop", "Work");
    const b = new Device("Conflict desktop", "Work");
    await a.client.register();
    await b.client.register();
    const mark = a.bookmarks.create({ parentId: BAR_FOLDER_ID, kind: "bookmark", title: "Raven", url: "https://raven.example/" });
    await a.sync();
    await b.sync();
    // Two themes, both different from the one the chain already has.
    const [laptopTheme, desktopTheme] = (["light", "dark", "system"] as const).filter((x) => x !== b.settings.get().appearance.theme);
    expect(b.bookmarks.list().find((x) => x.id === mark.id)?.title).toBe("Raven");
    b.conflicts.clear();

    // Both edit the bookmark (the laptop later, so its edit is newer) and the theme; the laptop
    // syncs first. Bookmarks keep the newer edit and settings the first one synced: both win there.
    b.bookmarks.update(mark.id, { title: "Raven (desktop)" });
    await new Promise((r) => setTimeout(r, 5));
    a.bookmarks.update(mark.id, { title: "Raven (laptop)" });
    a.settings.update({ appearance: { theme: laptopTheme! } });
    await a.sync();
    b.settings.update({ appearance: { theme: desktopTheme! } });
    await b.sync();

    expect(b.bookmarks.list().find((x) => x.id === mark.id)?.title).toBe("Raven (laptop)");
    expect(b.settings.get().appearance.theme).toBe(laptopTheme);
    const kept = b.conflicts.list();
    expect(kept.map((c) => `${c.collection}:${c.recordId}`).sort()).toEqual([`bookmarks:${mark.id}`, "settings:appearance.theme"]);
    const bookmark = kept.find((c) => c.collection === "bookmarks")!;
    expect(conflictView(bookmark)).toMatchObject({
      name: "Raven (desktop)",
      local: "Raven (desktop) — https://raven.example/",
      remote: "Raven (laptop) — https://raven.example/",
    });
    expect(conflictView(kept.find((c) => c.collection === "settings")!)).toMatchObject({ name: "appearance.theme", local: JSON.stringify(desktopTheme), remote: JSON.stringify(laptopTheme) });

    // "Use this device's version": written through the adapter as a new change, it syncs and wins.
    const taken = b.conflicts.take(bookmark.id)!;
    await b.adapters.bookmarks!.apply([{ collection: "bookmarks", id: taken.recordId, payload: freshVersion(taken.local, Date.now()), deleted: false }]);
    await b.sync();
    await a.sync();
    expect(a.bookmarks.list().find((x) => x.id === mark.id)?.title).toBe("Raven (desktop)");
    expect(a.conflicts.list()).toEqual([]);
    expect(b.conflicts.list().map((c) => c.collection)).toEqual(["settings"]);

    // A newer edit here that the store keeps is no conflict: it simply syncs.
    a.bookmarks.update(mark.id, { title: "Raven (older)" });
    await a.sync();
    await new Promise((r) => setTimeout(r, 5));
    b.bookmarks.update(mark.id, { title: "Raven (newest)" });
    await b.sync();
    await a.sync();
    expect(b.conflicts.list().map((c) => c.collection)).toEqual(["settings"]);
    expect(a.bookmarks.list().find((x) => x.id === mark.id)?.title).toBe("Raven (newest)");
    a.close();
    b.close();
  });

  it("syncs the Command Bar history both ways, and clearing it on one device clears it on the other", async () => {
    const a = new Device("History laptop", "Work");
    const b = new Device("History desktop", "Work");
    await a.client.register();
    await b.client.register();
    await a.sync();
    await b.sync();
    a.commands.clear();
    b.commands.clear();
    await a.sync();
    await b.sync();

    a.commands.add("agent", "Find a quiet café near the office");
    // A later time, so the order does not depend on random ids.
    await new Promise((r) => setTimeout(r, 5));
    a.commands.add("search", "raven lifespan");
    await a.sync();
    await b.sync();
    expect(b.commands.list().map((r) => [r.kind, r.text])).toEqual([
      ["search", "raven lifespan"],
      ["agent", "Find a quiet café near the office"],
    ]);

    // The same search again on the desktop is one entry everywhere, under its new time.
    await new Promise((r) => setTimeout(r, 5));
    b.commands.add("search", "Raven lifespan");
    await b.sync();
    await a.sync();
    expect(a.commands.list().map((r) => r.text)).toEqual(["Raven lifespan", "Find a quiet café near the office"]);

    b.commands.clear();
    await b.sync();
    await a.sync();
    expect(a.commands.list()).toEqual([]);
    a.close();
    b.close();
  });
});
