import { describe, expect, it } from "vitest";
import { registerDownloadApis, type DownloadsAccess } from "../src/main/extension-apis";
import type { RouterCallback } from "../src/main/extensions";
import { DownloadIdMap, downloadEvents, searchDownloads, toDownloadItem, toDownloadQuery } from "../src/shared/chrome-downloads";
import { downloadStatus, safeDownloadPath, type DownloadAction, type DownloadRecord } from "../src/shared/downloads";

const T0 = Date.UTC(2026, 9, 25, 12);

function record(id: string, patch: Partial<DownloadRecord> = {}): DownloadRecord {
  return {
    id,
    url: `https://files.example/${id}.zip`,
    filename: `${id}.zip`,
    savePath: `/home/me/Downloads/${id}.zip`,
    mime: "application/zip",
    totalBytes: 2048,
    receivedBytes: 1024,
    state: "progressing",
    startedAt: T0,
    agent: false,
    canResume: true,
    ...patch,
  };
}

describe("chrome.downloads items", () => {
  it("maps Corvus's states to Chrome's", () => {
    expect(toDownloadItem(record("a"), 1)).toMatchObject({ id: 1, state: "in_progress", paused: false, danger: "safe", exists: false, startTime: new Date(T0).toISOString() });
    expect(toDownloadItem(record("a", { state: "paused" }), 1)).toMatchObject({ state: "in_progress", paused: true });
    expect(toDownloadItem(record("a", { state: "completed", receivedBytes: 2048, endedAt: T0 + 5000 }), 1)).toMatchObject({
      state: "complete",
      exists: true,
      fileSize: 2048,
      endTime: new Date(T0 + 5000).toISOString(),
    });
    expect(toDownloadItem(record("a", { state: "cancelled" }), 1)).toMatchObject({ state: "interrupted", error: "USER_CANCELED" });
    expect(toDownloadItem(record("a", { state: "interrupted" }), 1)).toMatchObject({ state: "interrupted", error: "NETWORK_FAILED" });
    expect(toDownloadItem(record("a", { state: "blocked", extensionId: "ext" }), 1)).toMatchObject({ state: "in_progress", danger: "file", byExtensionId: "ext" });
  });

  it("keeps one number per download", () => {
    const ids = new DownloadIdMap();
    expect(ids.number("x")).toBe(1);
    expect(ids.number("y")).toBe(2);
    expect(ids.number("x")).toBe(1);
    expect(ids.id(2)).toBe("y");
    expect(ids.id(9)).toBeUndefined();
  });

  it("searches like chrome.downloads.search", () => {
    const items = [
      toDownloadItem(record("old", { startedAt: T0 - 1000, state: "completed" }), 1),
      toDownloadItem(record("new", { startedAt: T0 + 1000, mime: "application/pdf", url: "https://docs.example/new.pdf", savePath: "/d/new.pdf" }), 2),
      toDownloadItem(record("mid"), 3),
    ];
    expect(searchDownloads(items, {}).map((d) => d.id)).toEqual([2, 3, 1]);
    expect(searchDownloads(items, { orderBy: ["startTime"] }).map((d) => d.id)).toEqual([1, 3, 2]);
    expect(searchDownloads(items, { limit: 1 }).map((d) => d.id)).toEqual([2]);
    expect(searchDownloads(items, { state: "complete" }).map((d) => d.id)).toEqual([1]);
    expect(searchDownloads(items, { query: ["docs.example"] }).map((d) => d.id)).toEqual([2]);
    expect(searchDownloads(items, { query: ["-docs.example"] }).map((d) => d.id)).toEqual([3, 1]);
    expect(searchDownloads(items, { urlRegex: "files\\.example/(old|mid)" }).map((d) => d.id)).toEqual([3, 1]);
    expect(searchDownloads(items, { mime: "application/pdf" }).map((d) => d.id)).toEqual([2]);
    expect(() => searchDownloads(items, { filenameRegex: "(" })).toThrow("Invalid regular expression");
  });

  it("reads only the query fields Chrome knows", () => {
    expect(toDownloadQuery({ id: 3, query: ["a", 1], state: "complete", paused: false, evil: true, limit: "5" })).toEqual({ id: 3, query: ["a"], state: "complete", paused: false });
    expect(toDownloadQuery(null)).toEqual({});
  });

  it("turns list changes into onCreated, onChanged and onErased", () => {
    const before = [toDownloadItem(record("a"), 1), toDownloadItem(record("b"), 2)];
    const after = [
      toDownloadItem(record("a", { state: "completed", receivedBytes: 2048 }), 1),
      toDownloadItem(record("c"), 3),
    ];
    const events = downloadEvents(before, after);
    expect(events.map((e) => e.event)).toEqual(["onChanged", "onCreated", "onErased"]);
    expect(events[0]!.args[0]).toMatchObject({ id: 1, state: { previous: "in_progress", current: "complete" }, exists: { previous: false, current: true } });
    expect(events[2]!.args).toEqual([2]);
    // Progress alone is not an event.
    expect(downloadEvents(before, [toDownloadItem(record("a", { receivedBytes: 1500 }), 1), before[1]!])).toEqual([]);
  });

  it("keeps the names extensions suggest inside the downloads folder", () => {
    expect(safeDownloadPath("report.pdf")).toBe("report.pdf");
    expect(safeDownloadPath("reports/./2026\\q3.pdf")).toBe("reports/2026/q3.pdf");
    for (const bad of ["", "/etc/passwd", "C:\\Windows\\x.dll", "../up.txt", "a/../../b", "a:b.txt", "bad\u0001name"]) expect(safeDownloadPath(bad)).toBeNull();
  });

  it("says who a blocked program came from", () => {
    expect(downloadStatus(record("a", { state: "blocked" }))).toBe("Blocked: an AI agent tried to download a program");
    expect(downloadStatus(record("a", { state: "blocked", extensionId: "ext" }))).toBe("Blocked: an extension tried to download a program");
  });
});

