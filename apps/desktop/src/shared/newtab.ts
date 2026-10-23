/**
 * The New Tab dashboard: a background and widgets on a 12-column grid, per profile. Pure data and
 * layout rules shared by the page, the main process and the MCP tools. Anything stored or sent by
 * an agent goes through sanitizeLayout, so a bad value never reaches the page.
 */

export const GRID_COLUMNS = 12;
export const MAX_ROWS = 80;
export const MAX_WIDGETS = 40;
/** Caps for AI-built widgets, so one cannot fill the profile folder or the page. */
export const MAX_CUSTOM_CODE = 64 * 1024;
export const MAX_CUSTOM_SOURCES = 8;
export const MAX_SHORTCUTS = 40;
/** Reading a page with the person's session is heavier; it never runs more often than this. */
export const MIN_PAGE_MINUTES = 10;

export const WALLPAPER_SOURCES = ["bing", "wikimedia", "nasa", "picsum"] as const;
export type WallpaperSource = (typeof WALLPAPER_SOURCES)[number];

/** Plain backgrounds offered as swatches (the default keeps today's theme grey). */
export const BACKGROUND_SWATCHES = ["#1b1c1f", "#0f172a", "#1e1b4b", "#14281d", "#3b1d2e", "#2b2118", "#f6f7f9", "#e8ecf4", "#fdf6e3"] as const;

export type Background =
  | { kind: "default" }
  | { kind: "color"; color: string }
  | { kind: "image"; file: string; dim: number; blur: number }
  | { kind: "wallpaper"; source: WallpaperSource; dim: number; blur: number };

export const WIDGET_TYPES = ["greeting", "search", "shortcuts", "clock", "notes", "custom"] as const;
export type WidgetType = (typeof WIDGET_TYPES)[number];

export interface Shortcut {
  id: string;
  title: string;
  url: string;
}

/**
 * Where a custom widget gets its data, read by Corvus and handed to the widget:
 * - fetch: a public http(s) address, no cookies; JSON when it parses, otherwise text.
 * - feed: an RSS or Atom feed, as a list of {title, url, source, at}.
 * - page: a page loaded with the person's session (needs their consent per site): its title, the
 *   unread count sites put in it, and the text of `select` (a CSS selector) when given.
 * - corvus: Corvus's own data: "watches" (watched pages and their changes) or "top-sites".
 */
export const SOURCE_KINDS = ["fetch", "feed", "page", "corvus"] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];
export const CORVUS_SOURCES = ["watches", "top-sites"] as const;

export interface CustomSource {
  /** Key the widget reads its data under (corvus.data[name]). */
  name: string;
  kind: SourceKind;
  /** fetch, feed, page: the address. corvus: one of CORVUS_SOURCES. */
  url: string;
  /** page: CSS selector whose text to read (optional). */
  select: string;
  everyMinutes: number;
}

export interface WidgetConfigs {
  greeting: { name: string };
  search: Record<string, never>;
  shortcuts: { pinned: Shortcut[]; topSites: boolean; hidden: string[] };
  clock: { style: "digital" | "analog"; hour12: boolean; seconds: boolean; zones: string[] };
  notes: { text: string };
  custom: {
    title: string;
    html: string;
    css: string;
    script: string;
    sources: CustomSource[];
    /** Hosts its links may open, besides the hosts of its sources. */
    links: string[];
    /** Who made it ("you", an MCP client, a template). */
    author: string;
    /** Hosts the person allowed this widget to read with their session (page sources). */
    consent: string[];
  };
}

export interface WidgetInstance<T extends WidgetType = WidgetType> {
  id: string;
  type: T;
  x: number;
  y: number;
  w: number;
  h: number;
  config: WidgetConfigs[T];
}

export interface NewTabLayout {
  version: 1;
  background: Background;
  widgets: WidgetInstance[];
}

/** Smallest and default sizes per widget type, in grid cells (columns x rows of 48 px). */
export const WIDGET_SIZES: Record<WidgetType, { min: [number, number]; size: [number, number] }> = {
  greeting: { min: [4, 2], size: [12, 3] },
  search: { min: [4, 2], size: [8, 2] },
  shortcuts: { min: [3, 2], size: [8, 4] },
  clock: { min: [2, 2], size: [3, 3] },
  notes: { min: [2, 2], size: [3, 4] },
  custom: { min: [2, 2], size: [4, 4] },
};

