/**
 * Containers: tabs of one profile that keep their own cookies and site data, so a site opened in
 * "Work" does not know the session it has in "Personal" (Firefox Multi-Account Containers).
 * Each container is a session partition of its own; history, bookmarks and settings stay shared.
 */
import type { GroupColor } from "@corvus/shared";

export interface Container {
  id: string;
  name: string;
  color: GroupColor;
}

/** What a tab in a container shows: a coloured mark and the container's name. */
export type TabContainer = Container;

export const DEFAULT_CONTAINERS: readonly Container[] = [
  { id: "personal", name: "Personal", color: "blue" },
  { id: "work", name: "Work", color: "orange" },
  { id: "shopping", name: "Shopping", color: "pink" },
  { id: "banking", name: "Banking", color: "green" },
];

export const CONTAINER_COLORS: readonly GroupColor[] = ["blue", "cyan", "green", "yellow", "orange", "red", "pink", "purple", "grey"];

const MAX_NAME = 40;
const ID_RE = /^[a-z0-9-]{1,40}$/;

/** The session partition of a container of the profile whose partition is `profilePartition`. */
export function containerPartition(profilePartition: string, containerId: string): string {
  return `${profilePartition}-ctr-${containerId}`;
}

export function isContainerColor(value: unknown): value is GroupColor {
  return typeof value === "string" && (CONTAINER_COLORS as readonly string[]).includes(value);
}

/** A trimmed, length-capped name, or null when nothing is left. */
export function cleanContainerName(name: unknown): string | null {
  if (typeof name !== "string") return null;
  const clean = name.replace(/\s+/g, " ").trim().slice(0, MAX_NAME);
  return clean || null;
}

/** A new id from a name ("Side project" → "side-project"), unique among `taken`. */
export function containerIdFor(name: string, taken: ReadonlySet<string>): string {
  const base =
    name
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32) || "container";
  let id = base;
  for (let n = 2; taken.has(id); n += 1) id = `${base}-${n}`;
  return id;
}

/** The stored list, keeping only well-formed containers (first of each id wins). */
export function reviveContainers(raw: unknown): Container[] {
  if (!Array.isArray(raw)) return [...DEFAULT_CONTAINERS];
  const seen = new Set<string>();
  const out: Container[] = [];
  for (const item of raw) {
    const c = (item ?? {}) as Record<string, unknown>;
    const name = cleanContainerName(c.name);
    if (typeof c.id !== "string" || !ID_RE.test(c.id) || seen.has(c.id) || !name) continue;
    seen.add(c.id);
    out.push({ id: c.id, name, color: isContainerColor(c.color) ? c.color : "grey" });
  }
  return out;
}
