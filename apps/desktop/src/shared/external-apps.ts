/**
 * Links that open another app on this computer (afirma:, zoommtg:, msteams:, mailto:...): which
 * schemes go to the system, the escaping Chromium applies before it hands a link over, Chrome's rule
 * of one app launch per thing the person does in the page, and the per-site "Always allow" list.
 * Pure (no Electron) so every rule is unit tested.
 */
import { isSecureOrigin, listSitePermissions, originOf, type SitePermissionEntry, type SitePermissionMap } from "./permissions";

/** Schemes Chromium or Corvus loads itself: never handed to another app. */
const BROWSER_SCHEMES: ReadonlySet<string> = new Set([
  "http",
  "https",
  "ws",
  "wss",
  "ftp",
  "about",
  "blob",
  "data",
  "file",
  "filesystem",
  "javascript",
  "corvus",
  "chrome",
  "chrome-extension",
  "chrome-untrusted",
  "devtools",
  "view-source",
]);

/**
 * Schemes a page may never hand to the system: Chrome's own list, plus Windows handlers that ran
 * code from a link (ms-msdt "Follina", search-ms, ms-officecmd, ms-appinstaller...).
 */
const DENIED_SCHEMES: ReadonlySet<string> = new Set([
  "afp",
  "disk",
  "disks",
  "hcp",
  "ie.http",
  "its",
  "jar",
  "mk",
  "ms-appinstaller",
  "ms-cxh",
  "ms-cxh-full",
  "ms-help",
  "ms-its",
  "ms-msdt",
  "ms-officecmd",
  "nntp",
  "res",
  "search",
  "search-ms",
  "shell",
  "vbscript",
  "vnd.ms.radio",
]);

const SCHEME_RE = /^([a-z][a-z0-9+.-]*):/i;

export type LinkKind = "browser" | "external" | "denied" | "invalid";

/** Whether a link is loaded by the browser, handed to another app, or refused. */
export function linkKind(url: string): LinkKind {
  const scheme = SCHEME_RE.exec(url)?.[1]?.toLowerCase();
  if (!scheme) return "invalid";
  if (BROWSER_SCHEMES.has(scheme)) return "browser";
  return DENIED_SCHEMES.has(scheme) ? "denied" : "external";
}

/** The scheme of a link another app opens ("afirma"), or null for any other link. */
export function externalScheme(url: string): string | null {
  return linkKind(url) === "external" ? SCHEME_RE.exec(url)![1]!.toLowerCase() : null;
}

/** Characters left as they are in a link handed to another app: letters, digits and URL punctuation. */
const KEPT = /[A-Za-z0-9;/?:@&=+$,\-_.!~*'()%#[\]]/;

/**
 * The link as Chromium hands it to the system (EscapeExternalHandlerValue): spaces, quotes and
 * every other character outside URL punctuation are percent-encoded (UTF-8), so a link cannot add
 * arguments to the command line of the app that opens it. Existing escapes are kept.
 */
export function escapeForHandler(url: string): string {
  let out = "";
  for (const char of url) {
    if (KEPT.test(char)) {
      out += char;
      continue;
    }
    for (const byte of new TextEncoder().encode(char)) out += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return out;
}

// ------------------------------------------------------------------------- user gesture

/** How long a click in a page lets a tab it opens launch an app (Chromium's user activation). */
export const ACTIVATION_MS = 5000;

/**
 * Input that counts as the person doing something in the page: a click, a key, a tap. Moving the
 * mouse, the wheel and scrolling do not, as in Chrome.
 */
export function isActivationInput(type: string): boolean {
  return ["mouseDown", "mouseUp", "rawKeyDown", "keyDown", "touchEnd", "pointerDown", "pointerUp", "gestureTap"].includes(type);
}

/** Order of what happened in a tab, from one counter shared by all tabs (0: never). */
export interface LaunchGate {
  /** The person's last input in the tab, or a page load they started from Corvus (address bar, bookmark, another app). */
  input: number;
  /** The tab's last request to open an app, granted or not. */
  launch: number;
}

/**
 * Chrome's flood rule, per tab: a page may ask to open an app once per thing the person does in it.
 * A tab opened by a click in another tab may ask once before anything is done in it.
 */
export function mayLaunch(gate: LaunchGate, openedByGesture: boolean): boolean {
  return gate.input > gate.launch || (openedByGesture && gate.launch === 0);
}

/** Whether a tab was opened right after the person's input in the tab that opened it. */
export function openedByGesture(openerInputAt: number, createdAt: number): boolean {
  return openerInputAt > 0 && createdAt >= openerInputAt && createdAt - openerInputAt <= ACTIVATION_MS;
}

// ------------------------------------------------------------------------- remembered

/** Per site, the schemes the person allowed it to open without asking ("Always allow"). */
export type ExternalAppMap = Record<string, string[]>;

/**
 * Whether "Always allow" is offered: only for a secure site (https or this computer), never in a
 * private window or a tab an AI agent drives.
 */
export function canRememberApp(origin: string, opts: { privateWindow: boolean; agent: boolean }): boolean {
  return !opts.privateWindow && !opts.agent && isSecureOrigin(origin);
}

export function isAppAllowed(map: ExternalAppMap, origin: string, scheme: string): boolean {
  return map[origin]?.includes(scheme) === true;
}

export function setAppAllowed(map: ExternalAppMap, origin: string, scheme: string, allowed: boolean): ExternalAppMap {
  if (!origin || !scheme || isAppAllowed(map, origin, scheme) === allowed) return map;
  const schemes = allowed ? [...(map[origin] ?? []), scheme].sort() : (map[origin] ?? []).filter((s) => s !== scheme);
  const next = { ...map };
  if (schemes.length === 0) delete next[origin];
  else next[origin] = schemes;
  return next;
}

export function forgetSiteApps(map: ExternalAppMap, origin: string): ExternalAppMap {
  if (!(origin in map)) return map;
  const next = { ...map };
  delete next[origin];
  return next;
}

export function reviveExternalApps(raw: unknown): ExternalAppMap {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  const out: ExternalAppMap = {};
  for (const [origin, schemes] of Object.entries(raw as Record<string, unknown>)) {
    if (originOf(origin) !== origin || !Array.isArray(schemes)) continue;
    const valid = [...new Set(schemes.filter((s): s is string => typeof s === "string" && externalScheme(`${s}:`) === s))].sort();
    if (valid.length > 0) out[origin] = valid;
  }
  return out;
}

/** Settings > Site permissions: every site with a remembered permission or allowed app, by origin. */
export function listSiteSettings(permissions: SitePermissionMap, apps: ExternalAppMap): SitePermissionEntry[] {
  const byOrigin = new Map(listSitePermissions(permissions).map((e) => [e.origin, e]));
  for (const [origin, schemes] of Object.entries(apps)) byOrigin.set(origin, { ...(byOrigin.get(origin) ?? { origin, permissions: {} }), externalApps: [...schemes] });
  return [...byOrigin.values()].sort((a, b) => a.origin.localeCompare(b.origin));
}
