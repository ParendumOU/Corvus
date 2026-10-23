/**
 * Named workspaces: a saved set of tabs that opens as one tab group in the current window. Saved
 * from the whole window or from one tab group; workspaces saved by older versions may hold several
 * groups and are flattened into one group when opened. Pure so the save/open plan is unit tested;
 * the per-profile JSON store and the window wiring live in main/.
 */
import type { GroupColor, TabGroup } from "@corvus/shared";
import { isNewTabUrl } from "./internal-urls";
import { GROUP_COLORS } from "./tab-strip";
import { isRestorableUrl, type SessionGroup, type SessionTab } from "./session-state";

export interface Workspace {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  tabs: SessionTab[];
  groups: SessionGroup[];
}

export interface WorkspaceSummary {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  tabCount: number;
}

const MAX_WORKSPACES = 100;
const MAX_TABS = 500;
const NAME_MAX = 80;

/** One live tab as handed in by the window layer. */
export interface LiveTab {
  url: string;
  title: string;
  pinned: boolean;
  groupId?: string;
}

/** Tabs worth saving in a workspace: restorable pages, but not empty new tab pages. */
export function isWorkspaceTabUrl(url: string): boolean {
  return isRestorableUrl(url) && !isNewTabUrl(url);
}

/** Build a workspace from a window's live tabs and groups. Unsaveable tabs (new tab pages, etc.) drop. */
export function workspaceFromWindow(
  name: string,
  liveTabs: readonly LiveTab[],
  liveGroups: readonly TabGroup[],
  id: string,
  now: number,
): Workspace {
  const kept = liveTabs.filter((t) => isWorkspaceTabUrl(t.url)).slice(0, MAX_TABS);
  const usedGroups = new Set(kept.filter((t) => !t.pinned).map((t) => t.groupId).filter((g): g is string => g !== undefined));
  const groups: SessionGroup[] = liveGroups
    .filter((g) => usedGroups.has(g.id))
    .map(({ id: gid, title, color, collapsed }) => ({ id: gid, title, color, collapsed }));
  const known = new Set(groups.map((g) => g.id));
  const tabs: SessionTab[] = kept.map(({ url, title, pinned, groupId }) => ({
    url,
    title,
    pinned,
    ...(groupId && known.has(groupId) && !pinned ? { groupId } : {}),
  }));
  return { id, name: cleanName(name), createdAt: now, updatedAt: now, tabs, groups };
}

export function cleanName(name: string): string {
  return name.replace(/\s+/g, " ").trim().slice(0, NAME_MAX);
}

/** The single group a workspace saved from a tab group stores (its id is local to the workspace). */
const SAVED_GROUP_ID = "g1";

function groupTabs(liveTabs: readonly LiveTab[]): SessionTab[] {
  return liveTabs
    .filter((t) => isWorkspaceTabUrl(t.url))
    .slice(0, MAX_TABS)
    .map(({ url, title }) => ({ url, title, pinned: false, groupId: SAVED_GROUP_ID }));
}

/**
 * Build a workspace from one tab group's tabs. Stored as a single group named after the workspace
 * (older versions open it as that group too), keeping the group's color for the next open.
 */
export function workspaceFromGroup(name: string, liveTabs: readonly LiveTab[], color: GroupColor, id: string, now: number): Workspace {
  const clean = cleanName(name) || "Workspace";
  const tabs = groupTabs(liveTabs);
  const groups: SessionGroup[] = tabs.length > 0 ? [{ id: SAVED_GROUP_ID, title: clean, color, collapsed: false }] : [];
  return { id, name: clean, createdAt: now, updatedAt: now, tabs, groups };
}

/** Re-save a workspace with a group's current tabs ("Update workspace"); name and creation time stay. */
export function updateWorkspaceTabs(ws: Workspace, liveTabs: readonly LiveTab[], color: GroupColor, now: number): Workspace {
  const next = workspaceFromGroup(ws.name, liveTabs, color, ws.id, now);
  return { ...next, createdAt: ws.createdAt };
}

