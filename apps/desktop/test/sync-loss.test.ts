import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SyncStateStorage } from "@corvus/shared";
import { SyncEngine, createSyncClient } from "@corvus/sync-core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { buildServer } from "../../../services/sync-server/src/app";
import { AddressVault } from "../src/main/address-store";
import { AnnotationStore } from "../src/main/annotation-store";
import { AssistHistoryStore } from "../src/main/assist-history-store";
import { CardVault } from "../src/main/card-store";
import { CommandHistoryStore } from "../src/main/command-history-store";
import { CredentialVault } from "../src/main/credential-store";
import { FlowStore } from "../src/main/flow-store";
import { ReadingStore } from "../src/main/reading-store";
import { SettingsStore, type SecretCipher } from "../src/main/settings-store";
import { BookmarkStore, HistoryStore } from "../src/main/stores";
import { SyncLossGuard, SyncRemoteStore, createSyncAdapters } from "../src/main/sync-adapters";
import { WatchStore } from "../src/main/watch-store";
import { WorkspaceStore } from "../src/main/workspace-store";
import { BAR_FOLDER_ID, ROOT_IDS } from "../src/shared/bookmark-tree";

const PHRASE = `${"abandon ".repeat(23)}art`;

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

/** One start of Corvus on a device: its stores read from `dir`, its sync state kept in `state`. */
class Run {
  readonly bookmarks: BookmarkStore;
  readonly history: HistoryStore;
  readonly credentials: CredentialVault;
  readonly remote: SyncRemoteStore;
  readonly guard = new SyncLossGuard();
  readonly engine: SyncEngine;
  readonly client: ReturnType<typeof createSyncClient>;

  constructor(
    readonly dir: string,
    state: { client: SyncStateStorage; engine: SyncStateStorage },
  ) {
    this.bookmarks = new BookmarkStore(dir);
    this.history = new HistoryStore(dir);
    this.credentials = new CredentialVault(dir, cipher);
    this.remote = new SyncRemoteStore(path.join(dir, "sync-remote.json"));
    const client = (this.client = createSyncClient({ serverUrl, phrase: PHRASE, deviceName: path.basename(dir), platform: "linux", storage: state.client }));
    const adapters = createSyncAdapters({
      bookmarks: this.bookmarks,
      history: this.history,
      credentials: this.credentials,
      addresses: new AddressVault(dir, cipher),
      cards: new CardVault(dir, cipher),
      reading: new ReadingStore(dir),
      watches: new WatchStore(dir, () => 100),
      workspaces: new WorkspaceStore(dir),
      annotations: new AnnotationStore(dir),
      workflows: new FlowStore(dir),
      commands: new CommandHistoryStore(dir),
      assistHistory: new AssistHistoryStore(dir),
      settings: new SettingsStore(dir, cipher, {}),
      includeServiceUrls: () => false,
      profile: { get: () => ({ name: "Me" }), set: () => undefined },
      remote: this.remote,
      lossGuard: this.guard,
      ownDeviceId: () => client.getDeviceId(),
      openTabs: () => ({ device: "x", platform: "linux", tabs: [], updatedAt: 1 }),
      extensions: () => ({ device: "x", extensions: [] }),
      watchStatus: () => ({ device: "x", platform: "linux", watches: [], updatedAt: 1 }),
    });
    this.engine = new SyncEngine({ client, storage: state.engine, adapters });
  }

  /** One cycle, settled the way SyncService settles a successful one. */
  async sync(): Promise<void> {
    await this.engine.sync();
    this.guard.settle();
  }

  close(): void {
    this.bookmarks.flush();
    this.history.flush();
    this.credentials.flush();
  }

  bookmarkTitles(): string[] {
    return this.bookmarks
      .list()
      .filter((b) => !ROOT_IDS.has(b.id))
      .map((b) => b.title)
      .sort();
  }
}

function device(): { dir: string; state: { client: SyncStateStorage; engine: SyncStateStorage } } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "corvus-sync-loss-"));
  dirs.push(dir);
  return { dir, state: { client: memoryStorage(), engine: memoryStorage() } };
}

describe("a store file lost on one device", () => {
  it("never deletes its records on the other devices, and later deletions still sync", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const laptop = device();
    const phone = device();
    const a = new Run(laptop.dir, laptop.state);
    const b = new Run(phone.dir, phone.state);
    await a.client.register();
    await b.client.register();

    a.bookmarks.create({ parentId: BAR_FOLDER_ID, kind: "bookmark", title: "Corvus", url: "https://corvus.example/" });
    a.bookmarks.create({ parentId: BAR_FOLDER_ID, kind: "bookmark", title: "News", url: "https://news.example/" });
    a.history.recordVisit("https://corvus.example/", "Corvus");
    a.credentials.add({ origin: "https://login.example", username: "user@example.com", password: "s3cret-pass" });
    await a.sync();
    await b.sync();
    expect(b.bookmarkTitles()).toEqual(["Corvus", "News"]);
    expect(b.credentials.all()).toHaveLength(1);
    a.close();

    // The laptop starts again with its bookmarks, history and logins files damaged.
    for (const file of ["bookmarks.json", "history.json", "credentials.json"]) fs.writeFileSync(path.join(laptop.dir, file), "{");
    const a2 = new Run(laptop.dir, laptop.state);
    expect(a2.bookmarkTitles()).toEqual([]);
    await a2.sync();
    await b.sync();
    expect(b.bookmarkTitles()).toEqual(["Corvus", "News"]);
    expect(b.history.all().map((e) => e.url)).toEqual(["https://corvus.example/"]);
    expect(b.credentials.all()).toHaveLength(1);

    // Once a cycle went through, what the laptop deletes is deleted everywhere again.
    const fresh = a2.bookmarks.create({ parentId: BAR_FOLDER_ID, kind: "bookmark", title: "Later", url: "https://later.example/" });
    await a2.sync();
    await b.sync();
    expect(b.bookmarkTitles()).toEqual(["Corvus", "Later", "News"]);
    a2.bookmarks.remove(fresh.id);
    await a2.sync();
    await b.sync();
    expect(b.bookmarkTitles()).toEqual(["Corvus", "News"]);
  });

  it("keeps on the chain a login the vault holds but cannot read", () => {
    const guard = new SyncLossGuard();
    const store = { loadedFresh: false, isUnreadable: (id: string) => id === "damaged" };
    const retain = guard.retain(store);
    expect(retain("damaged")).toBe(true);
    expect(retain("deleted")).toBe(false);
    guard.settle();
    expect(retain("damaged")).toBe(true);
  });

  it("a store that started from nothing retains until the first cycle went through", () => {
    const guard = new SyncLossGuard();
    const retain = guard.retain({ loadedFresh: true }, (id) => id === "own-rule");
    expect(retain("any")).toBe(true);
    guard.settle();
    expect(retain("any")).toBe(false);
    expect(retain("own-rule")).toBe(true);
  });
});
