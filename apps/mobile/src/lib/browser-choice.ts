/**
 * Corvus as the phone's default browser (Android): which real browser app opens web pages, and how
 * a page leaves the app so that it never comes back to Corvus itself. Pure logic; the native side
 * is in modules/default-browser and the glue in lib/default-browser.ts.
 */

/** A browser app installed on the phone (never Corvus itself). */
export interface BrowserApp {
  /** Android package name, e.g. com.android.chrome. */
  packageName: string;
  /** The app's name, as the launcher shows it. */
  label: string;
}

/** What the app remembers about browsers (AsyncStorage). */
export interface BrowserPrefs {
  /** The browser picked in Settings → Default browser → Open pages in. */
  chosen: string | null;
  /** The phone's default browser the last time it was not Corvus. */
  previousDefault: string | null;
}

/**
 * The browser that opens pages: the one picked in Settings while it is still installed, else the
 * one that was the default browser before Corvus, else the current default (when it is not
 * Corvus), else the first one found.
 */
export function pickBrowser(installed: readonly BrowserApp[], prefs: BrowserPrefs, systemDefault: string | null): BrowserApp | null {
  const find = (packageName: string | null): BrowserApp | undefined => (packageName ? installed.find((b) => b.packageName === packageName) : undefined);
  return find(prefs.chosen) ?? find(prefs.previousDefault) ?? find(systemDefault) ?? installed[0] ?? null;
}

/**
 * The default browser to remember: the system's current one when it is a real browser (installed
 * never lists Corvus, and no default at all is null), otherwise what was remembered before.
 */
export function rememberedDefault(stored: string | null, systemDefault: string | null, installed: readonly BrowserApp[]): string | null {
  return systemDefault && installed.some((b) => b.packageName === systemDefault) ? systemDefault : stored;
}

/** Where the choices are kept: AsyncStorage on the phone, a map in tests. */
export interface PrefsStore {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}

export const PREF_KEYS = {
  chosen: 'corvus.browser.chosen',
  previousDefault: 'corvus.browser.previousDefault',
  offerDismissed: 'corvus.browser.offerDismissed',
} as const;

export async function loadBrowserPrefs(store: PrefsStore): Promise<BrowserPrefs & { offerDismissed: boolean }> {
  const [chosen, previousDefault, offerDismissed] = await Promise.all([
    store.getItem(PREF_KEYS.chosen),
    store.getItem(PREF_KEYS.previousDefault),
    store.getItem(PREF_KEYS.offerDismissed),
  ]);
  return { chosen: chosen || null, previousDefault: previousDefault || null, offerDismissed: offerDismissed === '1' };
}

/**
 * The browser that opens pages now, remembering the system's default browser while it is a real
 * one (so it is still known once Corvus takes its place).
 */
export async function resolveBrowser(
  store: PrefsStore,
  installed: readonly BrowserApp[],
  systemDefault: string | null,
): Promise<{ browser: BrowserApp | null; prefs: BrowserPrefs & { offerDismissed: boolean } }> {
  const prefs = await loadBrowserPrefs(store);
  const previousDefault = rememberedDefault(prefs.previousDefault, systemDefault, installed);
  if (previousDefault && previousDefault !== prefs.previousDefault) await store.setItem(PREF_KEYS.previousDefault, previousDefault);
  const next = { ...prefs, previousDefault };
  return { browser: pickBrowser(installed, next, systemDefault), prefs: next };
}

/** Browsers by name, as Settings lists them; one package once. */
export function sortBrowsers(installed: readonly BrowserApp[]): BrowserApp[] {
  const seen = new Set<string>();
  return installed
    .filter((b) => b.packageName !== '' && !seen.has(b.packageName) && seen.add(b.packageName))
    .sort((a, b) => a.label.localeCompare(b.label) || a.packageName.localeCompare(b.packageName));
}

/** How a web page leaves the app. */
export type OpenRoute =
  /** The web build: a new browser tab. */
  | { via: 'window' }
  /** The system picks the app, as before (iOS; Android while Corvus is not the default browser). */
  | { via: 'system' }
  /** Straight to this browser app, so the page cannot come back to Corvus. */
  | { via: 'package'; packageName: string }
  /** Corvus would have to send it to itself: there is no other browser app to open it. */
  | { via: 'none' };

/**
 * The route for a page. `skipCorvus` is true whenever the system could hand the page back to
 * Corvus: Corvus is the default browser, or the page came in as a link Corvus was asked to open
 * (the person may have picked Corvus "just once").
 */
export function openRoute(platform: string, skipCorvus: boolean, browser: BrowserApp | null): OpenRoute {
  if (platform === 'web') return { via: 'window' };
  if (platform !== 'android' || !skipCorvus) return { via: 'system' };
  return browser ? { via: 'package', packageName: browser.packageName } : { via: 'none' };
}

/**
 * Whether Home offers to make Corvus the default browser: on Android, once paired, while the
 * system lets apps ask for the role, Corvus does not hold it and the offer was never dismissed.
 */
export function offerDefaultBrowser(state: { platform: string; paired: boolean; canAsk: boolean; isDefault: boolean; dismissed: boolean }): boolean {
  return state.platform === 'android' && state.paired && state.canAsk && !state.isDefault && !state.dismissed;
}
