/**
 * Sleeping tabs: a background tab that has not been used for a while gives its memory back (its
 * page is unloaded) and wakes up where it was when you return, history and form values included.
 * Pure rules here; main/tab-sleeper.ts and BrowserWindowCtl.sleepTab do the work.
 */

export interface SleepCandidate {
  id: string;
  url: string;
  /** When the tab was last shown (epoch ms); undefined when it never was since it loaded. */
  lastShownAt: number | undefined;
  /** When the tab was opened (epoch ms): a tab opened in the background and never shown counts from here. */
  openedAt: number;
  shown: boolean;
  pinned: boolean;
  audible: boolean;
  loading: boolean;
  agentControlled: boolean;
  crashed: boolean;
  /** Already unloaded: asleep, or restored and never shown. */
  unloaded: boolean;
}

/**
 * Tabs that may go to sleep now: web pages out of sight for at least `afterMinutes`, unless they
 * play sound, an AI agent drives them, they are still loading or crashed, or they are pinned
 * (pinning is how you keep mail or chat awake).
 */
export function tabsToSleep(tabs: readonly SleepCandidate[], now: number, afterMinutes: number): string[] {
  const limit = afterMinutes * 60_000;
  return sleepable(tabs)
    .filter((t) => now - idleSince(t) >= limit)
    .map((t) => t.id);
}

/** Free memory below this share of the total puts background tabs to sleep early. */
export const LOW_MEMORY_SHARE = 0.1;
/** Tabs put to sleep per pass under memory pressure (the least recently used first). */
export const PRESSURE_BATCH = 3;

/**
 * Under memory pressure: the background tabs that may sleep, least recently used first, a few per
 * pass, without waiting for the delay (like Chrome's memory saver).
 */
export function tabsToSleepUnderPressure(tabs: readonly SleepCandidate[], freeShare: number): string[] {
  if (freeShare >= LOW_MEMORY_SHARE) return [];
  return [...sleepable(tabs)]
    .sort((a, b) => idleSince(a) - idleSince(b))
    .slice(0, PRESSURE_BATCH)
    .map((t) => t.id);
}

/** Since when the tab has been out of sight: last shown, or opened if it never was. */
function idleSince(t: SleepCandidate): number {
  return t.lastShownAt ?? t.openedAt;
}

function sleepable(tabs: readonly SleepCandidate[]): SleepCandidate[] {
  return tabs.filter(
    (t) => /^https?:/i.test(t.url) && !t.shown && !t.unloaded && !t.pinned && !t.audible && !t.loading && !t.agentControlled && !t.crashed,
  );
}

/**
 * Runs in a page before it sleeps: true when the person typed into it (a changed field or an
 * editable area with focus), which keeps the tab awake so nothing written is lost.
 */
export const EDITED_PAGE_SCRIPT = `(() => {
  const active = document.activeElement;
  if (active && (active.isContentEditable || /^(input|textarea|select)$/i.test(active.tagName))) return true;
  for (const el of document.querySelectorAll("input, textarea")) {
    if (el.type === "hidden" || el.type === "submit" || el.type === "button") continue;
    if ((el.type === "checkbox" || el.type === "radio") ? el.checked !== el.defaultChecked : el.value !== el.defaultValue) return true;
  }
  return false;
})()`;

/** Process memory to show next to a tab, in MB (one decimal under 10 MB). */
export function formatMemory(kilobytes: number): string {
  const mb = kilobytes / 1024;
  return mb < 10 ? `${mb.toFixed(1)} MB` : `${Math.round(mb)} MB`;
}
