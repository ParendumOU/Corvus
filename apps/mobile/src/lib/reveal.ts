/**
 * Writing an answer out on screen at a steady pace while it arrives in pieces (one every half second
 * or so): the shown part moves toward the latest text at a speed that grows with how far behind it
 * is, so it never jumps and never falls far behind. Pure, so it is tested as is.
 */

/** The slowest it writes, in characters per second. */
export const REVEAL_MIN_CPS = 40;
/** How far behind the latest text it aims to be while the answer streams in. */
export const REVEAL_LAG_MS = 1_200;
/** ...and once the answer is complete. */
export const REVEAL_FINISH_MS = 400;

/** How many characters are shown after `dtMs` more, out of `target`. */
export function revealStep(shown: number, target: number, dtMs: number, done: boolean): number {
  if (shown >= target) return target;
  const backlog = target - shown;
  const cps = Math.max(REVEAL_MIN_CPS, (backlog * 1000) / (done ? REVEAL_FINISH_MS : REVEAL_LAG_MS));
  return Math.min(target, shown + Math.max(1, Math.round((cps * dtMs) / 1000)));
}

/** How much of what was shown still stands when the text changes (the computer rewrote the start). */
export function keptLength(previous: string, shown: number, next: string): number {
  const limit = Math.min(shown, next.length);
  let i = 0;
  while (i < limit && previous.charCodeAt(i) === next.charCodeAt(i)) i++;
  return i;
}

/**
 * The first `n` characters of a Markdown answer, ready to draw: bold and code that have opened
 * are closed for now (so the text shows bold as it is written, not as asterisks that turn into bold
 * later), and a citation or link still being written ("[1", "[text](ht") waits until it is whole.
 */
export function partialMarkdown(text: string, n: number): string {
  if (n >= text.length) return text;
  let out = text.slice(0, n);
  const fences = out.match(/^\s*```/gm)?.length ?? 0;
  if (fences % 2 === 1) return out;
  out = out.replace(/\[[^\]\n]*\]\([^)\s]*$/, '').replace(/\[[^\]\n]{0,300}$/, '');
  // A lone `*` or `_` at the end is the start of a mark still being written.
  out = out.replace(/(\*{1,2}|_{1,2})$/, '');
  const lines = out.split('\n');
  let last = lines.pop()!;
  if ((last.match(/`/g)?.length ?? 0) % 2 === 1) last = last.replace(/\s+$/, '') + '`';
  else if ((last.match(/\*\*/g)?.length ?? 0) % 2 === 1) last = last.replace(/\s+$/, '') + '**';
  return [...lines, last].join('\n');
}
