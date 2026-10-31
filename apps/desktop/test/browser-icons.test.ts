import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BrowserIcons, type IconLoader } from "../src/main/browser-icons";
import { writeLiveFixtures, type LiveFixtures } from "../src/main/smoke-live-fixtures";
import { browserIconSources, desktopEntryIcon, linuxIconFiles, parseRegDefault, type IconRoots } from "../src/shared/browser-icons";

const WINDOWS: IconRoots = { platform: "win32", home: "C:\\Users\\someone", localAppData: "C:\\Users\\someone\\AppData\\Local", programFiles: ["C:\\Program Files", "C:\\Program Files (x86)"] };
const MAC: IconRoots = { platform: "darwin", home: "/Users/someone", localAppData: "", programFiles: [] };
const LINUX: IconRoots = { platform: "linux", home: "/home/someone", localAppData: "", programFiles: [] };

describe("where a browser's own icon is", () => {
  it("looks for its program in the usual folders on Windows, and its .app on macOS", () => {
    expect(browserIconSources("chrome", WINDOWS)).toEqual([
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Users\\someone\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe",
    ]);
    expect(browserIconSources("edge", WINDOWS)).toContain("C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe");
    expect(browserIconSources("firefox", WINDOWS)[0]).toBe("C:\\Program Files\\Mozilla Firefox\\firefox.exe");
    expect(browserIconSources("firefox", MAC)).toEqual(["/Applications/Firefox.app", "/Users/someone/Applications/Firefox.app"]);
    expect(browserIconSources("unknown", WINDOWS)).toEqual([]);
  });

  it("looks for its menu entry on Linux, and the icon file it names", () => {
    expect(browserIconSources("chrome", LINUX)[0]).toBe("/home/someone/.local/share/applications/google-chrome.desktop");
    expect(browserIconSources("firefox", LINUX)).toContain("/var/lib/flatpak/exports/share/applications/org.mozilla.firefox.desktop");
    expect(desktopEntryIcon("[Desktop Entry]\nName=Firefox\nIcon=firefox\n\n[Desktop Action new-private-window]\nIcon=private\n")).toBe("firefox");
    expect(desktopEntryIcon("[Desktop Action x]\nIcon=other\n")).toBeNull();
    expect(linuxIconFiles("/opt/brave/product_logo_32.png", LINUX)).toEqual(["/opt/brave/product_logo_32.png"]);
    const files = linuxIconFiles("google-chrome", LINUX);
    expect(files[0]).toBe("/home/someone/.local/share/icons/hicolor/32x32/apps/google-chrome.png");
    expect(files).toContain("/usr/share/icons/hicolor/48x48/apps/google-chrome.png");
    expect(files.at(-1)).toBe("/usr/share/pixmaps/google-chrome.png");
  });

  it("reads where Windows' App Paths says the program is", () => {
    const answer = "\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe\r\n    (Default)    REG_SZ    C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe\r\n";
    expect(parseRegDefault(answer)).toBe("C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe");
    expect(parseRegDefault('    (Predeterminado)    REG_EXPAND_SZ    "D:\\Apps\\firefox.exe"\r\n')).toBe("D:\\Apps\\firefox.exe");
    expect(parseRegDefault("ERROR: The system was unable to find the specified registry key or value.")).toBeNull();
  });
});

describe("browser icons", () => {
  let root = "";
  let fixtures: LiveFixtures;
  let loads: string[] = [];
  const loader: IconLoader = {
    program: async (file) => (loads.push(file), `data:image/png;base64,program:${path.basename(file)}`),
    image: async (file) => (loads.push(file), `data:image/png;base64,image:${path.basename(file)}`),
  };

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "corvus-icons-test-"));
    fixtures = writeLiveFixtures(root);
    loads = [];
  });

  afterEach(() => {
    fixtures.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("takes the icon a Linux browser's menu entry names, once per run, and keeps the letter for one without", async () => {
    const icons = new BrowserIcons(() => ({ platform: "linux", home: root, localAppData: "", programFiles: [] }), loader);
    expect(await icons.icons(["chrome", "firefox", "chrome"])).toEqual({ chrome: "data:image/png;base64,image:fake-chrome.png" });
    await icons.icons(["chrome"]);
    expect(loads).toEqual([fixtures.chromeIcon]);
    // Its icon went away (the browser was removed): looked for again, and its letter shows.
    fs.rmSync(fixtures.chromeIcon);
    expect(await icons.icons(["chrome"])).toEqual({});
  });

  it("asks Windows' App Paths for a program not in the usual folders", async () => {
    const program = path.join(root, "chrome.exe");
    fs.writeFileSync(program, "MZ");
    const asked: string[] = [];
    const icons = new BrowserIcons(() => ({ platform: "win32", home: root, localAppData: "", programFiles: [] }), loader, async (exe) => (asked.push(exe), exe === "chrome.exe" ? program : null));
    expect(await icons.icons(["chrome", "chromium"])).toEqual({ chrome: "data:image/png;base64,program:chrome.exe" });
    // Chromium registers no program of its own there (chrome.exe is Chrome's).
    expect(asked).toEqual(["chrome.exe"]);
    expect(loads).toEqual([program]);
  });
});
