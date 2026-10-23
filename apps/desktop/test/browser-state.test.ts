import { describe, expect, it } from "vitest";
import {
  clearFinished,
  downloadActions,
  downloadProgress,
  downloadStatus,
  formatBytes,
  isExecutableFilename,
  removeDownload,
  reviveDownloads,
  uniqueFilename,
  upsertDownload,
  type DownloadRecord,
} from "../src/shared/downloads";
import {
  buildSnapshot,
  isRestorableUrl,
  restorePlan,
  reviveSession,
  serializeWindow,
  visibleBounds,
  type LiveWindow,
} from "../src/shared/session-state";
import { commandForInput, type KeyInput } from "../src/shared/shortcuts";
import { reviveZoomMap, setZoom, stepZoom, zoomFor, zoomKey, zoomPercent } from "../src/shared/zoom";

describe("zoom", () => {
  it("steps through Chrome's presets and resets", () => {
    expect(stepZoom(1, 1)).toBe(1.1);
    expect(stepZoom(1.1, 1)).toBe(1.25);
    expect(stepZoom(1, -1)).toBe(0.9);
    expect(stepZoom(1.05, -1)).toBe(1);
    expect(stepZoom(1.05, 1)).toBe(1.1);
    expect(stepZoom(5, 1)).toBe(5);
    expect(stepZoom(0.25, -1)).toBe(0.25);
    expect(stepZoom(2.5, 0)).toBe(1);
    expect(zoomPercent(1.1)).toBe(110);
    expect(zoomPercent(0.67)).toBe(67);
  });

  it("keys zoom by host and stores only non-default levels", () => {
    expect(zoomKey("https://Docs.Example.com:8443/a")).toBe("docs.example.com");
    expect(zoomKey("http://127.0.0.1:5000/")).toBe("127.0.0.1");
    expect(zoomKey("corvus://settings/")).toBe("settings");
    expect(zoomKey("file:///C:/a.html")).toBe("file");
    expect(zoomKey("about:blank")).toBeNull();
    let map = setZoom({}, "a.test", 1.25);
    map = setZoom(map, "b.test", 9);
    expect(map).toEqual({ "a.test": 1.25, "b.test": 5 });
    expect(zoomFor(map, "a.test")).toBe(1.25);
    expect(zoomFor(map, "c.test")).toBe(1);
    expect(zoomFor(map, null)).toBe(1);
    expect(setZoom(map, "a.test", 1)).toEqual({ "b.test": 5 });
    expect(reviveZoomMap({ "a.test": 1.5, "b.test": "x", "c.test": 1, "d.test": 0.01 })).toEqual({ "a.test": 1.5, "d.test": 0.25 });
  });
});

