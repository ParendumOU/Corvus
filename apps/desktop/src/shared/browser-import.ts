/**
 * Importing from other browsers: where each one keeps its profiles on Windows, macOS and Linux, how
 * to read its profile list, Firefox's bookmark rows as a tree, and the browsers' timestamps. Pure,
 * so the rules are unit tested; main/browser-import.ts reads the files (copies of them: a running
 * browser keeps its databases open, and the source browser's files are never changed).
 */
import type { ImportedNode } from "./bookmark-import";

export type BrowserFamily = "chromium" | "firefox";

export interface BrowserInfo {
  id: string;
  name: string;
  family: BrowserFamily;
}

/** What can be imported from a profile (more kinds join as Corvus learns to read them). */
export type ImportKind = "bookmarks" | "history" | "tabs" | "search";
export const IMPORT_KINDS: readonly ImportKind[] = ["bookmarks", "history", "tabs", "search"];

export interface ImportProfile {
  /** Folder name inside the browser's data folder ("Default", "Profile 1", "abcd.default-release"). */
  dir: string;
  /** Name the browser shows for it. */
  name: string;
  path: string;
  isDefault: boolean;
  /** How many of each kind it holds (null when it could not be counted). */
  counts: Partial<Record<ImportKind, number | null>>;
  /** Extensions the person installed there, to add to Corvus one by one. */
  extensions: ImportExtension[];
}

/** An extension found in another browser. */
export interface ImportExtension {
  /** Chrome Web Store id, or null for an add-on only found by name in the Web Store (Firefox's). */
  id: string | null;
  name: string;
  /** Already installed in this Corvus profile (set by the IPC handler). */
  installed?: boolean;
}

export interface ImportSource extends BrowserInfo {
  profiles: ImportProfile[];
}

export interface ImportScan {
  sources: ImportSource[];
}

export interface ImportResult {
  /** `existing`: bookmarks already in Corvus (same address in the same folder), left as they were. */
  bookmarks?: { imported: number; folders: number; existing?: number };
  history?: { imported: number };
  /** Open windows saved as Corvus workspaces. */
  tabs?: { windows: number; tabs: number };
  /** Search shortcuts added (keywords Corvus did not have yet). */
  search?: { imported: number };
  /** Why a kind could not be read (e.g. the browser keeps its file locked). */
  errors: Partial<Record<ImportKind, string>>;
}

/** Folders the system keeps app data in (empty strings where a system has none). */
export interface DataRoots {
  platform: string;
  home: string;
  /** Windows: %LOCALAPPDATA%. */
  localAppData: string;
  /** Windows: %APPDATA%. */
  appData: string;
  /** Linux: $XDG_CONFIG_HOME or ~/.config. */
  config: string;
}

interface Location extends BrowserInfo {
  /** The browser's data folder, holding its profiles (or, for Opera, the one profile itself). */
  dir: string;
  /** Opera keeps a single profile directly in its data folder. */
  singleProfile?: boolean;
}

const join = (...parts: string[]): string => parts.filter(Boolean).join(parts[0]?.includes("\\") ? "\\" : "/");

