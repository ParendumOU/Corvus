/** Height of page the toolbar band always leaves below it (a tall AI request bar scrolls inside). */
export const MIN_PAGE_HEIGHT = 200;
/** The band may always grow this far, even in a window too short to leave MIN_PAGE_HEIGHT. */
const MIN_CHROME_CAP = 400;

/** Height the toolbar band (tab strip, toolbar, bars under it) gets in a window `windowHeight` tall. */
export function chromeBandHeight(wanted: number, windowHeight: number): number {
  const cap = Math.max(MIN_CHROME_CAP, windowHeight - MIN_PAGE_HEIGHT);
  return Math.max(0, Math.min(cap, Math.round(wanted)));
}
