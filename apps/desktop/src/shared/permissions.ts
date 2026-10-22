/**
 * Site permission policy: the decision table, origin rules and the per-profile storage format.
 * Pure (no Electron) so every rule is unit tested; the main process feeds it Electron's requests.
 */

export const PERMISSION_KINDS = [
  "geolocation",
  "camera",
  "microphone",
  "notifications",
  "clipboard-read",
  "midi",
  "midi-sysex",
  "pointer-lock",
  "idle-detection",
  "display-capture",
  "fullscreen",
  "clipboard-write",
] as const;
export type PermissionKind = (typeof PERMISSION_KINDS)[number];
export type PermissionDecision = "allow" | "block";

export const PERMISSION_LABELS: Record<PermissionKind, { title: string; prompt: string }> = {
  geolocation: { title: "Location", prompt: "Know your location" },
  camera: { title: "Camera", prompt: "Use your camera" },
  microphone: { title: "Microphone", prompt: "Use your microphone" },
  notifications: { title: "Notifications", prompt: "Show notifications" },
  "clipboard-read": { title: "Clipboard", prompt: "See text and images copied to the clipboard" },
  midi: { title: "MIDI devices", prompt: "Use your MIDI devices" },
  "midi-sysex": { title: "MIDI device control", prompt: "Control and reprogram your MIDI devices" },
  "pointer-lock": { title: "Mouse pointer", prompt: "Lock and use your mouse pointer" },
  "idle-detection": { title: "Device use", prompt: "Know when you're actively using this device" },
  "display-capture": { title: "Screen capture", prompt: "See your screen" },
  fullscreen: { title: "Full screen", prompt: "Use full screen" },
  "clipboard-write": { title: "Clipboard write", prompt: "Write to the clipboard" },
};

/** Granted without a prompt, from any origin. */
const AUTO_ALLOWED: ReadonlySet<PermissionKind> = new Set(["fullscreen", "clipboard-write"]);

/** Always denied to tabs driven by an AI agent, whatever the user stored for the site. */
export const AGENT_FORBIDDEN: ReadonlySet<PermissionKind> = new Set(["camera", "microphone", "geolocation", "display-capture"]);

/** Asked every time (like Chrome's screen sharing picker); never stored or reused. */
const ALWAYS_ASK: ReadonlySet<PermissionKind> = new Set(["display-capture"]);

export function isPermissionKind(value: unknown): value is PermissionKind {
  return typeof value === "string" && (PERMISSION_KINDS as readonly string[]).includes(value);
}

/** Whether a decision for this kind can be remembered for the site. */
export function isRememberable(kind: PermissionKind): boolean {
  return !AUTO_ALLOWED.has(kind) && !ALWAYS_ASK.has(kind);
}

/**
 * Map an Electron permission name (plus requested media types) to the kinds the user decides on.
 * An empty result means the permission is not supported and is denied.
 */
export function kindsForPermission(permission: string, mediaTypes?: readonly string[]): PermissionKind[] {
  switch (permission) {
    case "media": {
      const kinds: PermissionKind[] = [];
      if (mediaTypes?.includes("video")) kinds.push("camera");
      if (mediaTypes?.includes("audio")) kinds.push("microphone");
      return kinds;
    }
    case "geolocation":
    case "geolocation-approximate":
      return ["geolocation"];
    case "notifications":
      return ["notifications"];
    case "clipboard-read":
      return ["clipboard-read"];
    case "clipboard-sanitized-write":
      return ["clipboard-write"];
    case "midi":
      return ["midi"];
    case "midiSysex":
      return ["midi-sysex"];
    case "pointerLock":
      return ["pointer-lock"];
    case "idle-detection":
      return ["idle-detection"];
    case "display-capture":
      return ["display-capture"];
    case "fullscreen":
      return ["fullscreen"];
    default:
      return [];
  }
}

const SPECIAL_SCHEMES = new Set(["http:", "https:", "ws:", "wss:"]);

/** Serialized origin of a URL ("scheme://host[:port]"), also for custom schemes; "" when opaque. */
export function originOf(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "";
  }
  if (SPECIAL_SCHEMES.has(parsed.protocol)) return parsed.origin;
  return parsed.host ? `${parsed.protocol}//${parsed.host}` : "";
}

export function isLocalhost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "[::1]" ||
    /^127(?:\.\d{1,3}){3}$/.test(host)
  );
}

export function isInternalOrigin(origin: string): boolean {
  return origin.startsWith("corvus:");
}

/** Potentially trustworthy origins: https, extensions and loopback http. */
export function isSecureOrigin(origin: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  switch (parsed.protocol) {
    case "https:":
    case "wss:":
    case "chrome-extension:":
      return true;
    case "http:":
    case "ws:":
      return isLocalhost(parsed.hostname);
    default:
      return false;
  }
}