export function defaultConfig<T extends WidgetType>(type: T): WidgetConfigs[T] {
  const configs: WidgetConfigs = {
    greeting: { name: "" },
    search: {},
    shortcuts: { pinned: [], topSites: true, hidden: [] },
    clock: { style: "digital", hour12: false, seconds: false, zones: [] },
    notes: { text: "" },
    custom: { title: "", html: "", css: "", script: "", sources: [], links: [], author: "", consent: [] },
  };
  return structuredClone(configs[type]);
}

/** Today's page: greeting, search and top sites, so nothing changes until the person customizes. */
export function defaultLayout(): NewTabLayout {
  return {
    version: 1,
    background: { kind: "default" },
    widgets: [
      { id: "greeting", type: "greeting", x: 0, y: 0, w: 12, h: 3, config: defaultConfig("greeting") },
      { id: "search", type: "search", x: 2, y: 3, w: 8, h: 2, config: defaultConfig("search") },
      { id: "shortcuts", type: "shortcuts", x: 2, y: 5, w: 8, h: 4, config: defaultConfig("shortcuts") },
    ],
  };
}

type Box = Pick<WidgetInstance, "x" | "y" | "w" | "h">;

const overlaps = (a: Box, b: Box): boolean => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** Keeps a widget inside the grid and at least its minimum size. */
export function clampBox<T extends Box & { type: WidgetType }>(box: T): T {
  const [minW, minH] = WIDGET_SIZES[box.type].min;
  const w = Math.max(minW, Math.min(GRID_COLUMNS, Math.round(box.w)));
  const h = Math.max(minH, Math.min(MAX_ROWS, Math.round(box.h)));
  const x = Math.max(0, Math.min(GRID_COLUMNS - w, Math.round(box.x)));
  const y = Math.max(0, Math.min(MAX_ROWS - h, Math.round(box.y)));
  return { ...box, x, y, w, h };
}

/**
 * Resolves overlaps after `pinnedId` moved or resized: it keeps its place, everything else floats
 * up as far as it can and drops below whatever is in its way (a column of cards).
 */
export function settle(widgets: WidgetInstance[], pinnedId?: string): WidgetInstance[] {
  const pinned = widgets.find((w) => w.id === pinnedId);
  const placed: WidgetInstance[] = pinned ? [pinned] : [];
  const rest = widgets.filter((w) => w !== pinned).sort((a, b) => a.y - b.y || a.x - b.x);
  for (const widget of rest) {
    let next = { ...widget };
    while (next.y > 0 && !placed.some((p) => overlaps({ ...next, y: next.y - 1 }, p))) next = { ...next, y: next.y - 1 };
    while (placed.some((p) => overlaps(next, p))) next = { ...next, y: next.y + 1 };
    placed.push(next);
  }
  return widgets.map((w) => placed.find((p) => p.id === w.id)!);
}

/** Moves or resizes one widget and lets the others make room. */
export function placeWidget(layout: NewTabLayout, id: string, box: Partial<Box>): NewTabLayout {
  const widgets = layout.widgets.map((w) => (w.id === id ? clampBox({ ...w, ...box }) : w));
  return { ...layout, widgets: settle(widgets, id) };
}

/** A free spot for a new widget: the first row where it fits, scanning left to right. */
export function freeSpot(widgets: Box[], w: number, h: number): { x: number; y: number } {
  for (let y = 0; y < MAX_ROWS - h; y++) {
    for (let x = 0; x + w <= GRID_COLUMNS; x++) {
      if (!widgets.some((o) => overlaps({ x, y, w, h }, o))) return { x, y };
    }
  }
  return { x: 0, y: Math.max(0, ...widgets.map((o) => o.y + o.h)) };
}

export function newWidgetId(type: WidgetType, taken: Iterable<string>): string {
  const used = new Set(taken);
  for (let n = 1; ; n++) {
    const id = `${type}-${n}`;
    if (!used.has(id)) return id;
  }
}

