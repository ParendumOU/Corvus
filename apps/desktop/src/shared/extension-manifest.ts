/**
 * Pure helpers over Chrome extension manifests: permission warnings shown before install,
 * the APIs Corvus can serve, and Chrome Web Store ID parsing. No Electron imports.
 */

export interface ManifestLike {
  manifest_version?: number;
  name?: string;
  version?: string;
  permissions?: unknown;
  optional_permissions?: unknown;
  host_permissions?: unknown;
  content_scripts?: unknown;
  background?: { service_worker?: unknown; scripts?: unknown; page?: unknown };
  action?: unknown;
  browser_action?: unknown;
  options_page?: unknown;
  options_ui?: { page?: unknown };
  homepage_url?: unknown;
  update_url?: unknown;
  key?: unknown;
  side_panel?: unknown;
  chrome_url_overrides?: unknown;
  declarative_net_request?: unknown;
}

const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : []);

function isHostPattern(value: string): boolean {
  return value === "<all_urls>" || value.includes("://");
}

/** API permissions (no host patterns) declared by the manifest. */
export function apiPermissions(manifest: ManifestLike): string[] {
  return strings(manifest.permissions).filter((p) => !isHostPattern(p));
}

/** Host patterns the extension can access: host permissions plus content script matches. */
export function hostPatterns(manifest: ManifestLike): string[] {
  const fromPermissions =
    manifest.manifest_version === 3 ? strings(manifest.host_permissions) : strings(manifest.permissions).filter(isHostPattern);
  const scripts = Array.isArray(manifest.content_scripts) ? manifest.content_scripts : [];
  const fromScripts = scripts.flatMap((s) => strings((s as { matches?: unknown }).matches));
  return [...new Set([...fromPermissions, ...fromScripts])];
}

const ALL_HOSTS_RE = /^(\*|https?|wss?):\/\/\*\/.*$/;

function hostOfPattern(pattern: string): string | null {
  const m = /^[a-z*]+:\/\/([^/]+)\//i.exec(pattern);
  if (!m?.[1]) return null;
  return m[1].replace(/^\*\./, "");
}

function hostWarning(patterns: string[]): string | null {
  if (patterns.length === 0) return null;
  if (patterns.some((p) => p === "<all_urls>" || ALL_HOSTS_RE.test(p) || p.startsWith("file:///*"))) {
    return "Read and change all your data on all websites";
  }
  const hosts = [...new Set(patterns.map(hostOfPattern).filter((h): h is string => h !== null && h !== "*"))].sort();
  if (hosts.length === 0) return null;
  if (hosts.length === 1) return `Read and change your data on ${hosts[0]}`;
  if (hosts.length === 2) return `Read and change your data on ${hosts[0]} and ${hosts[1]}`;
  if (hosts.length === 3) return `Read and change your data on ${hosts[0]}, ${hosts[1]} and ${hosts[2]}`;
  return `Read and change your data on ${hosts[0]}, ${hosts[1]} and ${hosts.length - 2} other sites`;
}

/** Chrome's install-time permission messages, in the order Chrome lists them. */
const PERMISSION_MESSAGES: Array<[string, string]> = [
  ["debugger", "Access the page debugger backend"],
  ["proxy", "Read and change all your data on all websites"],
  ["declarativeNetRequest", "Block content on any page"],
  ["declarativeNetRequestWithHostAccess", "Block content on any page you visit"],
  ["history", "Read and change your browsing history on all your signed-in devices"],
  ["tabs", "Read your browsing history"],
  ["webNavigation", "Read your browsing history"],
  ["sessions", "Read your browsing history"],
  ["topSites", "Read a list of your most frequently visited websites"],
  ["bookmarks", "Read and change your bookmarks"],
  ["readingList", "Read and change entries in the reading list"],
  ["clipboardRead", "Read data you copy and paste"],
  ["clipboardWrite", "Modify data you copy and paste"],
  ["downloads", "Manage your downloads"],
  ["downloads.open", "Open downloaded files"],
  ["management", "Manage your apps, extensions, and themes"],
  ["nativeMessaging", "Communicate with cooperating native applications"],
  ["notifications", "Display notifications"],
  ["geolocation", "Detect your physical location"],
  ["privacy", "Change your privacy-related settings"],
  ["contentSettings", "Change your settings that control websites' access to features such as cookies, JavaScript, plugins, geolocation, microphone, camera etc."],
  ["desktopCapture", "Capture content of your screen"],
  ["tabCapture", "Capture content of your screen"],
  ["pageCapture", "Read and change all your data on all websites"],
  ["identity.email", "Know your email address"],
  ["tts", "Read all text spoken using synthesized speech"],
  ["ttsEngine", "Read all text spoken using synthesized speech"],
  ["system.storage", "Identify and eject storage devices"],
  ["favicon", "Read the icons of the websites you visit"],
];

