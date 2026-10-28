/**
 * The bit of Markdown Corvus's answers use, parsed for drawing with the app's own text styles
 * (components/answer-text.tsx). Pure, so it is tested as is. Unclosed marks (an answer still being
 * written) stay as typed until they close.
 */

export type Block =
  | { kind: 'paragraph'; text: string }
  | { kind: 'heading'; text: string }
  | { kind: 'quote'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'list'; ordered: boolean; start: number; items: string[] };

export type Inline =
  | { kind: 'text'; text: string }
  | { kind: 'bold'; text: string }
  | { kind: 'italic'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'link'; text: string; url: string }
  | { kind: 'cite'; n: number };

const BULLET = /^\s*[-*•+]\s+/;
const NUMBER = /^\s*(\d{1,3})[.)]\s+/;

/** The answer's blocks, in order. */
export function markdownBlocks(markdown: string): Block[] {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  const flush = (): void => {
    if (paragraph.length) blocks.push({ kind: 'paragraph', text: paragraph.join('\n') });
    paragraph = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^\s*```/.test(line)) {
      flush();
      const code: string[] = [];
      for (i++; i < lines.length && !/^\s*```/.test(lines[i]!); i++) code.push(lines[i]!);
      blocks.push({ kind: 'code', text: code.join('\n') });
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    const heading = /^\s{0,3}#{1,6}\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      blocks.push({ kind: 'heading', text: heading[1]!.replace(/\s*#+\s*$/, '') });
      continue;
    }
    if (/^\s*>/.test(line)) {
      flush();
      const quoted = [line.replace(/^\s*>\s?/, '')];
      while (i + 1 < lines.length && /^\s*>/.test(lines[i + 1]!)) quoted.push(lines[++i]!.replace(/^\s*>\s?/, ''));
      blocks.push({ kind: 'quote', text: quoted.join('\n') });
      continue;
    }
    const number = NUMBER.exec(line);
    if (BULLET.test(line) || number) {
      flush();
      const ordered = !!number;
      const items: string[] = [];
      let j = i;
      for (; j < lines.length; j++) {
        const l = lines[j]!;
        if (ordered ? NUMBER.test(l) : BULLET.test(l)) items.push(l.replace(ordered ? NUMBER : BULLET, ''));
        else if (l.trim() && /^\s{2,}/.test(l) && items.length) items[items.length - 1] += ` ${l.trim()}`;
        else break;
      }
      blocks.push({ kind: 'list', ordered, start: number ? Number(number[1]) : 1, items });
      i = j - 1;
      continue;
    }
    paragraph.push(line);
  }
  flush();
  return blocks;
}

const INLINE = /(\*\*([^*\n]+)\*\*|__([^_\n]+)__|`([^`\n]+)`|\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)|\[(\d{1,2})\]|(?<![\w*])\*([^*\s](?:[^*\n]*[^*\s])?)\*(?![\w*])|(?<!\w)_([^_\s](?:[^_\n]*[^_\s])?)_(?!\w))/g;

/** A block's text as runs of plain text, marks, links and citations of `sources` sources. */
export function markdownInline(text: string, sources: number): Inline[] {
  const out: Inline[] = [];
  let at = 0;
  const push = (part: Inline): void => {
    const prev = out[out.length - 1];
    if (part.kind === 'text' && prev?.kind === 'text') prev.text += part.text;
    else out.push(part);
  };
  for (const m of text.matchAll(INLINE)) {
    const start = m.index;
    if (start > at) push({ kind: 'text', text: text.slice(at, start) });
    at = start + m[0].length;
    if (m[2] ?? m[3]) push({ kind: 'bold', text: (m[2] ?? m[3])! });
    else if (m[4]) push({ kind: 'code', text: m[4] });
    else if (m[5] && m[6]) push({ kind: 'link', text: m[5], url: m[6] });
    else if (m[7]) {
      const n = Number(m[7]);
      push(n >= 1 && n <= sources ? { kind: 'cite', n } : { kind: 'text', text: m[0] });
    } else if (m[8] ?? m[9]) push({ kind: 'italic', text: (m[8] ?? m[9])! });
  }
  if (at < text.length) push({ kind: 'text', text: text.slice(at) });
  return out;
}