/** Adds a widget of `type` (defaults for anything not given) where it fits. */
export function addWidget<T extends WidgetType>(layout: NewTabLayout, type: T, config?: Partial<WidgetConfigs[T]>, box?: Partial<Box>): NewTabLayout {
  if (layout.widgets.length >= MAX_WIDGETS) throw new Error(`A New Tab page holds at most ${MAX_WIDGETS} widgets.`);
  const [w, h] = [box?.w ?? WIDGET_SIZES[type].size[0], box?.h ?? WIDGET_SIZES[type].size[1]];
  const spot = box?.x !== undefined && box?.y !== undefined ? { x: box.x, y: box.y } : freeSpot(layout.widgets, w, h);
  const widget = clampBox({
    id: newWidgetId(type, layout.widgets.map((x) => x.id)),
    type,
    ...spot,
    w,
    h,
    config: { ...defaultConfig(type), ...config } as WidgetConfigs[T],
  }) as WidgetInstance;
  return { ...layout, widgets: settle([...layout.widgets, widget], widget.id) };
}

// --------------------------------------------------------------------------------- sanitizing

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const text = (v: unknown, max: number, fallback = ""): string => (typeof v === "string" ? v.slice(0, max) : fallback);
const num = (v: unknown, min: number, max: number, fallback: number): number =>
  typeof v === "number" && Number.isFinite(v) ? Math.max(min, Math.min(max, v)) : fallback;
const bool = (v: unknown, fallback: boolean): boolean => (typeof v === "boolean" ? v : fallback);
const list = <T>(v: unknown, max: number, item: (x: unknown) => T | null): T[] =>
  Array.isArray(v) ? v.map(item).filter((x): x is T => x !== null).slice(0, max) : [];

/** http(s) URL as written, or null. */
export function webUrl(v: unknown): string | null {
  if (typeof v !== "string" || v.length > 2048) return null;
  try {
    const url = new URL(v.trim());
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

const hexColor = (v: unknown): string | null => (typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v) ? v.toLowerCase() : null);
const mediaFile = (v: unknown): string | null => (typeof v === "string" && /^[a-z0-9-]{8,64}\.(png|jpe?g|webp|gif|avif)$/i.test(v) ? v : null);

export function sanitizeBackground(v: unknown): Background {
  if (!isObject(v)) return { kind: "default" };
  const dim = num(v.dim, 0, 0.8, 0.25);
  const blur = num(v.blur, 0, 24, 0);
  if (v.kind === "color") {
    const color = hexColor(v.color);
    return color ? { kind: "color", color } : { kind: "default" };
  }
  if (v.kind === "image") {
    const file = mediaFile(v.file);
    return file ? { kind: "image", file, dim, blur } : { kind: "default" };
  }
  if (v.kind === "wallpaper" && (WALLPAPER_SOURCES as readonly unknown[]).includes(v.source)) {
    return { kind: "wallpaper", source: v.source as WallpaperSource, dim, blur };
  }
  return { kind: "default" };
}

function sanitizeConfig(type: WidgetType, v: unknown): WidgetConfigs[WidgetType] {
  const c = isObject(v) ? v : {};
  const base = defaultConfig(type);
  switch (type) {
    case "greeting":
      return { name: text(c.name, 60) };
    case "search":
      return {};
    case "shortcuts": {
      const d = base as WidgetConfigs["shortcuts"];
      return {
        pinned: list(c.pinned, MAX_SHORTCUTS, (s) => {
          if (!isObject(s)) return null;
          const url = webUrl(s.url);
          return url ? { id: text(s.id, 64) || `s${Math.abs(hashString(url))}`, title: text(s.title, 80), url } : null;
        }),
        topSites: bool(c.topSites, d.topSites),
        hidden: list(c.hidden, 200, (u) => webUrl(u)),
      };
    }
    case "clock":
      return {
        style: c.style === "analog" ? "analog" : "digital",
        hour12: bool(c.hour12, false),
        seconds: bool(c.seconds, false),
        zones: list(c.zones, 4, (z) => (typeof z === "string" && /^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+){0,2}$/.test(z) ? z : null)),
      };
    case "notes":
      return { text: text(c.text, 8000) };
    case "custom": {
      const sources = list(c.sources, MAX_CUSTOM_SOURCES, sanitizeSource);
      const pageHosts = new Set(sources.filter((x) => x.kind === "page").map((x) => new URL(x.url).hostname.toLowerCase()));
      return {
        title: text(c.title, 80),
        html: text(c.html, MAX_CUSTOM_CODE),
        css: text(c.css, MAX_CUSTOM_CODE),
        script: text(c.script, MAX_CUSTOM_CODE),
        sources,
        links: list(c.links, 20, hostName),
        author: text(c.author, 80),
        // Consent only ever covers hosts the widget reads now.
        consent: list(c.consent, MAX_CUSTOM_SOURCES, hostName).filter((h) => pageHosts.has(h)),
      };
    }
  }
}

