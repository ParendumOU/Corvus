/**
 * What the person ran from the Command Bar: tasks for the agent, and web searches and addresses
 * typed there (history and bookmarks picked from the bar are history already). Shown as "Recent"
 * when the bar opens empty, kept per profile, and synced end to end when the person leaves
 * "Sync Command Bar history" on.
 */
export type CommandRecentKind = "agent" | "search" | "url";

export interface CommandRecent {
  id: string;
  kind: CommandRecentKind;
  text: string;
  at: number;
}

/** Kept per profile (and on the chain): the newest this many. */
export const MAX_COMMAND_RECENTS = 50;
/** Shown when the Command Bar opens empty. */
export const SHOWN_COMMAND_RECENTS = 8;
export const MAX_COMMAND_TEXT = 2000;

const KINDS: readonly CommandRecentKind[] = ["agent", "search", "url"];

/** The same entry typed twice is one recent (case and spacing do not count). */
export const recentKey = (kind: CommandRecentKind, text: string): string => `${kind}:${text.trim().replace(/\s+/g, " ").toLowerCase()}`;

/** A recent from storage or the sync chain; null when it is not one. */
export function parseCommandRecent(raw: unknown, id: string): CommandRecent | null {
  if (!raw || typeof raw !== "object") return null;
  const v = raw as Record<string, unknown>;
  const kind = KINDS.find((k) => k === v.kind);
  const text = typeof v.text === "string" ? v.text.trim().slice(0, MAX_COMMAND_TEXT) : "";
  if (!kind || !text || typeof v.at !== "number" || !Number.isFinite(v.at) || !id) return null;
  return { id, kind, text, at: Math.round(v.at) };
}

/**
 * Newest first, one per kind and text (the newest wins), at most MAX_COMMAND_RECENTS. Used for a
 * new entry and for entries arriving from other devices alike.
 */
export function mergeRecents(list: readonly CommandRecent[]): CommandRecent[] {
  const seen = new Set<string>();
  const out: CommandRecent[] = [];
  for (const r of [...list].sort((a, b) => b.at - a.at || a.id.localeCompare(b.id))) {
    const key = recentKey(r.kind, r.text);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
    if (out.length >= MAX_COMMAND_RECENTS) break;
  }
  return out;
}

/** The synced payload (the record id is the recent's id). */
export const recentPayload = (r: CommandRecent): { kind: CommandRecentKind; text: string; at: number } => ({ kind: r.kind, text: r.text, at: r.at });
