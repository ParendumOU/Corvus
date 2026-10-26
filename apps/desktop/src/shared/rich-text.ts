/**
 * The Markdown subset Corvus Assist draws in answers: paragraphs, headings, bullet and numbered
 * lists, quotes, fenced code, tables and rules; inside a line, **bold**, *italic*, `code`,
 * [links](https://…), bare https addresses and [n] section citations. Everything else stays text:
 * nothing here ever becomes HTML.
 */

export type Inline =
  | { kind: "text"; text: string }
  | { kind: "bold"; text: string }
  | { kind: "italic"; text: string }
  | { kind: "code"; text: string }
  | { kind: "link"; text: string; url: string }
  /** Section citations, 0-based ([2] → 1). */
  | { kind: "cite"; sections: number[] };

export type Align = "left" | "right" | "center";

export type RichBlock =
  | { kind: "paragraph"; text: string }
  | { kind: "heading"; level: 1 | 2 | 3; text: string }
  | { kind: "list"; ordered: boolean; start: number; items: string[] }
  | { kind: "quote"; text: string }
  | { kind: "code"; lang: string; code: string }
  | { kind: "table"; head: string[]; align: Align[]; rows: string[][] }
  | { kind: "rule" };

const FENCE = /^\s*(`{3,}|~{3,})\s*([\w+#.-]*)\s*$/;
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const BULLET = /^\s*[-*•+]\s+(.*)$/;
const ORDERED = /^\s*(\d{1,4})[.)]\s+(.*)$/;
const QUOTE = /^\s*>\s?(.*)$/;
const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/;
const TABLE_SEPARATOR = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

/** The cells of a "| a | b |" row (escaped pipes kept as text). */
function cells(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));
}

function alignOf(cell: string): Align {
  const c = cell.trim();
  if (c.startsWith(":") && c.endsWith(":")) return "center";
  if (c.endsWith(":")) return "right";
  return "left";
}

/** Splits an answer into blocks. Text is kept as written; inline marks are read by parseInline. */
export function parseBlocks(text: string): RichBlock[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const blocks: RichBlock[] = [];
  let para: string[] = [];
  // Lines of one paragraph keep their breaks (an address, a short poem): the panel shows them.
  const flushPara = (): void => {
    const joined = para.join("\n").trim();
    if (joined) blocks.push({ kind: "paragraph", text: joined });
    para = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const fence = FENCE.exec(line);
    if (fence) {
      flushPara();
      const marker = fence[1]!;
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.trim().startsWith(marker)) body.push(lines[i++]!);
      blocks.push({ kind: "code", lang: fence[2] ?? "", code: body.join("\n") });
      continue;
    }
    if (!line.trim()) {
      flushPara();
      continue;
    }
    // A table: a header row, then a separator row, then body rows.
    if (line.includes("|") && i + 1 < lines.length && TABLE_SEPARATOR.test(lines[i + 1]!) && lines[i + 1]!.includes("-")) {
      flushPara();
      const head = cells(line);
      const align = cells(lines[i + 1]!).map(alignOf);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && lines[i]!.includes("|") && lines[i]!.trim()) {
        const row = cells(lines[i]!);
        rows.push(head.map((_, j) => row[j] ?? ""));
        i++;
      }
      i--;
      blocks.push({ kind: "table", head, align: head.map((_, j) => align[j] ?? "left"), rows });
      continue;
    }
    if (RULE.test(line)) {
      flushPara();
      blocks.push({ kind: "rule" });
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      flushPara();
      const level = Math.min(3, heading[1]!.length) as 1 | 2 | 3;
      if (heading[2]) blocks.push({ kind: "heading", level, text: heading[2] });
      continue;
    }
    const bullet = BULLET.exec(line);
    const ordered = bullet ? null : ORDERED.exec(line);
    if (bullet || ordered) {
      flushPara();
      const isOrdered = Boolean(ordered);
      const items: string[] = [];
      const start = ordered ? Number(ordered[1]) : 1;
      while (i < lines.length) {
        const l = lines[i]!;
        const b = BULLET.exec(l);
        const o = b ? null : ORDERED.exec(l);
        if (isOrdered ? o : b) items.push((isOrdered ? o![2] : b![1])!.trim());
        else if (l.trim() && /^\s{2,}\S/.test(l) && items.length > 0) items[items.length - 1] += ` ${l.trim()}`;
        else break;
        i++;
      }
      i--;
      blocks.push({ kind: "list", ordered: isOrdered, start, items });
      continue;
    }
    const quote = QUOTE.exec(line);
    if (quote) {
      flushPara();
      const body: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i]!)) body.push(QUOTE.exec(lines[i++]!)![1]!);
      i--;
      blocks.push({ kind: "quote", text: body.join(" ").trim() });
      continue;
    }
    para.push(line.trim());
  }
  flushPara();
  return blocks;
}

/** http(s) addresses only; anything else stays text. */
function linkUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
}

const INLINE =
  /`([^`\n]+)`|\*\*([^*\n]+?)\*\*|__([^_\n]+?)__|\[([^\]\n]+)\]\((\S+?)\)|(?<![\w*])\*(?!\s)([^*\n]+?)(?<!\s)\*(?![\w*])|(?<![\w_])_(?!\s)([^_\n]+?)(?<!\s)_(?![\w_])|\[(\d+(?:\s*,\s*\d+)*)\]|(https?:\/\/[^\s<>()\]]+[^\s<>()\].,;:!?'"])/g;

/**
 * The marks in one line of text, in order. `sectionCount` limits which [n] become citations (the
 * rest stay text); 0 turns none into citations.
 */
export function parseInline(text: string, sectionCount = 0): Inline[] {
  const out: Inline[] = [];
  let last = 0;
  const push = (part: Inline): void => {
    const prev = out[out.length - 1];
    if (part.kind === "text" && prev?.kind === "text") prev.text += part.text;
    else out.push(part);
  };
  for (const m of text.matchAll(INLINE)) {
    const index = m.index!;
    if (index > last) push({ kind: "text", text: text.slice(last, index) });
    last = index + m[0].length;
    if (m[1] !== undefined) push({ kind: "code", text: m[1] });
    else if (m[2] !== undefined || m[3] !== undefined) push({ kind: "bold", text: (m[2] ?? m[3])! });
    else if (m[4] !== undefined) {
      const url = linkUrl(m[5]!);
      push(url ? { kind: "link", text: m[4], url } : { kind: "text", text: m[0] });
    } else if (m[6] !== undefined || m[7] !== undefined) push({ kind: "italic", text: (m[6] ?? m[7])! });
    else if (m[8] !== undefined) {
      const sections = m[8]
        .split(",")
        .map((n) => Number(n.trim()) - 1)
        .filter((n) => n >= 0 && n < sectionCount);
      push(sections.length ? { kind: "cite", sections } : { kind: "text", text: m[0] });
    } else if (m[9] !== undefined) {
      const url = linkUrl(m[9]);
      push(url ? { kind: "link", text: m[9], url } : { kind: "text", text: m[0] });
    }
  }
  if (last < text.length) push({ kind: "text", text: text.slice(last) });
  return out;
}