/** Every place a supported browser may keep its data on this system, in the order they are offered. */
export function browserLocations(r: DataRoots): Location[] {
  const chromium = (id: string, name: string, dir: string, singleProfile = false): Location => ({ id, name, family: "chromium", dir, ...(singleProfile ? { singleProfile } : {}) });
  const firefox = (dir: string, id = "firefox"): Location => ({ id, name: "Firefox", family: "firefox", dir });
  if (r.platform === "win32") {
    return [
      chromium("chrome", "Google Chrome", join(r.localAppData, "Google", "Chrome", "User Data")),
      chromium("edge", "Microsoft Edge", join(r.localAppData, "Microsoft", "Edge", "User Data")),
      chromium("brave", "Brave", join(r.localAppData, "BraveSoftware", "Brave-Browser", "User Data")),
      chromium("vivaldi", "Vivaldi", join(r.localAppData, "Vivaldi", "User Data")),
      chromium("opera", "Opera", join(r.appData, "Opera Software", "Opera Stable"), true),
      chromium("opera-gx", "Opera GX", join(r.appData, "Opera Software", "Opera GX Stable"), true),
      chromium("chromium", "Chromium", join(r.localAppData, "Chromium", "User Data")),
      firefox(join(r.appData, "Mozilla", "Firefox")),
    ];
  }
  if (r.platform === "darwin") {
    const support = join(r.home, "Library", "Application Support");
    return [
      chromium("chrome", "Google Chrome", join(support, "Google", "Chrome")),
      chromium("edge", "Microsoft Edge", join(support, "Microsoft Edge")),
      chromium("brave", "Brave", join(support, "BraveSoftware", "Brave-Browser")),
      chromium("vivaldi", "Vivaldi", join(support, "Vivaldi")),
      chromium("opera", "Opera", join(support, "com.operasoftware.Opera"), true),
      chromium("opera-gx", "Opera GX", join(support, "com.operasoftware.OperaGX"), true),
      chromium("chromium", "Chromium", join(support, "Chromium")),
      firefox(join(support, "Firefox")),
    ];
  }
  return [
    chromium("chrome", "Google Chrome", join(r.config, "google-chrome")),
    chromium("edge", "Microsoft Edge", join(r.config, "microsoft-edge")),
    chromium("brave", "Brave", join(r.config, "BraveSoftware", "Brave-Browser")),
    chromium("vivaldi", "Vivaldi", join(r.config, "vivaldi")),
    chromium("opera", "Opera", join(r.config, "opera"), true),
    chromium("chromium", "Chromium", join(r.config, "chromium")),
    chromium("chromium-snap", "Chromium", join(r.home, "snap", "chromium", "common", "chromium")),
    firefox(join(r.home, ".mozilla", "firefox")),
    firefox(join(r.home, "snap", "firefox", "common", ".mozilla", "firefox"), "firefox-snap"),
    firefox(join(r.home, ".var", "app", "org.mozilla.firefox", ".mozilla", "firefox"), "firefox-flatpak"),
  ];
}

/**
 * A Chromium browser's profiles from its "Local State" (profile.info_cache: folder -> name), in the
 * order the browser lists them; folders found on disk but missing there are added after.
 */
export function chromiumProfiles(localState: string | null, foundDirs: readonly string[]): Array<{ dir: string; name: string; isDefault: boolean }> {
  let cache: Record<string, { name?: unknown }> = {};
  let last = "";
  try {
    const parsed = JSON.parse(localState ?? "{}") as { profile?: { info_cache?: Record<string, { name?: unknown }>; last_used?: unknown } };
    cache = parsed.profile?.info_cache ?? {};
    last = typeof parsed.profile?.last_used === "string" ? parsed.profile.last_used : "";
  } catch {
    cache = {};
  }
  const dirs = [...Object.keys(cache).filter((d) => foundDirs.includes(d)), ...foundDirs.filter((d) => !(d in cache))];
  const defaultDir = last && dirs.includes(last) ? last : dirs.includes("Default") ? "Default" : (dirs[0] ?? "");
  return dirs.map((dir) => {
    const name = cache[dir]?.name;
    return { dir, name: typeof name === "string" && name.trim() ? name.trim() : dir, isDefault: dir === defaultDir };
  });
}

/** Folder names that hold a Chromium profile. */
export function isChromiumProfileDir(name: string): boolean {
  return name === "Default" || /^Profile \d+$/.test(name);
}

