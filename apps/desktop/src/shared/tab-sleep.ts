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

/** Electron's process.getSystemMemoryInfo(), in KB. */
export interface SystemMemory {
  total: number;
  free: number;
  swapTotal?: number;
  swapFree?: number;
}

/**
 * Share of memory still free: the tighter of physical memory and, on Windows, the commit limit.
 * There swapTotal/swapFree are the commit limit (RAM + page file) and what is left of it: a page
 * dies when an allocation would pass that limit, even with RAM to spare. Elsewhere they are only
 * the swap space, which says nothing about pressure.
 */
export function memoryFreeShare(info: SystemMemory, windows: boolean): number {
  const physical = info.free / Math.max(1, info.total);
  if (!windows || !info.swapTotal || info.swapFree === undefined) return physical;
  return Math.min(physical, info.swapFree / info.swapTotal);
}
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

/**
 * Ends of a page's process that loading the page again can get over: out of memory, a crash, a kill
 * from outside. Not a process that could not start, nor one Chromium ended for a security breach.
 */
export function pageCanComeBack(reason: string): boolean {
  return reason === "oom" || reason === "crashed" || reason === "abnormal-exit" || reason === "killed";
}

/** A page on screen is reloaded by itself after its process died at most once in this long. */
export const CRASH_RELOAD_GAP_MS = 5 * 60_000;

/** True when the page on screen may be reloaded by itself: it was not already, recently (a page that keeps dying shows the recovery page). */
export function mayReloadCrashedPage(lastReloadAt: number | undefined, now: number): boolean {
  return lastReloadAt === undefined || now - lastReloadAt >= CRASH_RELOAD_GAP_MS;
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
