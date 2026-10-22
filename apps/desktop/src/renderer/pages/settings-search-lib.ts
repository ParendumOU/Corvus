export interface SectionIndexEntry {
  title: string;
  description: string;
  rows: Array<{ label: string; hint: string }>;
}

export interface SectionMatch {
  /** The section has at least one visible row (or its heading matched). */
  visible: boolean;
  /** Title or description matched, so the whole section is surfaced. */
  sectionHit: boolean;
  /** Per-row visibility, index-aligned with entry.rows. */
  rowVisible: boolean[];
}

export function normalizeQuery(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, " ");
}

export function matchSection(entry: SectionIndexEntry, nq: string): SectionMatch {
  if (!nq) {
    return { visible: true, sectionHit: false, rowVisible: entry.rows.map(() => true) };
  }
  const has = (text: string): boolean => text.toLowerCase().includes(nq);
  if (has(entry.title) || has(entry.description)) {
    return { visible: true, sectionHit: true, rowVisible: entry.rows.map(() => true) };
  }
  const rowVisible = entry.rows.map((r) => has(r.label) || has(r.hint));
  return { visible: rowVisible.some(Boolean), sectionHit: false, rowVisible };
}

/** All [start, end) offsets of nq inside text, case-insensitive, non-overlapping. */
export function findRanges(text: string, nq: string): Array<[number, number]> {
  if (!nq) return [];
  const hay = text.toLowerCase();
  const out: Array<[number, number]> = [];
  let i = hay.indexOf(nq);
  while (i !== -1) {
    out.push([i, i + nq.length]);
    i = hay.indexOf(nq, i + nq.length);
  }
  return out;
}