/** Firefox's profiles from profiles.ini: name, folder (relative or absolute) and which one is the default. */
export function firefoxProfiles(ini: string): Array<{ name: string; path: string; relative: boolean; isDefault: boolean }> {
  const sections: Array<{ name: string; values: Record<string, string> }> = [];
  for (const raw of ini.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith(";") || line.startsWith("#")) continue;
    const head = /^\[(.+)\]$/.exec(line);
    if (head) {
      sections.push({ name: head[1]!, values: {} });
      continue;
    }
    const eq = line.indexOf("=");
    const current = sections[sections.length - 1];
    if (eq > 0 && current) current.values[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  // Newer Firefox marks the default per installation ([Install...] Default=<path>).
  const installDefaults = new Set(sections.filter((s) => s.name.startsWith("Install") && s.values.Default).map((s) => s.values.Default!));
  const profiles = sections.filter((s) => /^Profile\d+$/.test(s.name) && s.values.Path);
  return profiles.map((s) => ({
    name: s.values.Name || s.values.Path!,
    path: s.values.Path!,
    relative: s.values.IsRelative !== "0",
    isDefault: installDefaults.size > 0 ? installDefaults.has(s.values.Path!) : s.values.Default === "1",
  }));
}

/** Chromium stores times as microseconds since 1601-01-01 (UTC); this is ms since 1970. */
export function chromiumTime(value: number | bigint): number {
  const micros = typeof value === "bigint" ? Number(value) : value;
  return Math.round(micros / 1000 - 11_644_473_600_000);
}

/** Firefox (PRTime) stores microseconds since 1970; this is ms. */
export function firefoxTime(value: number | bigint): number {
  return Math.round((typeof value === "bigint" ? Number(value) : value) / 1000);
}

/** A time (ms since 1970) as Chromium stores it, to compare with its columns in a query. */
export function toChromiumTime(ms: number): bigint {
  return (BigInt(Math.round(ms)) + 11_644_473_600_000n) * 1000n;
}

/** A time (ms since 1970) as Firefox stores it. */
export function toFirefoxTime(ms: number): bigint {
  return BigInt(Math.round(ms)) * 1000n;
}

/** One row of Firefox's moz_bookmarks joined with moz_places (type 1 = bookmark, 2 = folder). */
export interface FirefoxBookmarkRow {
  id: number;
  parent: number;
  type: number;
  title: string | null;
  url: string | null;
  position: number;
}

/** Firefox's built-in folders, by GUID, and the order they are imported in. */
const FIREFOX_ROOTS: Record<string, string> = { toolbar_____: "Bookmarks Toolbar", menu________: "Bookmarks Menu", unfiled_____: "Other Bookmarks", mobile______: "Mobile Bookmarks" };

/**
 * Firefox's bookmarks as a tree under its built-in folders (toolbar, menu, other, mobile), keeping
 * folder order. Places that are not web pages (place:, javascript:) are left out, and so are empty
 * built-in folders.
 */
export function firefoxBookmarkTree(rows: readonly FirefoxBookmarkRow[], rootIds: Readonly<Record<string, number>>): ImportedNode[] {
  const children = new Map<number, FirefoxBookmarkRow[]>();
  for (const row of rows) {
    const list = children.get(row.parent) ?? [];
    list.push(row);
    children.set(row.parent, list);
  }
  const build = (parent: number, depth: number): ImportedNode[] => {
    if (depth > 50) return [];
    const out: ImportedNode[] = [];
    for (const row of (children.get(parent) ?? []).sort((a, b) => a.position - b.position)) {
      if (row.type === 2) {
        out.push({ title: (row.title || "Folder").slice(0, 500), children: build(row.id, depth + 1) });
      } else if (row.type === 1 && row.url && /^(https?|ftp|file):/i.test(row.url)) {
        out.push({ title: (row.title || row.url).slice(0, 500), url: row.url });
      }
    }
    return out;
  };
  const out: ImportedNode[] = [];
  for (const [guid, title] of Object.entries(FIREFOX_ROOTS)) {
    const id = rootIds[guid];
    if (id === undefined) continue;
    const nodes = build(id, 0);
    if (nodes.length > 0) out.push({ title, children: nodes });
  }
  return out;
}

export const EXTENSION_ID_RE = /^[a-p]{32}$/;

/** Chromium's Manifest::Location values for extensions the person did not install themselves. */
const NOT_THEIR_INSTALL = new Set([
  4, // unpacked (a developer's folder)
  5, // component
  7, // policy download
  8, // command line
  9, // policy
  10, // external component
]);

const WEB_STORE_UPDATE_RE = /^https:\/\/clients2\.google\.com\/service\/update2\/crx/i;

/** An installed extension of a Chromium profile, from extensions.settings of its preferences. */
export interface ChromiumExtensionEntry {
  id: string;
  /** Folder of the installed version: relative to the profile's Extensions folder, or absolute. */
  path: string;
  fromWebstore: boolean;
  /** The manifest kept in the preferences by older Chromium (newer ones only keep it on disk). */
  manifest: unknown;
}

/**
 * The extensions the person installed in a Chromium profile, from its Preferences and Secure
 * Preferences (newer Chromium keeps extensions.settings in the latter). Components, unpacked
 * folders, policy and command-line installs, and extensions that came with the browser or the
 * computer are left out.
 */
export function chromiumExtensionEntries(prefs: ReadonlyArray<string | null>): ChromiumExtensionEntry[] {
  const merged = new Map<string, Record<string, unknown>>();
  for (const text of prefs) {
    let settings: unknown;
    try {
      settings = (JSON.parse(text ?? "{}") as { extensions?: { settings?: unknown } }).extensions?.settings;
    } catch {
      continue;
    }
    if (!settings || typeof settings !== "object") continue;
    for (const [id, entry] of Object.entries(settings as Record<string, unknown>)) {
      if (EXTENSION_ID_RE.test(id) && entry && typeof entry === "object") merged.set(id, { ...merged.get(id), ...(entry as Record<string, unknown>) });
    }
  }
  const out: ChromiumExtensionEntry[] = [];
  for (const [id, e] of merged) {
    if (typeof e.path !== "string" || !e.path) continue;
    if (typeof e.location === "number" && NOT_THEIR_INSTALL.has(e.location)) continue;
    if (e.was_installed_by_default === true || e.was_installed_by_oem === true) continue;
    out.push({ id, path: e.path, fromWebstore: e.from_webstore === true, manifest: e.manifest ?? null });
  }
  return out;
}

/** A manifest string, with "__MSG_name__" looked up in the extension's default-locale messages. */
export function manifestString(value: unknown, messages: string | null): string {
  if (typeof value !== "string") return "";
  const key = /^__MSG_(\w+)__$/.exec(value.trim())?.[1];
  if (!key) return value.trim();
  try {
    const all = JSON.parse(messages ?? "{}") as Record<string, { message?: unknown }>;
    const found = Object.entries(all).find(([k]) => k.toLowerCase() === key.toLowerCase())?.[1]?.message;
    return typeof found === "string" ? found.trim() : "";
  } catch {
    return "";
  }
}

/**
 * The Chrome Web Store extension an installed one stands for, or null when Corvus cannot install it
 * from there: themes and apps, and extensions from another store (Microsoft Edge Add-ons, Opera
 * add-ons) whose manifest updates from elsewhere.
 */
export function webStoreExtension(entry: ChromiumExtensionEntry, manifest: unknown, messages: string | null): ImportExtension | null {
  const m = (manifest ?? entry.manifest) as Record<string, unknown> | null;
  if (!m || typeof m !== "object") return null;
  if (m.theme || m.app) return null;
  const update = typeof m.update_url === "string" ? m.update_url : "";
  if (update ? !WEB_STORE_UPDATE_RE.test(update) : !entry.fromWebstore) return null;
  const name = manifestString(m.name, messages) || manifestString(m.short_name, messages) || entry.id;
  return { id: entry.id, name: name.slice(0, 200) };
}

/** Firefox add-ons the person installed (extensions.json), to look up by name in the Web Store. */
export function firefoxExtensions(text: string | null): ImportExtension[] {
  let addons: unknown;
  try {
    addons = (JSON.parse(text ?? "{}") as { addons?: unknown }).addons;
  } catch {
    return [];
  }
  if (!Array.isArray(addons)) return [];
  const out: ImportExtension[] = [];
  for (const a of addons as Array<Record<string, unknown>>) {
    if (a?.type !== "extension" || a.location !== "app-profile" || a.isSystem === true || a.hidden === true) continue;
    const name = (a.defaultLocale as { name?: unknown } | undefined)?.name;
    if (typeof name === "string" && name.trim() && !out.some((e) => e.name === name.trim())) out.push({ id: null, name: name.trim().slice(0, 200) });
  }
  return out;
}

/** History worth importing: web pages only, newest first, at most `max`. */
export function importableHistory<T extends { url: string; visitedAt: number }>(rows: readonly T[], max: number): T[] {
  return rows
    .filter((r) => /^https?:\/\//i.test(r.url) && r.url.length <= 8192 && Number.isFinite(r.visitedAt) && r.visitedAt > 0)
    .sort((a, b) => b.visitedAt - a.visitedAt)
    .slice(0, max);
}
