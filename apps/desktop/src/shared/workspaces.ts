/**
 * Named workspaces: a saved set of tabs and groups a user can reopen, replace the window with, or
 * merge into the current window. Pure so the save/restore/merge plan is unit tested; the per-profile
 * JSON store and the window wiring live in main/.
 */
import type { GroupColor, TabGroup } from "@corvus/shared";
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
  groupCount: number;
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

/** Build a workspace from a window's live tabs and groups. Unsaveable tabs (corvus://chrome, etc.) drop. */
export function workspaceFromWindow(
  name: string,
  liveTabs: readonly LiveTab[],
  liveGroups: readonly TabGroup[],
  id: string,
  now: number,
): Workspace {
  const kept = liveTabs.filter((t) => isRestorableUrl(t.url)).slice(0, MAX_TABS);
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

export function summarize(ws: Workspace): WorkspaceSummary {
  return { id: ws.id, name: ws.name, createdAt: ws.createdAt, updatedAt: ws.updatedAt, tabCount: ws.tabs.length, groupCount: ws.groups.length };
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

export interface MaterializedTab {
  url: string;
  title: string;
  pinned: boolean;
  groupId?: string;
}

export interface MaterializedWorkspace {
  tabs: MaterializedTab[];
  groups: TabGroup[];
}

/**
 * Prepare a workspace to be opened in a window. Group ids are regenerated (via `newId`) so that
 * merging into a window that already has groups never collides, and reopening the same workspace
 * twice yields independent groups. Collapsed state and colors are preserved.
 */
export function materializeWorkspace(ws: Workspace, newId: () => string): MaterializedWorkspace {
  const remap = new Map<string, string>();
  const groups: TabGroup[] = ws.groups.map((g) => {
    const id = newId();
    remap.set(g.id, id);
    return { id, title: g.title, color: g.color, collapsed: g.collapsed };
  });
  const tabs: MaterializedTab[] = ws.tabs.map((t) => {
    const groupId = t.groupId ? remap.get(t.groupId) : undefined;
    return { url: t.url, title: t.title, pinned: t.pinned, ...(groupId ? { groupId } : {}) };
  });
  return { tabs, groups };
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
