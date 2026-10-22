/** Tab organizer: candidate selection, domain grouping fallback, duplicates. Pure and tested. */
import type { GroupColor, TabId } from "@corvus/shared";
import { GROUP_COLORS } from "./tab-strip";

export interface OrganizerTab {
  id: TabId;
  title: string;
  url: string;
  pinned: boolean;
  active: boolean;
  groupId?: string;
  faviconUrl?: string;
}

export interface GroupProposal {
  name: string;
  color: GroupColor;
  tabIds: TabId[];
}

export interface DuplicateTab {
  tabId: TabId;
  title: string;
  url: string;
  /** The tab that stays open. */
  keepId: TabId;
}

export interface OrganizerProposal {
  source: "ai" | "domain";
  groups: GroupProposal[];
  duplicates: DuplicateTab[];
  tabs: Array<Pick<OrganizerTab, "id" | "title" | "url" | "faviconUrl">>;
  usage: { inputTokens: number; outputTokens: number; model: string; cached: boolean } | null;
  /** Why the AI proposal was not used (no provider, error). */
  note: string | null;
}

const TWO_LEVEL_SUFFIXES = new Set([
  "co.uk", "org.uk", "ac.uk", "gov.uk", "com.au", "net.au", "org.au", "co.jp", "ne.jp", "or.jp", "co.nz", "com.br", "com.mx",
  "com.ar", "co.in", "co.kr", "com.cn", "com.tr", "co.za", "com.sg", "com.hk", "github.io", "gitlab.io", "vercel.app", "netlify.app",
]);

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

/** eTLD+1 approximation: "docs.github.com" -> "github.com", "bbc.co.uk" stays "bbc.co.uk". */
export function siteOf(url: string): string {
  const host = hostOf(url).replace(/^www\./, "");
  if (!host || /^[\d.]+$/.test(host) || host.includes(":")) return host;
  const parts = host.split(".");
  if (parts.length <= 2) return host;
  const lastTwo = parts.slice(-2).join(".");
  return TWO_LEVEL_SUFFIXES.has(lastTwo) ? parts.slice(-3).join(".") : lastTwo;
}

/** Web tabs the organizer may regroup: not pinned, not already in a group. */
export function organizerCandidates(tabs: OrganizerTab[]): OrganizerTab[] {
  return tabs.filter((t) => !t.pinned && !t.groupId && /^https?:/i.test(t.url));
}

/** "github.com" -> "GitHub"-ish label: first label, capitalized. */
export function siteLabel(site: string): string {
  const first = site.split(".")[0] ?? site;
  return first ? first.charAt(0).toUpperCase() + first.slice(1) : site;
}

/** Fallback without AI: one group per site that has at least two candidate tabs. */
export function groupByDomain(tabs: OrganizerTab[]): GroupProposal[] {
  const bySite = new Map<string, TabId[]>();
  for (const t of organizerCandidates(tabs)) {
    const site = siteOf(t.url);
    if (!site) continue;
    bySite.set(site, [...(bySite.get(site) ?? []), t.id]);
  }
  return [...bySite.entries()]
    .filter(([, ids]) => ids.length >= 2)
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 8)
    .map(([site, tabIds], i) => ({ name: siteLabel(site), color: GROUP_COLORS[(i + 1) % GROUP_COLORS.length]!, tabIds }));
}

/** URL identity for duplicate detection: ignores fragment, trailing slash, "www." and scheme. */
export function duplicateKey(url: string): string {
  try {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) return "";
    const path = u.pathname.replace(/\/+$/, "");
    const params = [...u.searchParams.entries()].sort(([a], [b]) => a.localeCompare(b));
    const query = params.length ? `?${new URLSearchParams(params).toString()}` : "";
    return `${u.hostname.replace(/^www\./, "").toLowerCase()}${path}${query}`;
  } catch {
    return "";
  }
}

/** Every tab that duplicates another; the active tab (else the first, else a pinned one) is kept. */
export function findDuplicates(tabs: OrganizerTab[]): DuplicateTab[] {
  const byKey = new Map<string, OrganizerTab[]>();
  for (const t of tabs) {
    const key = duplicateKey(t.url);
    if (key) byKey.set(key, [...(byKey.get(key) ?? []), t]);
  }
  const out: DuplicateTab[] = [];
  for (const group of byKey.values()) {
    if (group.length < 2) continue;
    const keep = group.find((t) => t.active) ?? group.find((t) => t.pinned) ?? group[0]!;
    for (const t of group) {
      if (t.id !== keep.id && !t.pinned) out.push({ tabId: t.id, title: t.title, url: t.url, keepId: keep.id });
    }
  }
  return out;
}

/** Maps the model's 0-based tab indices (into `candidates`) to tab ids, dropping anything stale. */
export function proposalsFromIndices(
  groups: Array<{ name: string; color: string; tabs: number[] }>,
  candidates: OrganizerTab[],
): GroupProposal[] {
  return groups
    .map((g, i) => ({
      name: g.name,
      color: (GROUP_COLORS as readonly string[]).includes(g.color) ? (g.color as GroupColor) : GROUP_COLORS[(i + 1) % GROUP_COLORS.length]!,
      tabIds: g.tabs.map((n) => candidates[n]?.id).filter((id): id is TabId => typeof id === "string"),
    }))
    .filter((g) => g.name && g.tabIds.length >= 2);
}

/** Sanitizes groups coming back from the preview UI before they are applied. */
export function sanitizeGroupsToApply(raw: unknown, knownTabs: ReadonlySet<TabId>): GroupProposal[] {
  if (!Array.isArray(raw)) return [];
  const used = new Set<TabId>();
  const out: GroupProposal[] = [];
  for (const g of raw.slice(0, 12)) {
    if (!g || typeof g !== "object") continue;
    const v = g as Record<string, unknown>;
    const name = typeof v.name === "string" ? v.name.replace(/\s+/g, " ").trim().slice(0, 80) : "";
    const color = (GROUP_COLORS as readonly string[]).includes(String(v.color)) ? (v.color as GroupColor) : "grey";
    const ids = (Array.isArray(v.tabIds) ? v.tabIds : []).filter(
      (id): id is TabId => typeof id === "string" && knownTabs.has(id) && !used.has(id),
    );
    if (ids.length === 0) continue;
    ids.forEach((id) => used.add(id));
    out.push({ name, color, tabIds: ids });
  }
  return out;
}
