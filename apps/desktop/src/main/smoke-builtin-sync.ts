import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CHAIN_SERVER_ID, OTHER_FOLDER_ID, chainServerMove, decodePairing, isLoopbackUrl, linkOnlyReadingItem, type SyncStateStorage } from "@corvus/shared";
import { createSyncClient, type CorvusSyncClient } from "@corvus/sync-core";
import type { AppContext } from "./context";
import { LocalSyncServer } from "./local-sync-server";

type Check = (name: string, ok: boolean, detail?: unknown) => void;

function memory(): SyncStateStorage {
  const data = new Map<string, string>();
  return { get: async (k) => data.get(k), set: async (k, v) => void data.set(k, v) };
}

/** The phone as sync-core sees it: a client on `serverUrl` with its own storage. */
function phoneOn(serverUrl: string, phrase: string, storage: SyncStateStorage): CorvusSyncClient {
  return createSyncClient({ serverUrl, phrase, deviceName: "Smoke built-in phone", platform: "android", storage, requestTimeoutMs: 10_000 });
}

async function chainServerOf(client: CorvusSyncClient): Promise<unknown> {
  return (await client.pull()).find((i) => i.collection === "chain_server" && i.id === CHAIN_SERVER_ID && !i.deleted)?.payload;
}

/**
 * The sync server built into Corvus ("This computer"), always (it needs nothing outside the app):
 * turning sync on starts it, a phone pairs with the code's network address and syncs both ways, the
 * chain moves to an own server (another server process here) with the phone following, and back.
 */
export async function runBuiltinSyncSmoke(ctx: AppContext, pageUrl: string, check: Check, capture: (name: string, wc: Electron.WebContents) => Promise<void>): Promise<void> {
  const win = ctx.windows.target();
  const profile = win.profile;
  const phrase = await ctx.sync.generatePhrase();
  const on = await ctx.sync.enable(profile, { mode: "local", phrase, deviceName: "Smoke built-in laptop" });
  const local = on.localServer;
  check(
    "built-in sync: turning sync on starts the server on this computer, on its loopback for Corvus itself",
    on.enabled && on.mode === "local" && local?.running === true && local.port !== null && isLoopbackUrl(on.serverUrl) && on.error === null,
    { mode: on.mode, serverUrl: on.serverUrl, local, error: on.error },
  );
  const ownServer = new LocalSyncServer(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "corvus-own-server-")), "sync.db"));
  try {
    const pairing = await ctx.sync.pairingCode(profile);
    const code = decodePairing(pairing.code);
    const lan = code !== null && !isLoopbackUrl(code.serverUrl);
    check("built-in sync: the pairing code carries this computer's network address, which answers", lan && pairing.lanOnly && pairing.reachable, {
      serverUrl: code?.serverUrl,
      reachable: pairing.reachable,
    });
    if (!code || !lan) return;

    const phoneStorage = memory();
    const phone = phoneOn(code.serverUrl, code.phrase, phoneStorage);
    await phone.register();
    const phoneUrl = `${pageUrl}${pageUrl.includes("?") ? "&" : "?"}from-builtin-phone=1`;
    await phone.push([{ collection: "reading", id: phoneUrl, payload: linkOnlyReadingItem("builtin-1", phoneUrl, "Saved on the built-in phone", Date.now()), deleted: false }]);
    const bookmark = profile.bookmarks.create({ parentId: OTHER_FOLDER_ID, kind: "bookmark", title: "Built-in smoke bookmark", url: `${pageUrl}#builtin` });
    await ctx.sync.syncNow(profile);
    const arrived = profile.reading.allItems().some((i) => i.url === phoneUrl);
    const pulled = await phone.pull();
    const record = pulled.find((i) => i.collection === "chain_server" && i.id === CHAIN_SERVER_ID && !i.deleted)?.payload;
    const reached = (await ctx.sync.status(profile)).localServer?.lastClient;
    check(
      "built-in sync: a phone on the network address syncs both ways, and Settings sees it reach this computer",
      arrived && pulled.some((i) => i.collection === "bookmarks" && i.id === bookmark.id) && reached !== null && reached !== undefined,
      { arrived, pulledBookmark: pulled.some((i) => i.id === bookmark.id), reached },
    );
    check(
      "built-in sync: the chain tells the phone this computer's addresses (nothing to follow)",
      chainServerMove(record, code.serverUrl, await phone.getDeviceId()) === null && JSON.stringify(record ?? null).includes(new URL(code.serverUrl).host),
      record,
    );

    const settings = win.createTab("corvus://settings#sync");
    await new Promise((r) => setTimeout(r, 1500));
    await capture("settings-sync-builtin", settings.view.webContents);

    // Your own server: the same server code in another process, reached on this machine's network address.
    const ownPort = await ownServer.start(null);
    const ownUrl = `${new URL(code.serverUrl).protocol}//${new URL(code.serverUrl).hostname}:${ownPort}`;
    const check1 = await ctx.sync.checkServer(ownUrl);
    const moved = await ctx.sync.moveChain(profile, { mode: "custom", serverUrl: ownUrl });
    check(
      "move chain: to your own server (Check answers), the old server keeps answering for devices to follow",
      check1.ok && moved.mode === "custom" && moved.serverUrl === ownUrl && moved.error === null && moved.localServer?.retiringUntil !== null && moved.lastSyncAt !== null,
      { check: check1, mode: moved.mode, serverUrl: moved.serverUrl, notice: moved.notice, error: moved.error, retiring: moved.localServer?.retiringUntil },
    );
    const follow = chainServerMove(await chainServerOf(phone), code.serverUrl, await phone.getDeviceId());
    const followed = follow?.[0] ? phoneOn(follow[0], code.phrase, phoneStorage) : null;
    await followed?.register();
    // As the app does when it follows: the cursor and versions were the old server's.
    await followed?.resetLocalState();
    const onOwn = followed ? await followed.pull() : [];
    check(
      "move chain: the phone reads the new address on the old server and finds everything on the new one",
      follow?.[0] === ownUrl && onOwn.some((i) => i.collection === "bookmarks" && i.id === bookmark.id) && onOwn.some((i) => i.collection === "reading" && i.id === phoneUrl),
      { follow, items: onOwn.length },
    );

    const back = await ctx.sync.moveChain(profile, { mode: "local" });
    const home = followed ? chainServerMove(await chainServerOf(followed), ownUrl, await followed.getDeviceId()) : null;
    const again = home?.[0] ? phoneOn(home[0], code.phrase, phoneStorage) : null;
    await again?.register();
    await again?.resetLocalState();
    const onLocal = again ? await again.pull() : [];
    check(
      "move chain: back to this computer, and the phone follows from the own server",
      back.mode === "local" && isLoopbackUrl(back.serverUrl) && back.localServer?.retiringUntil === null && Boolean(home?.includes(code.serverUrl)) && onLocal.some((i) => i.id === bookmark.id),
      { mode: back.mode, home, items: onLocal.length, error: back.error },
    );
    profile.bookmarks.remove(bookmark.id);
    win.closeTab(settings.id);
  } catch (err) {
    check("built-in sync", false, (err as Error).stack ?? String(err));
  } finally {
    await ownServer.stop();
    const off = await ctx.sync.disable(profile);
    check("built-in sync: turning sync off", !off.enabled, { enabled: off.enabled });
  }
}
