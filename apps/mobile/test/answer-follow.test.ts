import { newAsk, type AskRecord } from '@corvus/shared';
import { describe, expect, it } from 'vitest';

import { FAST_FOR_MS, POLL_FAST_MS, POLL_SLOW_MS, lastMove, movedAt, pollDelay } from '../src/lib/answer-follow';

const ask = (id: string, extra: Partial<AskRecord> = {}): AskRecord => ({ id, ...newAsk('q', 'desk', 'phone', 'Pixel', 1000), ...extra });

describe('following an answer', () => {
  it('looks often while something moves, then backs off', () => {
    expect(pollDelay(10_000, 9_000)).toBe(POLL_FAST_MS);
    expect(POLL_FAST_MS).toBeGreaterThanOrEqual(500);
    expect(POLL_FAST_MS).toBeLessThanOrEqual(800);
    expect(pollDelay(FAST_FOR_MS + 5_000, 0)).toBeGreaterThan(POLL_FAST_MS);
    expect(pollDelay(10 * 60_000, 0)).toBe(POLL_SLOW_MS);
  });

  it('remembers on the phone when each question last changed', () => {
    const a = ask('a', { state: 'answering', answer: 'Up', updatedAt: 5 });
    const b = ask('b');
    let moved = movedAt({}, [], [a, b], 100);
    expect(moved).toEqual({ a: 100, b: 100 });
    moved = movedAt(moved, [a, b], [{ ...a, answer: 'Up to' }, b], 200);
    expect(moved).toEqual({ a: 200, b: 100 });
    expect(movedAt(moved, [a, b], [b], 300)).toEqual({ b: 100 });
  });

  it('takes the latest change among open questions', () => {
    const open = ask('a', { state: 'answering' });
    const done = ask('b', { state: 'done' });
    expect(lastMove([open, done], { a: 50, b: 90 }, 7)).toBe(50);
    expect(lastMove([done], { b: 90 }, 7)).toBe(7);
  });
});