/** "Workspace", then "Workspace 2", "Workspace 3", ... whichever is not taken yet. */
export function nextWorkspaceName(taken: readonly string[]): string {
  const names = new Set(taken.map((n) => n.toLowerCase()));
  if (!names.has("workspace")) return "Workspace";
  for (let n = 2; ; n++) if (!names.has(`workspace ${n}`)) return `Workspace ${n}`;
}

export function summarize(ws: Workspace): WorkspaceSummary {
  return { id: ws.id, name: ws.name, createdAt: ws.createdAt, updatedAt: ws.updatedAt, tabCount: ws.tabs.length };
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

function reviveGroups(raw: unknown): SessionGroup[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(isObject).flatMap((g) =>
    typeof g.id === "string" && typeof g.title === "string" && (GROUP_COLORS as readonly string[]).includes(g.color as string)
      ? [{ id: g.id, title: g.title.slice(0, NAME_MAX), color: g.color as GroupColor, collapsed: g.collapsed === true }]
      : [],
  );
}

export function reviveWorkspace(raw: unknown, now: number): Workspace | null {
  if (!isObject(raw) || typeof raw.id !== "string" || typeof raw.name !== "string" || !Array.isArray(raw.tabs)) return null;
  const groups = reviveGroups(raw.groups);
  const groupIds = new Set(groups.map((g) => g.id));
  const tabs: SessionTab[] = raw.tabs
    .slice(0, MAX_TABS)
    .filter(isObject)
    .flatMap((t) => {
      if (typeof t.url !== "string" || !isRestorableUrl(t.url)) return [];
      const pinned = t.pinned === true;
      const groupId = typeof t.groupId === "string" && groupIds.has(t.groupId) && !pinned ? t.groupId : undefined;
      return [{ url: t.url, title: typeof t.title === "string" ? t.title.slice(0, 500) : "", pinned, ...(groupId ? { groupId } : {}) }];
    });
  if (tabs.length === 0) return null;
  const used = new Set(tabs.map((t) => t.groupId));
  const name = cleanName(raw.name) || "Workspace";
  return {
    id: raw.id,
    name,
    createdAt: isNum(raw.createdAt) ? raw.createdAt : now,
    updatedAt: isNum(raw.updatedAt) ? raw.updatedAt : now,
    tabs,
    groups: groups.filter((g) => used.has(g.id)),
  };
}

export function reviveWorkspaces(raw: unknown, now: number): Workspace[] {
  if (!Array.isArray(raw)) return [];
  const out: Workspace[] = [];
  const seen = new Set<string>();
  for (const entry of raw.slice(0, MAX_WORKSPACES)) {
    const ws = reviveWorkspace(entry, now);
    if (ws && !seen.has(ws.id)) {
      seen.add(ws.id);
      out.push(ws);
    }
  }
  return out;
}

export interface WorkspaceOpenPlan {
  /** Title of the one tab group the workspace opens as: the workspace's name. */
  title: string;
  /** Color of the first saved group, if any (else the window picks the next free color). */
  color?: GroupColor;
  /** Every saved tab in saved order, flattened out of any groups, unpinned. */
  tabs: Array<{ url: string; title: string }>;
}

/** What opening a workspace creates: one group named after it holding all its tabs in order. */
export function workspaceOpenPlan(ws: Workspace): WorkspaceOpenPlan {
  const firstGroupId = ws.tabs.find((t) => t.groupId !== undefined)?.groupId;
  const color = ws.groups.find((g) => g.id === firstGroupId)?.color;
  return {
    title: ws.name,
    ...(color ? { color } : {}),
    tabs: ws.tabs.filter((t) => isWorkspaceTabUrl(t.url)).map(({ url, title }) => ({ url, title })),
  };
}

export function upsertWorkspace(list: readonly Workspace[], ws: Workspace): Workspace[] {
  const idx = list.findIndex((w) => w.id === ws.id);
  if (idx === -1) return [...list, ws].slice(-MAX_WORKSPACES);
  const next = [...list];
  next[idx] = ws;
  return next;
}

export function renameWorkspace(list: readonly Workspace[], id: string, name: string, now: number): Workspace[] {
  return list.map((w) => (w.id === id ? { ...w, name: cleanName(name) || w.name, updatedAt: now } : w));
}

export function removeWorkspace(list: readonly Workspace[], id: string): Workspace[] {
  return list.filter((w) => w.id !== id);
}
