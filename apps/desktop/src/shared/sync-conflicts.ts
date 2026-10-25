import type { SyncCollection } from "@corvus/shared";

/**
 * Collections whose local changes Corvus keeps when a change from another device replaced them
 * (the newer remote change wins; the person can bring theirs back in Settings > Sync). Not saved
 * logins (no secrets in this file), history, open tabs and other device records (machine data), or
 * workflows and site memory (they merge on their own).
 */
export const CONFLICT_COLLECTIONS = ["bookmarks", "settings", "reading", "watches", "workspaces", "annotations"] as const satisfies readonly SyncCollection[];
export type ConflictCollection = (typeof CONFLICT_COLLECTIONS)[number];

export const isConflictCollection = (c: string): c is ConflictCollection => (CONFLICT_COLLECTIONS as readonly string[]).includes(c);

/** A local change that lost, as kept on disk until the person decides. */
export interface StoredConflict {
  id: string;
  collection: ConflictCollection;
  recordId: string;
  /** This device's version; null when this device had deleted the record. */
  local: unknown;
  /** The version that was applied; null when another device deleted it. */
  remote: unknown;
  at: number;
}

/** One conflict for Settings > Sync. Texts are the records' own (titles, values), never translated. */
export interface SyncConflictView {
  id: string;
  collection: ConflictCollection;
  /** What the record is: a bookmark's title, a setting's key, a page's title. */
  name: string;
  /** This device's version in one line; null when this device had deleted it. */
  local: string | null;
  /** The version now in use; null when another device deleted it. */
  remote: string | null;
  at: number;
}

const MAX_TEXT = 160;

const clip = (s: string): string => (s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT - 1)}…` : s);
const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** What the record is, from whichever version still exists. */
export function conflictName(collection: ConflictCollection, recordId: string, payload: unknown): string {
  const p = obj(payload);
  switch (collection) {
    case "settings":
      return recordId;
    case "bookmarks":
      return clip(str(p.title) || str(p.url) || recordId);
    case "reading":
    case "watches":
      return clip(str(p.title) || str(p.url) || recordId);
    case "workspaces":
      return clip(str(p.name) || recordId);
    case "annotations":
      return clip(str(p.pageTitle) || hostOf(str(p.url)) || recordId);
  }
}

/** One version in one line, or null for a deletion. */
export function conflictVersion(collection: ConflictCollection, payload: unknown): string | null {
  if (payload === null || payload === undefined) return null;
  const p = obj(payload);
  switch (collection) {
    case "settings": {
      const value = JSON.stringify(p.v);
      return clip(value === undefined ? "" : value);
    }
    case "bookmarks":
      return clip([str(p.title), str(p.url)].filter(Boolean).join(" — "));
    case "reading":
      return clip([str(p.title), hostOf(str(p.url))].filter(Boolean).join(" — "));
    case "watches":
      return clip([str(p.title), str(p.condition)].filter(Boolean).join(" · "));
    case "workspaces": {
      // Its name, then the titles of its first tabs.
      const tabs = (Array.isArray(p.tabs) ? p.tabs : []).map((tab) => str(obj(tab).title) || hostOf(str(obj(tab).url))).filter(Boolean);
      return clip([str(p.name), tabs.slice(0, 3).join(", ")].filter(Boolean).join(" · "));
    }
    case "annotations":
      return clip(str(p.note) || str(obj(p.anchor).quote));
  }
}

export function conflictView(c: StoredConflict): SyncConflictView {
  return {
    id: c.id,
    collection: c.collection,
    name: conflictName(c.collection, c.recordId, c.local ?? c.remote),
    local: conflictVersion(c.collection, c.local),
    remote: conflictVersion(c.collection, c.remote),
    at: c.at,
  };
}

/**
 * This device's version brought back as a new change: stores that keep the newer edit by their own
 * `updatedAt` (bookmarks, workspaces, annotations) would otherwise keep the version in use.
 */
export function freshVersion(payload: unknown, now: number): unknown {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
  return typeof (payload as { updatedAt?: unknown }).updatedAt === "number" ? { ...payload, updatedAt: now } : payload;
}