describe("session state", () => {
  const live: LiveWindow = {
    profileId: "default",
    bounds: { x: 10, y: 20, width: 1200, height: 800 },
    maximized: false,
    tabs: [
      { url: "https://pinned.test/", title: "Pinned", pinned: true, active: false },
      { url: "https://a.test/", title: "A", pinned: false, groupId: "g1", active: false },
      { url: "corvus://chrome/", title: "Chrome", pinned: false, active: false },
      { url: "about:blank", title: "", pinned: false, groupId: "g2", active: false },
      { url: "corvus://settings/", title: "Settings", pinned: false, active: true },
    ],
    groups: [
      { id: "g1", title: "Work", color: "blue", collapsed: true },
      { id: "g2", title: "Empty", color: "red", collapsed: false },
    ],
  };

  it("serializes restorable tabs, live groups and the active index", () => {
    const w = serializeWindow(live);
    expect(w).toEqual({
      profileId: "default",
      bounds: { x: 10, y: 20, width: 1200, height: 800 },
      maximized: false,
      tabs: [
        { url: "https://pinned.test/", title: "Pinned", pinned: true },
        { url: "https://a.test/", title: "A", pinned: false, groupId: "g1" },
        { url: "corvus://settings/", title: "Settings", pinned: false },
      ],
      groups: [{ id: "g1", title: "Work", color: "blue", collapsed: true }],
      activeIndex: 2,
    });
    expect(serializeWindow({ ...live, tabs: [{ url: "about:blank", title: "", pinned: false, active: true }] })).toBeNull();
  });

  it("keeps a group's workspace link across a restart", () => {
    const linked = { ...live, groups: [{ id: "g1", title: "Work", color: "blue" as const, collapsed: true, workspaceId: "ws-1" }] };
    const w = serializeWindow(linked);
    expect(w?.groups).toEqual([{ id: "g1", title: "Work", color: "blue", collapsed: true, workspaceId: "ws-1" }]);
    const revived = reviveSession(JSON.parse(JSON.stringify(buildSnapshot([w], 1))));
    expect(revived?.windows[0]?.groups[0]?.workspaceId).toBe("ws-1");
    const junk = reviveSession({ version: 1, savedAt: 1, windows: [{ ...w, groups: [{ id: "g1", title: "W", color: "blue", workspaceId: 7 }] }] });
    expect(junk?.windows[0]?.groups[0]).toEqual({ id: "g1", title: "W", color: "blue", collapsed: false });
  });

  it("round-trips through JSON and filters by existing profiles", () => {
    const snap = buildSnapshot([serializeWindow(live), null, serializeWindow({ ...live, profileId: "gone" })], 123);
    const revived = reviveSession(JSON.parse(JSON.stringify(snap)));
    expect(revived).toEqual(snap);
    expect(restorePlan(revived, ["default"]).map((w) => w.profileId)).toEqual(["default"]);
    expect(restorePlan(null, ["default"])).toEqual([]);
  });

  it("drops malformed data instead of failing", () => {
    expect(reviveSession(null)).toBeNull();
    expect(reviveSession({ version: 2, windows: [] })).toBeNull();
    const revived = reviveSession({
      version: 1,
      savedAt: "x",
      windows: [
        { profileId: "p", tabs: [{ url: "javascript:alert(1)" }] },
        "junk",
        {
          profileId: "p",
          bounds: { x: 0, y: 0, width: 10, height: 10 },
          tabs: [{ url: "https://ok.test/", groupId: "missing", pinned: "yes" }, { url: 42 }],
          groups: [{ id: "g", title: "T", color: "neon" }],
          activeIndex: 99,
        },
      ],
    });
    expect(revived).toEqual({
      version: 1,
      savedAt: 0,
      windows: [{ profileId: "p", maximized: false, tabs: [{ url: "https://ok.test/", title: "", pinned: false }], groups: [], activeIndex: 0 }],
    });
  });

  it("knows which URLs are worth restoring", () => {
    expect(isRestorableUrl("https://a.test/")).toBe(true);
    expect(isRestorableUrl("file:///tmp/a.html")).toBe(true);
    expect(isRestorableUrl("corvus://newtab/")).toBe(true);
    expect(isRestorableUrl("corvus://chrome/")).toBe(false);
    expect(isRestorableUrl("data:text/html,x")).toBe(false);
    expect(isRestorableUrl("about:blank")).toBe(false);
  });

  it("only restores bounds that are visible on a display", () => {
    const screen = [{ x: 0, y: 0, width: 1920, height: 1040 }];
    expect(visibleBounds({ x: 100, y: 100, width: 800, height: 600 }, screen)).toEqual({ x: 100, y: 100, width: 800, height: 600 });
    expect(visibleBounds({ x: 3000, y: 100, width: 800, height: 600 }, screen)).toBeUndefined();
    expect(visibleBounds(undefined, screen)).toBeUndefined();
  });
});

