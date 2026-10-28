import { describe, expect, it } from 'vitest';

import { REVEAL_MIN_CPS, keptLength, partialMarkdown, revealStep } from '../src/lib/reveal';

describe('writing an answer out at a steady pace', () => {
  it('never jumps: a big piece is written over about a second, not at once', () => {
    let shown = 0;
    const steps: number[] = [];
    for (let t = 0; t < 2000; t += 33) {
      shown = revealStep(shown, 600, 33, false);
      steps.push(shown);
    }
    expect(steps[0]).toBeLessThan(30);
    expect(steps[Math.floor(1000 / 33)]!).toBeGreaterThan(300);
    expect(steps.at(-1)).toBeGreaterThan(450);
    for (let i = 1; i < steps.length; i++) expect(steps[i]! - steps[i - 1]!).toBeLessThanOrEqual(30);
  });

  it('keeps a minimum pace near the end, and finishes faster once the answer is complete', () => {
    expect(revealStep(98, 100, 1000, false)).toBe(100);
    expect(revealStep(0, 1000, 100, false)).toBeLessThan(revealStep(0, 1000, 100, true));
    expect(revealStep(0, 10, 1000 / REVEAL_MIN_CPS, false)).toBe(1);
    expect(revealStep(50, 40, 33, false)).toBe(40);
  });

  it('keeps what still stands when the start of the text changes', () => {
    expect(keptLength('Ravens live long', 10, 'Ravens live long and well')).toBe(10);
    expect(keptLength('Ravens live long', 16, 'Ravens are')).toBe(7);
  });
});

describe('a partial Markdown answer', () => {
  it('shows bold and code as they are written', () => {
    expect(partialMarkdown('Ravens are **very clever** birds', 18)).toBe('Ravens are **very**');
    expect(partialMarkdown('Run `npm test` now', 9)).toBe('Run `npm`');
  });

  it('holds back a citation or a link until it is whole', () => {
    expect(partialMarkdown('Long lived [12] birds', 13)).toBe('Long lived ');
    expect(partialMarkdown('Long lived [1] birds', 14)).toBe('Long lived [1]');
    expect(partialMarkdown('See [the page](https://example.com) now', 22)).toBe('See ');
  });

  it('drops a mark that only started', () => {
    expect(partialMarkdown('Ravens are **very** clever', 13)).toBe('Ravens are ');
  });

  it('is the text itself once all of it is shown', () => {
    expect(partialMarkdown('a **b', 5)).toBe('a **b');
  });
});
