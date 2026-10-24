import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BrowserImport } from "../src/main/browser-import";
import { FIXTURE_NOW, writeBrowserFixtures } from "../src/main/smoke-import-fixtures";
import type { ProfileRuntime } from "../src/main/profiles";
import { BookmarkStore, HistoryStore } from "../src/main/stores";
import { WorkspaceStore } from "../src/main/workspace-store";
import {
  browserLocations,
  chromiumProfiles,
  chromiumTime,
  firefoxBookmarkTree,
  firefoxProfiles,
  firefoxTime,
  importableHistory,
  isChromiumProfileDir,
} from "../src/shared/browser-import";

const dirs: string[] = [];
const tempDir = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "corvus-browser-import-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("where browsers keep their profiles", () => {
  it("knows the Windows, macOS and Linux folders", () => {
    const win = browserLocations({ platform: "win32", home: "C:\\Users\\ana", localAppData: "C:\\Users\\ana\\AppData\\Local", appData: "C:\\Users\\ana\\AppData\\Roaming", config: "" });
    expect(win.find((l) => l.id === "chrome")?.dir).toBe("C:\\Users\\ana\\AppData\\Local\\Google\\Chrome\\User Data");
    expect(win.find((l) => l.id === "edge")?.dir).toBe("C:\\Users\\ana\\AppData\\Local\\Microsoft\\Edge\\User Data");
    expect(win.find((l) => l.id === "opera")).toMatchObject({ dir: "C:\\Users\\ana\\AppData\\Roaming\\Opera Software\\Opera Stable", singleProfile: true });
    expect(win.find((l) => l.id === "firefox")).toMatchObject({ family: "firefox", dir: "C:\\Users\\ana\\AppData\\Roaming\\Mozilla\\Firefox" });
    const mac = browserLocations({ platform: "darwin", home: "/Users/ana", localAppData: "", appData: "", config: "" });
    expect(mac.find((l) => l.id === "brave")?.dir).toBe("/Users/ana/Library/Application Support/BraveSoftware/Brave-Browser");
    const linux = browserLocations({ platform: "linux", home: "/home/ana", localAppData: "", appData: "", config: "/home/ana/.config" });
    expect(linux.find((l) => l.id === "chrome")?.dir).toBe("/home/ana/.config/google-chrome");
    expect(linux.filter((l) => l.family === "firefox").map((l) => l.dir)).toEqual([
      "/home/ana/.mozilla/firefox",
      "/home/ana/snap/firefox/common/.mozilla/firefox",
      "/home/ana/.var/app/org.mozilla.firefox/.mozilla/firefox",
    ]);
  });

  it("reads Chromium's profile names and the one used last", () => {
    const state = JSON.stringify({ profile: { info_cache: { "Profile 2": { name: "Work" }, Default: { name: "Personal" }, Gone: { name: "Deleted" } }, last_used: "Profile 2" } });
    expect(chromiumProfiles(state, ["Default", "Profile 2", "Profile 3"])).toEqual([
      { dir: "Profile 2", name: "Work", isDefault: true },
      { dir: "Default", name: "Personal", isDefault: false },
      { dir: "Profile 3", name: "Profile 3", isDefault: false },
    ]);
    expect(chromiumProfiles("not json", ["Default"])).toEqual([{ dir: "Default", name: "Default", isDefault: true }]);
    expect(["Default", "Profile 7", "System Profile", "Guest Profile", "Crashpad"].map(isChromiumProfileDir)).toEqual([true, true, false, false, false]);
  });

  it("reads Firefox's profiles.ini, newer and older", () => {
    const ini = ["[Install308046B0AF4A39CB]", "Default=Profiles/x.default-release", "", "[Profile1]", "Name=default", "IsRelative=1", "Path=Profiles/y.default", "Default=1", "", "[Profile0]", "Name=default-release", "IsRelative=1", "Path=Profiles/x.default-release", "", "[Profile2]", "Name=elsewhere", "IsRelative=0", "Path=/data/ff"].join("\r\n");
    expect(firefoxProfiles(ini)).toEqual([
      { name: "default", path: "Profiles/y.default", relative: true, isDefault: false },
      { name: "default-release", path: "Profiles/x.default-release", relative: true, isDefault: true },
      { name: "elsewhere", path: "/data/ff", relative: false, isDefault: false },
    ]);
    expect(firefoxProfiles("[Profile0]\nName=a\nIsRelative=1\nPath=a\nDefault=1\n")[0]?.isDefault).toBe(true);
  });
});

