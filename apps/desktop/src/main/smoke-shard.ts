/**
 * How long each smoke step takes, in seconds (from the "[smoke] step" lines of a sharded run).
 * Only used to split the steps into shares of about the same length: a missing or stale entry makes
 * the shares less even, never skips a step.
 */
export const SMOKE_STEP_SECONDS: Readonly<Record<string, number>> = {
  chromeShot: 1,
  favicon: 6,
  pages: 9,
  search: 16,
  sync: 3,
  settingsLayout: 11,
  ipcBridge: 1,
  browser: 45,
  downloads: 22,
  split: 4,
  ux: 21,
  signIn: 4,
  newTab: 3,
  chromeUi: 2,
  tabSelect: 1,
  tabWindows: 3,
  bookmarksBar: 2,
  sleep: 12,
  media: 2,
  certError: 9,
  externalApps: 10,
  tabClose: 35,
  viewSource: 6,
  userAction: 15,
  mcpService: 1,
  assist: 12,
  dictation: 3,
  dialogs: 1,
  library: 1,
  features: 5,
  localModels: 1,
  phone: 1,
  grabber: 8,
  connections: 1,
  private: 2,
  cookieConsent: 9,
  defaultBrowser: 2,
  browserImport: 2,
  passwordImport: 7,
  dpapi: 13,
  liveHistory: 19,
  downloadAi: 1,
  profileTransfer: 1,
  reader: 2,
  pdf: 3,
  credentials: 118,
  authenticatorImport: 18,
  otpFill: 35,
  addresses: 9,
  cards: 12,
  frameFill: 19,
  similarLogins: 2,
  passwordGenerator: 26,
  identifierFirst: 14,
  backup: 11,
  annotations: 2,
  agent: 24,
  scheduledAgent: 1,
  agentRuns: 1,
  flows: 3,
  workflows: 10,
  siteMemory: 7,
  assistAgent: 15,
  agentIsolation: 9,
  webscope: 61,
  profileLock: 11,
  tray: 2,
  extension: 89,
  bgTabs: 25,
};

const DEFAULT_STEP_SECONDS = 10;

/** How long a step may run before it counts as hung: four times its usual time, and never under 3 minutes (a busy machine). */
export function stepDeadlineMs(name: string): number {
  return Math.max(180, 4 * (SMOKE_STEP_SECONDS[name] ?? DEFAULT_STEP_SECONDS)) * 1000;
}

/**
 * The items of share k of n (spec "k/n", 1-based), in their original order: the longest items go
 * first to the share with the least so far, so the shares take about as long. No spec = all items.
 */
export function smokeShard<T>(items: readonly T[], seconds: (item: T) => number | undefined, spec: string | undefined): T[] {
  if (!spec) return [...items];
  const match = /^(\d+)\/(\d+)$/.exec(spec.trim());
  const k = match ? Number(match[1]) : 0;
  const n = match ? Number(match[2]) : 0;
  if (n < 1 || k < 1 || k > n) throw new Error(`CORVUS_SMOKE_SHARD must be k/n with 1 <= k <= n, not "${spec}"`);
  const weight = (i: number): number => seconds(items[i]!) ?? DEFAULT_STEP_SECONDS;
  const load = new Array<number>(n).fill(0);
  const shareOf = new Array<number>(items.length);
  const longestFirst = items.map((_, i) => i).sort((a, b) => weight(b) - weight(a) || a - b);
  for (const i of longestFirst) {
    const share = load.indexOf(Math.min(...load));
    shareOf[i] = share;
    load[share]! += weight(i);
  }
  return items.filter((_, i) => shareOf[i] === k - 1);
}
