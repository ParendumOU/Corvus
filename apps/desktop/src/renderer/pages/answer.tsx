import type { ReactNode } from "react";

/**
 * Minimal, safe Markdown subset for AI answers: paragraphs, headings, bullet/numbered lists,
 * **bold**, *italic*, `code`, http(s) links and [n] citations. Produces React nodes, never HTML.
 */

export type CitationRenderer = (n: number, key: string) => ReactNode;

const INLINE = /(\*\*[^*]+\*\*|\*[^*\s][^*]*\*|`[^`]+`|\[\d+(?:\s*,\s*\d+)*\]|\[[^\]]+\]\(https?:\/\/[^)\s]+\))/g;

function inline(text: string, cite: CitationRenderer, keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let i = 0;
  for (const match of text.matchAll(INLINE)) {
    const token = match[0];
    const start = match.index ?? 0;
    if (start > last) out.push(text.slice(last, start));
    const key = `${keyBase}-${i++}`;
    if (token.startsWith("**")) out.push(<strong key={key}>{token.slice(2, -2)}</strong>);
    else if (token.startsWith("`")) out.push(<code key={key}>{token.slice(1, -1)}</code>);
    else if (token.startsWith("*")) out.push(<em key={key}>{token.slice(1, -1)}</em>);
    else if (/^\[\d/.test(token)) {
      const numbers = token.slice(1, -1).split(",").map((n) => Number(n.trim()));
      numbers.forEach((n, j) => out.push(cite(n, `${key}-${j}`)));
    } else {
      const m = /^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)$/.exec(token);
      if (m) {
        out.push(
          <a key={key} href={m[2]}>
            {m[1]}
          </a>,
        );
      } else out.push(token);
    }
    last = start + token.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function renderAnswer(text: string, cite: CitationRenderer): ReactNode[] {
  const blocks: ReactNode[] = [];
  const lines = text.replace(/\r/g, "").split("\n");
  let para: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  let key = 0;

  const flushPara = (): void => {
    if (para.length > 0) {
      const k = `p${key++}`;
      blocks.push(<p key={k}>{inline(para.join(" "), cite, k)}</p>);
      para = [];
    }
  };
  const flushList = (): void => {
    if (list) {
      const k = `l${key++}`;
      const items = list.items.map((item, i) => <li key={`${k}-${i}`}>{inline(item, cite, `${k}-${i}`)}</li>);
      blocks.push(list.ordered ? <ol key={k}>{items}</ol> : <ul key={k}>{items}</ul>);
      list = null;
    }
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    const bullet = /^\s*[-*•]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    const heading = /^#{1,4}\s+(.*)$/.exec(line);
    if (!line.trim()) {
      flushPara();
      flushList();
    } else if (heading) {
      flushPara();
      flushList();
      const k = `h${key++}`;
      blocks.push(<h3 key={k}>{inline(heading[1] ?? "", cite, k)}</h3>);
    } else if (bullet || numbered) {
      flushPara();
      const ordered = Boolean(numbered);
      if (!list || list.ordered !== ordered) {
        flushList();
        list = { ordered, items: [] };
      }
      list.items.push((bullet ?? numbered)?.[1] ?? "");
    } else {
      flushList();
      para.push(line.trim());
    }
  }
  flushPara();
  flushList();
  return blocks;
}