describe("browser data", () => {
  it("converts Chromium and Firefox times", () => {
    expect(chromiumTime(13_400_000_000_000_000)).toBe(1_755_526_400_000);
    expect(chromiumTime(13_400_000_000_000_000n)).toBe(1_755_526_400_000);
    expect(firefoxTime(1_700_000_000_000_000)).toBe(1_700_000_000_000);
  });

  it("builds Firefox's bookmark tree under its built-in folders", () => {
    const rows = [
      { id: 10, parent: 3, type: 1, title: "MDN", url: "https://mdn.example/", position: 1 },
      { id: 11, parent: 3, type: 2, title: "Reading", url: null, position: 0 },
      { id: 12, parent: 11, type: 1, title: null, url: "https://read.example/", position: 0 },
      { id: 13, parent: 2, type: 1, title: "Smart", url: "place:sort=8", position: 0 },
      { id: 14, parent: 5, type: 3, title: "", url: null, position: 0 },
    ];
    expect(firefoxBookmarkTree(rows, { menu________: 2, toolbar_____: 3, unfiled_____: 5 })).toEqual([
      {
        title: "Bookmarks Toolbar",
        children: [
          { title: "Reading", children: [{ title: "https://read.example/", url: "https://read.example/" }] },
          { title: "MDN", url: "https://mdn.example/" },
        ],
      },
    ]);
  });

  it("keeps the newest web pages of a history", () => {
    const rows = [
      { url: "https://a.example/", visitedAt: 10 },
      { url: "chrome://settings", visitedAt: 30 },
      { url: "https://b.example/", visitedAt: 20 },
      { url: "https://c.example/", visitedAt: 0 },
    ];
    expect(importableHistory(rows, 5).map((r) => r.url)).toEqual(["https://b.example/", "https://a.example/"]);
    expect(importableHistory(rows, 1)).toHaveLength(1);
  });
});

describe("BrowserImport", () => {
  it("finds the browsers and profiles, counts them, and imports bookmarks and history into Corvus", async () => {
    const roots = writeBrowserFixtures(tempDir());
    const service = new BrowserImport();
    service.setTestRoots(roots);
    const scan = await service.scan();
    expect(scan.sources.map((s) => ({ id: s.id, profiles: s.profiles.map((p) => ({ dir: p.dir, name: p.name, isDefault: p.isDefault, counts: p.counts })) }))).toEqual([
      {
        id: "chrome",
        profiles: [
          { dir: "Default", name: "Personal", isDefault: true, counts: { bookmarks: 3, history: 2, tabs: 3 } },
          { dir: "Profile 1", name: "Work", isDefault: false, counts: { bookmarks: 1, history: 0, tabs: 0 } },
        ],
      },
      { id: "firefox", profiles: [{ dir: "abcd1234.default-release", name: "default-release", isDefault: true, counts: { bookmarks: 2, history: 1, tabs: 1 } }] },
    ]);

    const data = tempDir();
    const runtime = { bookmarks: new BookmarkStore(data), history: new HistoryStore(data), workspaces: new WorkspaceStore(data) } as unknown as ProfileRuntime;
    const chrome = await service.run(runtime, "chrome", "Default", ["bookmarks", "history"]);
    expect(chrome).toEqual({ bookmarks: { imported: 3, folders: 1 }, history: { imported: 2 }, errors: {} });
    const firefox = await service.run(runtime, "firefox", "abcd1234.default-release", ["bookmarks", "history"]);
    expect(firefox).toEqual({ bookmarks: { imported: 2, folders: 2 }, history: { imported: 1 }, errors: {} });

    const titles = runtime.bookmarks.list().map((b) => b.title);
    expect(titles).toEqual(expect.arrayContaining(["Imported from Google Chrome (Personal)", "News", "Daily", "Imported from Firefox", "Bookmarks Toolbar", "Reading"]));
    const history = runtime.history.all();
    expect(history.map((h) => h.url).sort()).toEqual(["https://corvus.example/", "https://firefox.example/", "https://news.example/daily"]);
    expect(history.find((h) => h.url === "https://corvus.example/")).toMatchObject({ title: "Corvus", visitCount: 12, visitedAt: FIXTURE_NOW - 3_600_000 });
    // Importing again adds nothing.
    await service.run(runtime, "chrome", "Default", ["history"]);
    expect(runtime.history.all()).toHaveLength(3);
    await expect(service.run(runtime, "chrome", "Profile 9", ["bookmarks"])).rejects.toThrow(/no longer there/);

    // Open tabs become a workspace per window, with their pins and tab groups.
    expect(await service.run(runtime, "chrome", "Default", ["tabs"])).toEqual({ tabs: { windows: 1, tabs: 3 }, errors: {} });
    const [ws] = runtime.workspaces.list();
    expect(ws?.name).toBe("Google Chrome (Personal)");
    expect(ws?.tabs.map((t) => [t.url, t.pinned, t.groupId ?? null])).toEqual([
      ["https://mail.example/", true, null],
      ["https://paper.example/", false, "g-7-9"],
      ["https://data.example/", false, "g-7-9"],
    ]);
    expect(ws?.groups).toEqual([{ id: "g-7-9", title: "Research", color: "blue", collapsed: false }]);
    expect(await service.run(runtime, "firefox", "abcd1234.default-release", ["tabs"])).toEqual({ tabs: { windows: 1, tabs: 1 }, errors: {} });
  });
});