/** The extension host and download manager, faked. */
function setup(initial: DownloadRecord[] = []) {
  const handlers = new Map<string, { cb: RouterCallback; permission?: string }>();
  const events: Array<{ permission: string; event: string; args: unknown[] }> = [];
  const acts: Array<[string, DownloadAction]> = [];
  const started: Array<{ extensionId: string; url: string; opts: unknown }> = [];
  let list = initial;
  let changed: (before: readonly DownloadRecord[], after: readonly DownloadRecord[]) => void = () => {};
  const access: DownloadsAccess = {
    list: () => list,
    download: async (extensionId, url, opts) => {
      started.push({ extensionId, url, opts });
      return "started";
    },
    act: (id, action) => void acts.push([id, action]),
    showDefaultFolder: () => {},
    fileIcon: async (file, size) => `icon:${file}:${size}`,
    onChange: (listener) => {
      changed = listener;
    },
  };
  registerDownloadApis(
    {
      handle: (name, cb, permission) => void handlers.set(name, { cb, ...(permission ? { permission } : {}) }),
      emit: (permission, event, ...args) => void events.push({ permission, event, args }),
    },
    access,
  );
  const call = async (name: string, ...args: unknown[]): Promise<unknown> => {
    const h = handlers.get(name);
    if (!h) throw new Error(`no handler ${name}`);
    return h.cb({ type: "frame", extension: { id: "ext" } } as never, ...args);
  };
  const set = (next: DownloadRecord[]): void => {
    const before = list;
    list = next;
    changed(before, next);
  };
  return { handlers, events, acts, started, call, set };
}

describe("chrome.downloads for extensions", () => {
  it("sits behind the downloads permissions", () => {
    const { handlers } = setup();
    expect(handlers.get("downloads.download")?.permission).toBe("downloads");
    expect(handlers.get("downloads.open")?.permission).toBe("downloads.open");
    expect(handlers.get("downloads.setUiOptions")?.permission).toBe("downloads.ui");
  });

  it("starts downloads for the extension and answers with a number", async () => {
    const api = setup();
    const id = await api.call("downloads.download", { url: "https://files.example/a.zip", filename: "sub/a.zip", saveAs: false });
    expect(id).toBe(1);
    expect(api.started).toEqual([{ extensionId: "ext", url: "https://files.example/a.zip", opts: { filename: "sub/a.zip", saveAs: false } }]);
    await expect(api.call("downloads.download", { url: "https://files.example/a", method: "POST" })).rejects.toThrow("Only GET downloads");
    await expect(api.call("downloads.download", { url: "https://files.example/a", headers: [{ name: "X", value: "1" }] })).rejects.toThrow("Only GET downloads");
    await expect(api.call("downloads.download", {})).rejects.toThrow("Invalid URL.");
  });

  it("pauses, resumes, cancels and erases through the download manager", async () => {
    const api = setup([record("run"), record("held", { state: "paused" }), record("done", { state: "completed" }), record("prog", { state: "blocked", filename: "x.exe" })]);
    const items = (await api.call("downloads.search", {})) as Array<{ id: number; url: string }>;
    const num = (id: string): number => items.find((d) => d.url.includes(`/${id}.`))!.id;
    await api.call("downloads.pause", num("run"));
    await api.call("downloads.resume", num("held"));
    await api.call("downloads.cancel", num("prog"));
    await api.call("downloads.cancel", num("done"));
    await expect(api.call("downloads.pause", num("done"))).rejects.toThrow("Download must be in progress");
    await expect(api.call("downloads.pause", 999)).rejects.toThrow("Invalid download id 999");
    expect(api.acts).toEqual([
      ["run", "pause"],
      ["held", "resume"],
      ["prog", "discard"],
    ]);
    expect(await api.call("downloads.erase", { state: "complete" })).toEqual([num("done")]);
    expect(api.acts.at(-1)).toEqual(["done", "remove"]);
  });

  it("never opens programs nor keeps blocked ones", async () => {
    const api = setup([record("doc", { state: "completed", filename: "doc.pdf" }), record("tool", { state: "completed", filename: "tool.exe" }), record("prog", { state: "blocked", filename: "y.msi" })]);
    const items = (await api.call("downloads.search", {})) as Array<{ id: number; url: string }>;
    const num = (id: string): number => items.find((d) => d.url.includes(`/${id}.`))!.id;
    await api.call("downloads.open", num("doc"));
    await expect(api.call("downloads.open", num("tool"))).rejects.toThrow("Programs are opened by the person");
    await expect(api.call("downloads.acceptDanger", num("prog"))).rejects.toThrow("kept or discarded by the person");
    expect(api.acts).toEqual([["doc", "open"]]);
    expect(await api.call("downloads.getFileIcon", num("doc"), { size: 16 })).toBe("icon:/home/me/Downloads/doc.zip:small");
  });

  it("tells extensions about changes", async () => {
    const api = setup([record("a")]);
    api.set([record("b"), record("a", { state: "completed" })]);
    api.set([record("b")]);
    expect(api.events.map((e) => [e.permission, e.event])).toEqual([
      ["downloads", "downloads.onCreated"],
      ["downloads", "downloads.onChanged"],
      ["downloads", "downloads.onErased"],
    ]);
    expect(api.events[0]!.args[0]).toMatchObject({ url: "https://files.example/b.zip", state: "in_progress" });
  });
});
