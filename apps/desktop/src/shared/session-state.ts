/**
 * Session restore format: open windows, their tabs and tab groups. Pure, so serialization,
 * validation of a possibly corrupt file and the restore plan are unit tested.
 */
import type { GroupColor, TabGroup } from "@corvus/shared";
import { isFaviconUrl, MAX_SAVED_FAVICON_URL } from "./favicon";
import { GROUP_COLORS } from "./tab-strip";

export interface SessionTab {
  url: string;
  title: string;
  pinned: boolean;
  groupId?: string;
  /** Icon the tab showed, so a restored tab that is not loaded yet still shows its site icon. */
  faviconUrl?: string;
}

export interface SessionGroup {
  id: string;
  title: string;
  color: GroupColor;
  collapsed: boolean;
}

export interface SessionBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SessionWindow {
  profileId: string;
  bounds?: SessionBounds;
  maximized: boolean;
  tabs: SessionTab[];
  groups: SessionGroup[];
  activeIndex: number;
}

export interface SessionSnapshot {
  version: 1;
  savedAt: number;
  windows: SessionWindow[];
}

const MAX_WINDOWS = 50;
const MAX_TABS = 500;

/** Pages worth reopening: web pages, local files, extension pages and internal pages. */
export function isRestorableUrl(url: string): boolean {
  if (url.length > 8192) return false;
  if (/^(https?|file|chrome-extension):/i.test(url)) return true;
  if (/^corvus:\/\//i.test(url)) return !/^corvus:\/\/chrome(\/|$)/i.test(url);
  return false;
}

export interface LiveWindow {
  profileId: string;
  bounds?: SessionBounds;
  maximized: boolean;
  tabs: Array<{ url: string; title: string; pinned: boolean; groupId?: string; faviconUrl?: string; active: boolean }>;
  groups: TabGroup[];
}

/** Snapshot of one window, or null when it has nothing worth restoring. */
export function serializeWindow(win: LiveWindow): SessionWindow | null {
  const kept = win.tabs.filter((t) => isRestorableUrl(t.url));
  if (kept.length === 0) return null;
  const usedGroups = new Set(kept.map((t) => t.groupId).filter((g): g is string => g !== undefined));
  const groups = win.groups
    .filter((g) => usedGroups.has(g.id))
    .map(({ id, title, color, collapsed }) => ({ id, title, color, collapsed }));
  const known = new Set(groups.map((g) => g.id));
  const tabs = kept.map(({ url, title, pinned, groupId, faviconUrl }) => ({
    url,
    title,
    pinned,
    ...(groupId && known.has(groupId) && !pinned ? { groupId } : {}),
    ...(isFaviconUrl(faviconUrl, MAX_SAVED_FAVICON_URL) ? { faviconUrl } : {}),
  }));
  const activeIndex = Math.max(0, kept.findIndex((t) => t.active));
  return {
    profileId: win.profileId,
    ...(win.bounds ? { bounds: { ...win.bounds } } : {}),
    maximized: win.maximized,
    tabs,
    groups,
    activeIndex,
  };
}

export function buildSnapshot(windows: Array<SessionWindow | null>, now: number): SessionSnapshot {
  return { version: 1, savedAt: now, windows: windows.filter((w): w is SessionWindow => w !== null).slice(0, MAX_WINDOWS) };
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isFiniteNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

function reviveBounds(raw: unknown): SessionBounds | undefined {
  if (!isObject(raw)) return undefined;
  const { x, y, width, height } = raw;
  if (!isFiniteNumber(x) || !isFiniteNumber(y) || !isFiniteNumber(width) || !isFiniteNumber(height)) return undefined;
  if (width < 100 || height < 100) return undefined;
  return { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) };
}

function reviveWindow(raw: unknown): SessionWindow | null {
  if (!isObject(raw) || typeof raw.profileId !== "string" || !Array.isArray(raw.tabs)) return null;
  const groups: SessionGroup[] = Array.isArray(raw.groups)
    ? raw.groups.filter(isObject).flatMap((g) =>
        typeof g.id === "string" && typeof g.title === "string" && GROUP_COLORS.includes(g.color as GroupColor)
          ? [{ id: g.id, title: g.title.slice(0, 80), color: g.color as GroupColor, collapsed: g.collapsed === true }]
          : [],
      )
    : [];
  const groupIds = new Set(groups.map((g) => g.id));
  const tabs: SessionTab[] = raw.tabs
    .slice(0, MAX_TABS)
    .filter(isObject)
    .flatMap((t) => {
      if (typeof t.url !== "string" || !isRestorableUrl(t.url)) return [];
      const pinned = t.pinned === true;
      const groupId = typeof t.groupId === "string" && groupIds.has(t.groupId) && !pinned ? t.groupId : undefined;
      const faviconUrl = isFaviconUrl(t.faviconUrl, MAX_SAVED_FAVICON_URL) ? t.faviconUrl : undefined;
      return [
        {
          url: t.url,
          title: typeof t.title === "string" ? t.title.slice(0, 500) : "",
          pinned,
          ...(groupId ? { groupId } : {}),
          ...(faviconUrl ? { faviconUrl } : {}),
        },
      ];
    });
  if (tabs.length === 0) return null;
  const used = new Set(tabs.map((t) => t.groupId));
  const activeIndex = isFiniteNumber(raw.activeIndex) ? Math.min(tabs.length - 1, Math.max(0, Math.floor(raw.activeIndex))) : 0;
  const bounds = reviveBounds(raw.bounds);
  return {
    profileId: raw.profileId,
    ...(bounds ? { bounds } : {}),
    maximized: raw.maximized === true,
    tabs,
    groups: groups.filter((g) => used.has(g.id)),
    activeIndex,
  };
}

/** Validate a session file. Anything malformed is dropped rather than failing the restore. */
export function reviveSession(raw: unknown): SessionSnapshot | null {
  if (!isObject(raw) || raw.version !== 1 || !Array.isArray(raw.windows)) return null;
  const windows = raw.windows
    .slice(0, MAX_WINDOWS)
    .map(reviveWindow)
    .filter((w): w is SessionWindow => w !== null);
  return { version: 1, savedAt: isFiniteNumber(raw.savedAt) ? raw.savedAt : 0, windows };
}

/** Windows to reopen: those whose profile still exists. */
export function restorePlan(snapshot: SessionSnapshot | null, profileIds: readonly string[]): SessionWindow[] {
  if (!snapshot) return [];
  const known = new Set(profileIds);
  return snapshot.windows.filter((w) => known.has(w.profileId));
}

/** Keep restored bounds only if the window's title bar area is on one of the current displays. */
export function visibleBounds(bounds: SessionBounds | undefined, workAreas: readonly SessionBounds[]): SessionBounds | undefined {
  if (!bounds) return undefined;
  const titleBar = { x: bounds.x, y: bounds.y, width: bounds.width, height: 40 };
  const onScreen = workAreas.some((a) => {
    const w = Math.min(titleBar.x + titleBar.width, a.x + a.width) - Math.max(titleBar.x, a.x);
    const h = Math.min(titleBar.y + titleBar.height, a.y + a.height) - Math.max(titleBar.y, a.y);
    return w >= 100 && h >= 20;
  });
  return onScreen ? bounds : undefined;
}