const hostName = (h: unknown): string | null => (typeof h === "string" && /^[a-z0-9.-]{1,253}$/i.test(h) ? h.toLowerCase() : null);

function sanitizeSource(v: unknown): CustomSource | null {
  if (!isObject(v)) return null;
  const name = typeof v.name === "string" && /^[A-Za-z_][A-Za-z0-9_]{0,31}$/.test(v.name) ? v.name : null;
  const kind: SourceKind = (SOURCE_KINDS as readonly unknown[]).includes(v.kind) ? (v.kind as SourceKind) : "fetch";
  const url = kind === "corvus" ? ((CORVUS_SOURCES as readonly unknown[]).includes(v.url) ? (v.url as string) : null) : webUrl(v.url);
  if (!name || !url) return null;
  const min = kind === "page" ? MIN_PAGE_MINUTES : 1;
  return { name, kind, url, select: kind === "page" ? text(v.select, 200) : "", everyMinutes: Math.round(num(v.everyMinutes, min, 24 * 60, Math.max(min, 15))) };
}

function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return h;
}

/** A layout read from disk, the page or an agent, with every value checked; unusable widgets are dropped. */
export function sanitizeLayout(v: unknown): NewTabLayout {
  if (!isObject(v) || !Array.isArray(v.widgets)) return defaultLayout();
  const seen = new Set<string>();
  const widgets: WidgetInstance[] = [];
  for (const raw of v.widgets.slice(0, MAX_WIDGETS)) {
    if (!isObject(raw) || !(WIDGET_TYPES as readonly unknown[]).includes(raw.type)) continue;
    const type = raw.type as WidgetType;
    const id = typeof raw.id === "string" && /^[A-Za-z0-9_-]{1,40}$/.test(raw.id) && !seen.has(raw.id) ? raw.id : newWidgetId(type, seen);
    seen.add(id);
    const [w, h] = WIDGET_SIZES[type].size;
    widgets.push(
      clampBox({
        id,
        type,
        x: num(raw.x, 0, GRID_COLUMNS, 0),
        y: num(raw.y, 0, MAX_ROWS, 0),
        w: num(raw.w, 1, GRID_COLUMNS, w),
        h: num(raw.h, 1, MAX_ROWS, h),
        config: sanitizeConfig(type, raw.config),
      }) as WidgetInstance,
    );
  }
  return { version: 1, background: sanitizeBackground(v.background), widgets: settle(widgets) };
}

/** Hosts a custom widget may open: its links plus the hosts of its web data sources. */
export function customWidgetHosts(config: WidgetConfigs["custom"]): Set<string> {
  const hosts = new Set(config.links);
  for (const s of config.sources) if (s.kind !== "corvus") hosts.add(new URL(s.url).hostname.toLowerCase());
  return hosts;
}

/** Hosts a custom widget would read with the person's session that they have not allowed yet. */
export function pendingConsent(config: WidgetConfigs["custom"]): string[] {
  const hosts = config.sources.filter((s) => s.kind === "page").map((s) => new URL(s.url).hostname.toLowerCase());
  return [...new Set(hosts)].filter((h) => !config.consent.includes(h));
}
