/**
 * "Compare tabs with Corvus AI": which tabs the picker offers and ticks, and the comparison table
 * as Markdown for the clipboard. Pure, so it unit-tests without Electron.
 */
import type { TabId } from "@corvus/shared";

/** Most pages one comparison reads (matches the AI engine's limit). */
export const MAX_COMPARE_TABS = 6;

export interface CompareCandidate {
  tabId: TabId;
  title: string;
  url: string;
  faviconUrl?: string;
  checked: boolean;
}

export interface ComparisonTable {
  pages: Array<{ tabId: TabId; title: string; url: string; faviconUrl?: string }>;
  rows: Array<{ label: string; values: string[] }>;
  verdict: string;
}

/**
 * The window's web pages the picker lists, with the right-clicked tab ticked and, when it is in a
 * group, the group's other pages too (up to the limit).
 */
export function compareCandidates(
  tabs: ReadonlyArray<{ id: TabId; title: string; url: string; faviconUrl?: string; groupId?: string }>,
  fromTabId: TabId,
): CompareCandidate[] {
  const web = tabs.filter((t) => /^https?:\/\//i.test(t.url));
  const from = web.find((t) => t.id === fromTabId);
  let ticked = 0;
  return web.map((t) => {
    const checked = (t.id === fromTabId || (from?.groupId !== undefined && t.groupId === from.groupId)) && ticked < MAX_COMPARE_TABS;
    if (checked) ticked += 1;
    return { tabId: t.id, title: t.title, url: t.url, ...(t.faviconUrl ? { faviconUrl: t.faviconUrl } : {}), checked };
  });
}

const mdCell = (text: string): string => text.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim() || " ";

/** The table as Markdown, pages as columns, then the verdict. */
export function comparisonMarkdown(table: ComparisonTable): string {
  const head = `| | ${table.pages.map((p) => mdCell(p.title || p.url)).join(" | ")} |`;
  const rule = `|---|${table.pages.map(() => "---").join("|")}|`;
  const rows = table.rows.map((r) => `| ${mdCell(r.label)} | ${r.values.map(mdCell).join(" | ")} |`);
  return [head, rule, ...rows, ...(table.verdict ? ["", table.verdict] : [])].join("\n");
}
