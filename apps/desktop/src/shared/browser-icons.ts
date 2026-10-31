/**
 * Where the other browsers' own icons are on this computer, for the small mark that says a page
 * came from Chrome or Firefox: the browser's program (a Windows .exe, a macOS .app, whose icon the
 * system gives), or on Linux its menu entry (.desktop) and the icon it names. Pure, so it is unit
 * tested; main/browser-icons.ts reads the files.
 */

export interface IconRoots {
  platform: string;
  home: string;
  /** Windows: %LOCALAPPDATA%. */
  localAppData: string;
  /** Windows: %ProgramFiles% and %ProgramFiles(x86)%. */
  programFiles: string[];
}

const join = (...parts: string[]): string => parts.filter(Boolean).join(parts[0]?.includes("\\") ? "\\" : "/");

/** Windows: each browser's folder under Program Files or %LOCALAPPDATA%, and its program there. */
const WINDOWS: Record<string, { local: string[]; system: string[] }> = {
  chrome: { local: ["Google\\Chrome\\Application\\chrome.exe"], system: ["Google\\Chrome\\Application\\chrome.exe"] },
  edge: { local: [], system: ["Microsoft\\Edge\\Application\\msedge.exe"] },
  brave: { local: ["BraveSoftware\\Brave-Browser\\Application\\brave.exe"], system: ["BraveSoftware\\Brave-Browser\\Application\\brave.exe"] },
  vivaldi: { local: ["Vivaldi\\Application\\vivaldi.exe"], system: ["Vivaldi\\Application\\vivaldi.exe"] },
  opera: { local: ["Programs\\Opera\\opera.exe", "Programs\\Opera\\launcher.exe"], system: ["Opera\\opera.exe", "Opera\\launcher.exe"] },
  "opera-gx": { local: ["Programs\\Opera GX\\opera.exe", "Programs\\Opera GX\\launcher.exe"], system: [] },
  chromium: { local: ["Chromium\\Application\\chrome.exe"], system: [] },
  firefox: { local: ["Mozilla Firefox\\firefox.exe"], system: ["Mozilla Firefox\\firefox.exe"] },
};

/** Windows: the program name each browser registers under App Paths (where Windows looks it up). */
export const WINDOWS_APP_PATHS: Readonly<Record<string, string>> = {
  chrome: "chrome.exe",
  edge: "msedge.exe",
  brave: "brave.exe",
  vivaldi: "vivaldi.exe",
  opera: "opera.exe",
  firefox: "firefox.exe",
};

const MAC_APPS: Record<string, string> = {
  chrome: "Google Chrome.app",
  edge: "Microsoft Edge.app",
  brave: "Brave Browser.app",
  vivaldi: "Vivaldi.app",
  opera: "Opera.app",
  "opera-gx": "Opera GX.app",
  chromium: "Chromium.app",
  firefox: "Firefox.app",
};

/** Linux: the menu entries of each browser's packages (deb and rpm, snap, flatpak). */
const LINUX_ENTRIES: Record<string, string[]> = {
  chrome: ["google-chrome.desktop"],
  edge: ["microsoft-edge.desktop"],
  brave: ["brave-browser.desktop"],
  vivaldi: ["vivaldi-stable.desktop"],
  opera: ["opera.desktop"],
  chromium: ["chromium.desktop", "chromium-browser.desktop", "chromium_chromium.desktop"],
  firefox: ["firefox.desktop", "firefox-esr.desktop", "firefox_firefox.desktop", "org.mozilla.firefox.desktop"],
};

/**
 * Where a browser (by the mark of its pages: "chrome", "firefox") may be installed, most likely
 * first: its program on Windows and macOS, its menu entry on Linux.
 */
export function browserIconSources(mark: string, r: IconRoots): string[] {
  if (r.platform === "win32") {
    const known = WINDOWS[mark];
    if (!known) return [];
    return [...r.programFiles.flatMap((dir) => known.system.map((p) => join(dir, p))), ...(r.localAppData ? known.local.map((p) => join(r.localAppData, p)) : [])];
  }
  if (r.platform === "darwin") {
    const app = MAC_APPS[mark];
    return app ? [join("/Applications", app), join(r.home, "Applications", app)] : [];
  }
  const dirs = [join(r.home, ".local", "share", "applications"), "/usr/share/applications", "/usr/local/share/applications", "/var/lib/snapd/desktop/applications", "/var/lib/flatpak/exports/share/applications", join(r.home, ".local", "share", "flatpak", "exports", "share", "applications")];
  return (LINUX_ENTRIES[mark] ?? []).flatMap((entry) => dirs.map((dir) => join(dir, entry)));
}

/** The program path in `reg query "...\App Paths\x.exe" /ve`'s answer (its default value). */
export function parseRegDefault(stdout: string): string | null {
  for (const line of stdout.split(/\r?\n/)) {
    const m = /^\s+\(.+?\)\s+REG_(?:EXPAND_)?SZ\s+(.+?)\s*$/.exec(line);
    if (m) return m[1]!.replace(/^"(.*)"$/, "$1") || null;
  }
  return null;
}

/** The Icon= of a .desktop file's [Desktop Entry] (a theme icon name, or a file). */
export function desktopEntryIcon(text: string): string | null {
  let inEntry = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("[")) inEntry = line === "[Desktop Entry]";
    else if (inEntry && line.startsWith("Icon=")) return line.slice(5).trim() || null;
  }
  return null;
}

/** Linux: the PNG files an icon name may be in, the sizes nearest a sharp small mark first. */
export function linuxIconFiles(icon: string, r: IconRoots): string[] {
  if (icon.startsWith("/")) return [icon];
  const themes = [join(r.home, ".local", "share", "icons", "hicolor"), "/usr/share/icons/hicolor", "/var/lib/flatpak/exports/share/icons/hicolor"];
  const sizes = ["32x32", "48x48", "24x24", "64x64", "16x16", "128x128", "256x256"];
  return [...themes.flatMap((theme) => sizes.map((size) => join(theme, size, "apps", `${icon}.png`))), join("/usr/share/pixmaps", `${icon}.png`)];
}
