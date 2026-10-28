/**
 * Following an answer while a computer writes it: the chat polls the chain's `asks` alone (one
 * small request) often while something moves, then less and less, and remembers on the phone's own
 * clock when each question last changed (a computer's clock can be off from the phone's). Pure, so
 * it is tested as is.
 */
import type { AskRecord } from '@corvus/shared';

/** How often the chat looks for more of an answer while it moves (the computer writes about every 500 ms). */
export const POLL_FAST_MS = 600;
/** The slowest it looks while a question is still open (a computer not picking it up). */
export const POLL_SLOW_MS = 4_000;
/** How long after the last change it keeps looking fast. */
export const FAST_FOR_MS = 20_000;
/** How often the device list is fetched again while following (who is online). */
export const DEVICES_EVERY_MS = 5_000;

/** The wait before the next look, given when anything last moved. */
export function pollDelay(now: number, lastChange: number): number {
  const quiet = now - lastChange;
  if (quiet < FAST_FOR_MS) return POLL_FAST_MS;
  return Math.min(POLL_SLOW_MS, POLL_FAST_MS + Math.round((quiet - FAST_FOR_MS) / 10));
}

const mark = (a: AskRecord): string => `${a.state}|${a.updatedAt}|${a.answer.length}|${a.error}`;

/**
 * When each question last changed, on the phone's clock: questions that are new or changed since
 * `before` get `now`, the others keep their time; questions that are gone are dropped.
 */
export function movedAt(previous: Readonly<Record<string, number>>, before: readonly AskRecord[], after: readonly AskRecord[], now: number): Record<string, number> {
  const old = new Map(before.map((a) => [a.id, mark(a)]));
  const out: Record<string, number> = {};
  for (const a of after) out[a.id] = old.get(a.id) === mark(a) && previous[a.id] !== undefined ? previous[a.id]! : now;
  return out;
}

/** The latest change among the open questions (for pollDelay); `fallback` when none is open. */
export function lastMove(asks: readonly AskRecord[], moved: Readonly<Record<string, number>>, fallback: number): number {
  let latest = -Infinity;
  for (const a of asks) if (a.state === 'waiting' || a.state === 'answering') latest = Math.max(latest, moved[a.id] ?? a.askedAt);
  return latest === -Infinity ? fallback : latest;
}
