/**
 * Where the person is in the app, so Corvus comes back there when Android builds its screen again
 * (the app ended in the background to free memory, or a change the activity does not take in place)
 * instead of starting over on Home. Android then starts the activity with RESTORE_LINK
 * (plugins/with-restore-link.js) and the router opens the place kept here (hooks/use-route-memory.ts).
 */

/** The link MainActivity starts with when Android builds it again from its saved state. */
export const RESTORE_LINK = 'corvus://restore';

/** After Android ended the app, the place comes back only if the app left the screen less than this ago. */
export const RESTORE_WITHIN_MS = 30 * 60_000;

const TABS = ['index', 'assist', 'library', 'settings'];

/** The params a screen can be opened with again; the others are one-shot (a link the browser opens) or the router's own. */
const KEPT_PARAMS: Record<string, string[]> = { 'chat/[id]': ['id', 'assist', 'page'], open: ['url', 'from'] };

export interface Place {
  /** The screen on top, as a path the router opens: "/library", "/chat/abc?assist=1", "/browser". */
  path: string;
  /** The tab under it, or on screen when the path is a tab's. */
  tab: string;
  /** When the app left the screen (ms). */
  leftAt?: number;
}

export interface RouteLike {
  name: string;
  key?: string;
  params?: object;
  state?: StateLike;
}

export interface StateLike {
  key?: string;
  index?: number;
  routes: RouteLike[];
  routeNames?: string[];
}

export function isRestoreLink(path: string): boolean {
  return /^corvus:\/\/restore\/?$/i.test(path.trim());
}

export function tabPath(tab: string): string {
  return tab === 'index' ? '/' : `/${tab}`;
}

const focused = (state: StateLike | undefined): RouteLike | undefined => state?.routes[state.index ?? state.routes.length - 1];

/** The root stack's state (under expo-router's slot route), from the navigation container's state. */
function rootStack(root: StateLike | undefined): StateLike | undefined {
  const slot = focused(root);
  return slot?.name === '__root' ? slot.state : undefined;
}

/** A screen's path with its params: "chat/[id]" with { id: "abc" } is "/chat/abc". */
export function routePath(name: string, params: object = {}): string {
  const values = params as Record<string, unknown>;
  const kept = (KEPT_PARAMS[name] ?? []).filter((key) => typeof values[key] === 'string' && values[key] !== '');
  const inPath = new Set<string>();
  const path = name.replace(/\[(\w+)\]/g, (_, key: string) => {
    inPath.add(key);
    return encodeURIComponent(String(values[key] ?? ''));
  });
  const query = kept.filter((key) => !inPath.has(key)).map((key) => `${key}=${encodeURIComponent(values[key] as string)}`);
  return `/${path}${query.length ? `?${query.join('&')}` : ''}`;
}

/** Where the person is, from the navigation container's state (null before the root stack has one). */
export function placeOf(root: StateLike | undefined): Place | null {
  const stack = rootStack(root);
  const top = focused(stack);
  if (!stack || !top) return null;
  const tabs = stack.routes.find((route) => route.name === '(tabs)');
  const tabName = focused(tabs?.state)?.name;
  const tab = tabName && TABS.includes(tabName) ? tabName : 'index';
  if (top.name === '(tabs)') return { path: tabPath(tab), tab };
  return { path: routePath(top.name, top.params), tab };
}

export function serializePlace(place: Place): string {
  return JSON.stringify(place);
}

export function parsePlace(raw: string | null): Place | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<Place>;
    if (typeof value.path !== 'string' || !value.path.startsWith('/') || typeof value.tab !== 'string' || !TABS.includes(value.tab)) return null;
    return { path: value.path, tab: value.tab, ...(typeof value.leftAt === 'number' ? { leftAt: value.leftAt } : {}) };
  } catch {
    return null;
  }
}

/**
 * The place to bring back when Android builds the screen again: always while the app still runs (the
 * activity alone was built again), and after Android ended the app only when it left the screen less
 * than RESTORE_WITHIN_MS ago. A place without the time it left (the app ended while on screen, as in a
 * crash) never comes back.
 */
export function placeToRestore(saved: Place | null, sameRun: boolean, now: number): Place | null {
  if (!saved) return null;
  if (sameRun) return saved;
  if (saved.leftAt === undefined) return null;
  const away = now - saved.leftAt;
  return away >= 0 && away < RESTORE_WITHIN_MS ? saved : null;
}

/**
 * The action that puts `tab` back under a screen opened over the tabs (the router opened the tabs on
 * Home under it), or null when it is already there.
 */
export function tabUnder(root: StateLike | undefined, tab: string): { type: 'JUMP_TO'; payload: { name: string }; target: string } | null {
  const stack = rootStack(root);
  const tabs = stack?.routes.find((route) => route.name === '(tabs)')?.state;
  if (!tabs?.key || focused(stack)?.name === '(tabs)' || focused(tabs)?.name === tab) return null;
  if (!(tabs.routeNames ?? tabs.routes.map((route) => route.name)).includes(tab)) return null;
  return { type: 'JUMP_TO', payload: { name: tab }, target: tabs.key };
}