export type DenyReason = "unsupported" | "internal" | "insecure" | "embedded" | "agent" | "blocked";

export type Verdict =
  | { action: "allow" }
  | { action: "deny"; reason: DenyReason }
  | { action: "prompt"; kinds: PermissionKind[] };

export interface StoredDecisions {
  /** Remembered for the site in this profile. */
  persistent?: PermissionDecision;
  /** Given for the current page in this tab only ("remember" unchecked, or any agent-tab answer). */
  temporary?: PermissionDecision;
}

export interface PermissionQuery {
  kinds: readonly PermissionKind[];
  /** Origin of the requesting frame. */
  origin: string;
  /** Origin of the top-level page. */
  topOrigin: string;
  /** The tab is driven by an AI agent. */
  agent: boolean;
  lookup: (kind: PermissionKind) => StoredDecisions;
}

const ALLOW: Verdict = { action: "allow" };
const deny = (reason: DenyReason): Verdict => ({ action: "deny", reason });

/**
 * The decision table. Order matters:
 *   1. unsupported permissions are denied;
 *   2. auto-allowed kinds (fullscreen, clipboard write) pass, except fullscreen for agent tabs
 *      (the AI badge must stay visible);
 *   3. internal pages, non-secure origins (except loopback) and cross-origin frames are denied;
 *   4. agent tabs never get camera, microphone, location or screen capture;
 *   5. any block (temporary or remembered) denies;
 *   6. what is not already allowed is prompted. Agent tabs ignore remembered "allow" decisions,
 *      so a human always answers for them.
 */
export function decidePermission(q: PermissionQuery): Verdict {
  if (q.kinds.length === 0) return deny("unsupported");
  if (q.kinds.every((k) => AUTO_ALLOWED.has(k))) {
    return q.agent && q.kinds.includes("fullscreen") ? deny("agent") : ALLOW;
  }
  if (isInternalOrigin(q.origin)) return deny("internal");
  if (!isSecureOrigin(q.origin)) return deny("insecure");
  if (q.origin !== q.topOrigin) return deny("embedded");
  if (q.agent && q.kinds.some((k) => AGENT_FORBIDDEN.has(k))) return deny("agent");

  const pending: PermissionKind[] = [];
  for (const kind of q.kinds) {
    if (AUTO_ALLOWED.has(kind)) continue;
    let decision: PermissionDecision | undefined;
    if (!ALWAYS_ASK.has(kind)) {
      const { persistent, temporary } = q.lookup(kind);
      decision = temporary ?? (q.agent && persistent === "allow" ? undefined : persistent);
    }
    if (decision === "block") return deny("blocked");
    if (decision !== "allow") pending.push(kind);
  }
  return pending.length === 0 ? ALLOW : { action: "prompt", kinds: pending };
}

// ------------------------------------------------------------------------- storage

/** Remembered decisions of one profile: origin -> kind -> decision. */
export type SitePermissionMap = Record<string, Partial<Record<PermissionKind, PermissionDecision>>>;

export interface SitePermissionEntry {
  origin: string;
  permissions: Partial<Record<PermissionKind, PermissionDecision>>;
}

export function setSitePermission(
  map: SitePermissionMap,
  origin: string,
  kind: PermissionKind,
  decision: PermissionDecision | null,
): SitePermissionMap {
  if (!origin || !isRememberable(kind)) return map;
  const current = map[origin] ?? {};
  if ((current[kind] ?? null) === decision) return map;
  const nextSite = { ...current };
  if (decision === null) delete nextSite[kind];
  else nextSite[kind] = decision;
  const next = { ...map };
  if (Object.keys(nextSite).length === 0) delete next[origin];
  else next[origin] = nextSite;
  return next;
}

export function resetSitePermissions(map: SitePermissionMap, origin: string): SitePermissionMap {
  if (!(origin in map)) return map;
  const next = { ...map };
  delete next[origin];
  return next;
}

export function listSitePermissions(map: SitePermissionMap): SitePermissionEntry[] {
  return Object.keys(map)
    .sort((a, b) => a.localeCompare(b))
    .map((origin) => ({ origin, permissions: { ...map[origin] } }));
}

export function reviveSitePermissions(raw: unknown): SitePermissionMap {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  const out: SitePermissionMap = {};
  for (const [origin, perms] of Object.entries(raw as Record<string, unknown>)) {
    if (originOf(origin) !== origin || typeof perms !== "object" || perms === null) continue;
    const site: Partial<Record<PermissionKind, PermissionDecision>> = {};
    for (const [kind, decision] of Object.entries(perms as Record<string, unknown>)) {
      if (isPermissionKind(kind) && isRememberable(kind) && (decision === "allow" || decision === "block")) site[kind] = decision;
    }
    if (Object.keys(site).length > 0) out[origin] = site;
  }
  return out;
}