/** Human-readable warnings Chrome would show before installing an extension with this manifest. */
export function permissionWarnings(manifest: ManifestLike): string[] {
  const perms = new Set(apiPermissions(manifest));
  const out: string[] = [];
  const add = (message: string): void => {
    if (!out.includes(message)) out.push(message);
  };
  const hosts = hostWarning(hostPatterns(manifest));
  const allData = "Read and change all your data on all websites";
  if (perms.has("debugger") || perms.has("proxy") || perms.has("pageCapture")) add(allData);
  if (hosts) add(hosts);
  const coveredByHistory = perms.has("history");
  for (const [perm, message] of PERMISSION_MESSAGES) {
    if (!perms.has(perm) || message === allData) continue;
    if (coveredByHistory && (perm === "tabs" || perm === "webNavigation" || perm === "sessions")) continue;
    if (perm === "declarativeNetRequestWithHostAccess" && perms.has("declarativeNetRequest")) continue;
    add(message);
  }
  // A narrower host message is redundant once the extension can read every site.
  if (out.includes(allData)) return out.filter((m) => m === allData || !m.startsWith("Read and change your data on"));
  return out;
}

/**
 * chrome.* namespaces available to extensions in Corvus (Electron's native extension APIs plus
 * electron-chrome-extensions), as probed by the smoke test. Keys are permission names
 * (or namespace names for APIs that need no permission).
 */
export const SUPPORTED_APIS: ReadonlySet<string> = new Set([
  // Electron (Chromium extension system subset)
  "runtime",
  "extension",
  "i18n",
  "storage",
  "unlimitedStorage",
  "scripting",
  "tabs",
  "activeTab",
  "webRequest",
  "webRequestBlocking",
  "webRequestAuthProvider",
  "management",
  "devtools",
  "alarms",
  "idle",
  "offscreen",
  "declarativeNetRequest",
  "declarativeNetRequestWithHostAccess",
  "declarativeNetRequestFeedback",
  // electron-chrome-extensions
  "action",
  "browserAction",
  "commands",
  "contextMenus",
  "menus",
  "cookies",
  "notifications",
  "permissions",
  "webNavigation",
  "windows",
  "nativeMessaging",
  // Corvus (main/extension-apis.ts)
  "bookmarks",
  "history",
  "tabGroups",
  "sessions",
  "search",
  "sidePanel",
  "topSites",
  // Web platform permissions granted through the session permission handler
  "clipboardWrite",
  "clipboardRead",
]);

/** API permissions declared by the manifest that Corvus does not implement (yet). */
export function unsupportedPermissions(manifest: ManifestLike): string[] {
  return apiPermissions(manifest).filter((p) => !SUPPORTED_APIS.has(p) && !SUPPORTED_APIS.has(p.split(".")[0] ?? p));
}

const EXTENSION_ID_RE = /^[a-p]{32}$/;

/** Accepts a bare extension ID or a Chrome Web Store detail URL and returns the ID. */
export function parseExtensionId(input: string): string | null {
  const trimmed = input.trim();
  if (EXTENSION_ID_RE.test(trimmed)) return trimmed;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (url.hostname !== "chromewebstore.google.com" && url.hostname !== "chrome.google.com") return null;
  const segment = url.pathname.split("/").find((part) => EXTENSION_ID_RE.test(part));
  return segment ?? null;
}

/** Compares dotted extension versions numerically ("1.10" > "1.9"). */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

export function storeUrlFor(id: string): string {
  return `https://chromewebstore.google.com/detail/${id}`;
}

/** Resolves "__MSG_name__" placeholders against an extension's messages.json contents. */
export function localizeManifestString(value: string, messages: Record<string, { message?: unknown }> | null): string {
  if (!messages) return value;
  return value.replace(/__MSG_([A-Za-z0-9_@]+)__/g, (whole, key: string) => {
    const lower = key.toLowerCase();
    const entry = Object.entries(messages).find(([k]) => k.toLowerCase() === lower)?.[1];
    return typeof entry?.message === "string" ? entry.message : whole;
  });
}

/** IPC channel an extension service worker uses to ask which static DNR rulesets to enable. */
export const DNR_DEFAULTS_CHANNEL = "corvus:dnr-default-rulesets";

/** Main-world global (removed again by the worker preload) that carries Corvus extension API calls. */
export const EXTENSION_API_BRIDGE = "__corvusExtensionApi";

/** Static rulesets the manifest enables by default. */
export function defaultRulesets(manifest: ManifestLike): string[] {
  const dnr = manifest.declarative_net_request as { rule_resources?: unknown } | undefined;
  const resources = Array.isArray(dnr?.rule_resources) ? dnr.rule_resources : [];
  return resources
    .filter((r): r is { id: string; enabled?: unknown } => typeof r === "object" && r !== null && typeof (r as { id?: unknown }).id === "string")
    .filter((r) => r.enabled === true)
    .map((r) => r.id);
}