describe("downloads", () => {
  const record = (id: string, extra: Partial<DownloadRecord> = {}): DownloadRecord => ({
    id,
    url: `https://a.test/${id}`,
    filename: `${id}.zip`,
    savePath: `/dl/${id}.zip`,
    mime: "application/zip",
    totalBytes: 2048,
    receivedBytes: 1024,
    state: "completed",
    startedAt: 1,
    agent: false,
    canResume: false,
    ...extra,
  });

  it("detects executables", () => {
    for (const name of ["setup.exe", "INSTALL.MSI", "run.sh", "evil.pdf.exe", "tool.AppImage", "x.bat ", "app.dmg"]) {
      expect(isExecutableFilename(name), name).toBe(true);
    }
    for (const name of ["report.pdf", "photo.jpg", "archive.zip", "exe", "notes.txt", ""]) {
      expect(isExecutableFilename(name), name).toBe(false);
    }
  });

  it("picks a free file name", () => {
    const taken = new Set(["a.pdf", "a (1).pdf", "README"]);
    expect(uniqueFilename("a.pdf", (n) => taken.has(n))).toBe("a (2).pdf");
    expect(uniqueFilename("README", (n) => taken.has(n))).toBe("README (1)");
    expect(uniqueFilename("b.pdf", (n) => taken.has(n))).toBe("b.pdf");
    expect(uniqueFilename("../x:y.txt", () => false)).toBe(".._x_y.txt");
    expect(uniqueFilename("  ", () => false)).toBe("download");
  });

  it("upserts newest first and caps finished entries", () => {
    let list: DownloadRecord[] = [];
    list = upsertDownload(list, record("1"));
    list = upsertDownload(list, record("2", { state: "progressing" }));
    list = upsertDownload(list, record("1", { filename: "renamed.zip" }));
    expect(list.map((d) => [d.id, d.filename])).toEqual([
      ["2", "2.zip"],
      ["1", "renamed.zip"],
    ]);
    list = upsertDownload(list, record("3"), 2);
    expect(list.map((d) => d.id)).toEqual(["3", "2"]);
    expect(removeDownload(list, "3").map((d) => d.id)).toEqual(["2"]);
    expect(clearFinished([record("a"), record("b", { state: "paused" }), record("c", { state: "blocked" })]).map((d) => d.id)).toEqual(["b", "c"]);
  });

  it("marks downloads cut short by a restart as interrupted and drops blocked ones", () => {
    const revived = reviveDownloads([
      record("1", { state: "progressing", canResume: true }),
      record("2", { state: "blocked" }),
      record("3"),
      { id: 4 },
      null,
    ]);
    expect(revived.map((d) => [d.id, d.state, d.canResume])).toEqual([
      ["1", "interrupted", false],
      ["3", "completed", false],
    ]);
    expect(reviveDownloads("nope")).toEqual([]);
  });

  it("describes state and available actions", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
    expect(downloadProgress(record("1"))).toBe(0.5);
    expect(downloadProgress(record("1", { totalBytes: 0 }))).toBeNull();
    expect(downloadStatus(record("1", { state: "progressing" }))).toBe("1.0 KB of 2.0 KB");
    expect(downloadActions(record("1", { state: "progressing" }))).toEqual(["pause", "cancel"]);
    expect(downloadActions(record("1", { state: "blocked" }))).toEqual(["keep", "discard"]);
    expect(downloadActions(record("1", { state: "interrupted" }))).toEqual(["retry", "remove"]);
  });
});

describe("find, zoom and downloads shortcuts", () => {
  const key = (k: string, mods: Partial<KeyInput> = {}): KeyInput => ({ type: "keyDown", key: k, control: false, meta: false, shift: false, alt: false, ...mods });

  it("maps find keys", () => {
    expect(commandForInput(key("f", { control: true }), "win32")).toEqual({ type: "find" });
    expect(commandForInput(key("f", { meta: true }), "darwin")).toEqual({ type: "find" });
    expect(commandForInput(key("F3"), "linux")).toEqual({ type: "find-next", forward: true });
    expect(commandForInput(key("F3", { shift: true }), "linux")).toEqual({ type: "find-next", forward: false });
    expect(commandForInput(key("g", { control: true }), "linux")).toEqual({ type: "find-next", forward: true });
    expect(commandForInput(key("G", { control: true, shift: true }), "linux")).toEqual({ type: "find-next", forward: false });
  });

  it("opens downloads with Ctrl+J (Cmd+Shift+J on macOS)", () => {
    expect(commandForInput(key("j", { control: true }), "win32")).toEqual({ type: "open-downloads" });
    expect(commandForInput(key("j", { meta: true }), "darwin")).toBeNull();
    expect(commandForInput(key("J", { meta: true, shift: true }), "darwin")).toEqual({ type: "open-downloads" });
  });
});
