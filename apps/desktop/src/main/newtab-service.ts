/**
 * The New Tab dashboard of each profile: its layout (newtab.json, with an undo history), uploaded
 * background pictures (newtab-media/), the data custom widgets read, and the changes MCP agents
 * make through the newtab_* tools. Widgets only ever get data from the sources they declared;
 * reading a page with the person's session needs their consent for that host, which agents cannot
 * give, and any change to a widget's sources by an agent takes that consent away again.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { dialog } from "electron";
import {
  WIDGET_TYPES,
  addWidget,
  customWidgetHosts,
  defaultLayout,
  pendingConsent,
  placeWidget,
  sanitizeBackground,
  sanitizeLayout,
  type NewTabLayout,
  type WallpaperSource,
  type WidgetConfigs,
  type WidgetInstance,
  type WidgetType,
} from "../shared/newtab";
import type { NewTabView, PageSnapshot, WallpaperView } from "../shared/newtab-ipc";
import type { AppContext } from "./context";
import { JsonFile } from "./json-file";
import { feedSource, fetchSource, wallpaper } from "./newtab-data";
import { PageSourceReader } from "./newtab-page-source";
import { holdsPrivateData, widgetDocument } from "./newtab-widget-doc";
import type { ProfileRuntime } from "./profiles";
import type { BrowserWindowCtl } from "./window";

interface Stored {
  layout: NewTabLayout;
  /** Earlier layouts, newest first, for Undo. */
  history: NewTabLayout[];
}

const HISTORY = 20;
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
const IMAGE_TYPES: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif", ".avif": "image/avif" };
/** Built-ins agents add with newtab_add_widget; custom widgets go through newtab_custom_widget. */
const AGENT_BUILT_INS = new Set<WidgetType>(["greeting", "search", "shortcuts", "clock", "notes"]);

const hostOf = (url: string): string => new URL(url).hostname.toLowerCase();
const sameSources = (a: WidgetConfigs["custom"], b: WidgetConfigs["custom"]): boolean => JSON.stringify(a.sources) === JSON.stringify(b.sources);

export class NewTabService {
  private readonly files = new Map<string, JsonFile<Stored>>();
  private readonly pages = new PageSourceReader();

  constructor(private readonly ctx: AppContext) {}

  private file(runtime: ProfileRuntime): JsonFile<Stored> {
    let file = this.files.get(runtime.profile.id);
    if (!file) {
      file = JsonFile.load<Stored>(
        path.join(runtime.dataDir, "newtab.json"),
        () => ({ layout: defaultLayout(), history: [] }),
        (raw) => {
          const r = (raw ?? {}) as { layout?: unknown; history?: unknown };
          return { layout: sanitizeLayout(r.layout), history: Array.isArray(r.history) ? r.history.slice(0, HISTORY).map(sanitizeLayout) : [] };
        },
      );
      this.files.set(runtime.profile.id, file);
    }
    return file;
  }

  layout(runtime: ProfileRuntime): NewTabLayout {
    return this.file(runtime).get().layout;
  }

  view(runtime: ProfileRuntime): NewTabView {
    const stored = this.file(runtime).get();
    return {
      layout: stored.layout,
      profileName: runtime.profile.name,
      topSites: runtime.history.top(12).map((h) => ({ url: h.url, title: h.title, ...(h.faviconUrl ? { faviconUrl: h.faviconUrl } : {}) })),
      mcpRunning: this.ctx.mcp.isRunning(),
      canUndo: stored.history.length > 0,
    };
  }

  private commit(runtime: ProfileRuntime, next: NewTabLayout): void {
    this.file(runtime).update((s) => ({ layout: next, history: [s.layout, ...s.history].slice(0, HISTORY) }));
    this.cleanMedia(runtime);
    this.notify(runtime);
  }

  private notify(runtime: ProfileRuntime): void {
    for (const win of this.ctx.windows.all()) {
      if (win.profile === runtime) win.notifyInternalPages({ type: "newtab-changed" }, ["newtab"]);
    }
  }

  /** A layout from the page. Consent is never taken from it: only `consent` (a click) changes it. */
  save(runtime: ProfileRuntime, raw: unknown): NewTabView {
    const prev = this.layout(runtime);
    const next = sanitizeLayout(raw);
    next.widgets = next.widgets.map((w) => {
      if (w.type !== "custom") return w;
      const before = prev.widgets.find((p) => p.id === w.id && p.type === "custom") as WidgetInstance<"custom"> | undefined;
      const config = w.config as WidgetConfigs["custom"];
      const consent = before ? (before.config.consent ?? []).filter((h) => config.sources.some((s) => s.kind === "page" && hostOf(s.url) === h)) : [];
      return { ...w, config: { ...config, consent } };
    });
    this.commit(runtime, next);
    return this.view(runtime);
  }

  consent(runtime: ProfileRuntime, widgetId: string, hosts: string[]): NewTabView {
    const layout = this.layout(runtime);
    const widget = layout.widgets.find((w) => w.id === widgetId && w.type === "custom") as WidgetInstance<"custom"> | undefined;
    if (!widget) throw new Error("No such widget");
    const readable = new Set(widget.config.sources.filter((s) => s.kind === "page").map((s) => hostOf(s.url)));
    const consent = [...new Set(hosts.map((h) => h.toLowerCase()))].filter((h) => readable.has(h));
    this.commit(runtime, { ...layout, widgets: layout.widgets.map((w) => (w === widget ? { ...widget, config: { ...widget.config, consent } } : w)) });
    return this.view(runtime);
  }

  undo(runtime: ProfileRuntime): NewTabView {
    const file = this.file(runtime);
    const [previous, ...rest] = file.get().history;
    if (previous) {
      file.set({ layout: previous, history: rest });
      this.notify(runtime);
    }
    return this.view(runtime);
  }

  reset(runtime: ProfileRuntime): NewTabView {
    this.commit(runtime, defaultLayout());
    return this.view(runtime);
  }

  // --------------------------------------------------------------------------- backgrounds

  private mediaDir(runtime: ProfileRuntime): string {
    return path.join(runtime.dataDir, "newtab-media");
  }

  async pickImage(runtime: ProfileRuntime, window: BrowserWindowCtl | undefined): Promise<string | null> {
    const options: Electron.OpenDialogOptions = { properties: ["openFile"], filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp", "gif", "avif"] }] };
    const result = window ? await dialog.showOpenDialog(window.win, options) : await dialog.showOpenDialog(options);
    const source = result.filePaths[0];
    if (result.canceled || !source) return null;
    const ext = path.extname(source).toLowerCase();
    if (!IMAGE_TYPES[ext]) throw new Error("Choose a PNG, JPEG, WebP, GIF or AVIF picture.");
    if (fs.statSync(source).size > MAX_IMAGE_BYTES) throw new Error("Pictures up to 15 MB.");
    const name = `${crypto.randomUUID()}${ext === ".jpeg" ? ".jpg" : ext}`;
    fs.mkdirSync(this.mediaDir(runtime), { recursive: true });
    fs.copyFileSync(source, path.join(this.mediaDir(runtime), name));
    return name;
  }

  /** An uploaded picture for corvus://newtab/media/<file>, or null. */
  media(runtime: ProfileRuntime, file: string): { body: Buffer; type: string } | null {
    if (!/^[a-z0-9-]{8,64}\.(png|jpg|webp|gif|avif)$/i.test(file)) return null;
    try {
      return { body: fs.readFileSync(path.join(this.mediaDir(runtime), file)), type: IMAGE_TYPES[path.extname(file).toLowerCase()]! };
    } catch {
      return null;
    }
  }

  /** Removes uploaded pictures that neither the layout nor its undo history uses. */
  private cleanMedia(runtime: ProfileRuntime): void {
    const dir = this.mediaDir(runtime);
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      return;
    }
    const stored = this.file(runtime).get();
    const used = new Set([stored.layout, ...stored.history].flatMap((l) => (l.background.kind === "image" ? [l.background.file] : [])));
    for (const name of names) if (!used.has(name)) fs.rmSync(path.join(dir, name), { force: true });
  }

  wallpaper(source: WallpaperSource): Promise<WallpaperView | null> {
    return wallpaper(source);
  }

  // --------------------------------------------------------------------------- custom widgets

  private custom(runtime: ProfileRuntime, widgetId: string): WidgetConfigs["custom"] | null {
    const widget = this.layout(runtime).widgets.find((w) => w.id === widgetId && w.type === "custom");
    return widget ? (widget.config as WidgetConfigs["custom"]) : null;
  }

  /** The document for corvus://newtab/widget/<id>, or null. */
  widgetDoc(runtime: ProfileRuntime, widgetId: string, lang: string, tone: "light" | "dark" | null): { html: string; csp: string } | null {
    const config = this.custom(runtime, widgetId);
    return config ? widgetDocument(config, lang, tone) : null;
  }

  async customData(runtime: ProfileRuntime, widgetId: string): Promise<Record<string, unknown>> {
    const config = this.custom(runtime, widgetId);
    if (!config) return {};
    const entries = await Promise.all(
      config.sources.map(async (s): Promise<[string, unknown]> => {
        try {
          if (s.kind === "fetch") return [s.name, await fetchSource(s.url, s.everyMinutes)];
          if (s.kind === "feed") return [s.name, await feedSource(s.url, s.everyMinutes)];
          if (s.kind === "corvus") return [s.name, this.corvusData(runtime, s.url)];
          const host = hostOf(s.url);
          if (!config.consent.includes(host)) return [s.name, { error: `Waiting for you to allow reading ${host} with your session.`, consent: host }];
          const snap: PageSnapshot = await this.pages.read(runtime.session, s.url, s.select, s.everyMinutes, `${runtime.profile.id}:${widgetId}`);
          return [s.name, snap];
        } catch (err) {
          return [s.name, { error: err instanceof Error ? err.message : String(err) }];
        }
      }),
    );
    return Object.fromEntries(entries);
  }

  private corvusData(runtime: ProfileRuntime, what: string): unknown {
    if (what === "top-sites") return runtime.history.top(12).map((h) => ({ url: h.url, title: h.title }));
    return this.ctx.monitor
      .storeFor(runtime)
      .list()
      .map((w) => ({ url: w.url, title: w.title, changedAt: w.lastChangedAt, summary: w.changeSummary, unseen: w.unseen }));
  }

  /** Opens a link a custom widget asked for, only on hosts it may open or items its feeds list. */
  async openFromWidget(runtime: ProfileRuntime, window: BrowserWindowCtl | undefined, widgetId: string, raw: string): Promise<boolean> {
    const config = this.custom(runtime, widgetId);
    if (!config || !window) return false;
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return false;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    let hosts: Set<string>;
    if (holdsPrivateData(config)) {
      // A widget with private data may only open what that data points at, never an address its
      // code put data into.
      hosts = new Set(config.sources.filter((s) => s.kind === "page").map((s) => hostOf(s.url)));
      for (const s of config.sources) {
        if (s.kind !== "corvus") continue;
        for (const item of this.corvusData(runtime, s.url) as Array<{ url: string }>) {
          if (item.url === url.href) hosts.add(url.hostname.toLowerCase());
        }
      }
    } else {
      hosts = customWidgetHosts(config);
      // Feed items link anywhere; they are allowed one by one, as the feed lists them.
      for (const s of config.sources) {
        if (s.kind !== "feed" || hosts.has(url.hostname.toLowerCase())) continue;
        const items = await feedSource(s.url, s.everyMinutes).catch(() => []);
        if (items.some((i) => i.url === url.href)) hosts.add(url.hostname.toLowerCase());
      }
    }
    if (!hosts.has(url.hostname.toLowerCase())) return false;
    window.openUrl(url.href, "new-tab");
    return true;
  }

  // --------------------------------------------------------------------------- MCP agents

  /** Runs one newtab_* tool request against the profile's layout; returns the layout as JSON. */
  agent(runtime: ProfileRuntime, request: Record<string, unknown>, client: string): string {
    const layout = this.layout(runtime);
    const box = (r: Record<string, unknown>) =>
      Object.fromEntries((["x", "y", "w", "h"] as const).filter((k) => typeof r[k] === "number").map((k) => [k, r[k] as number])) as Partial<Record<"x" | "y" | "w" | "h", number>>;
    const find = (id: unknown): WidgetInstance => {
      const widget = layout.widgets.find((w) => w.id === id);
      if (!widget) throw new Error(`No widget ${JSON.stringify(id)} on the New Tab page. Call newtab_layout to see the ids.`);
      return widget;
    };
    const userConfig = (raw: unknown): Record<string, unknown> => {
      const { consent: _ignored, ...rest } = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
      return rest;
    };
    let next: NewTabLayout | null = null;
    switch (request.action) {
      case "get":
        break;
      case "add": {
        const type = request.type as WidgetType;
        if (!AGENT_BUILT_INS.has(type)) throw new Error(`Unknown widget type ${JSON.stringify(request.type)}; use newtab_custom_widget for anything else.`);
        next = sanitizeLayout(addWidget(layout, type, userConfig(request.config) as never, box(request)));
        break;
      }
      case "update": {
        const widget = find(request.id);
        let config = { ...widget.config, ...userConfig(request.config) } as WidgetInstance["config"];
        if (widget.type === "custom") {
          const before = widget.config as WidgetConfigs["custom"];
          const after = { ...(config as WidgetConfigs["custom"]), author: client };
          config = { ...after, consent: sameSources(before, after) ? before.consent : [] };
        }
        const changed = { ...layout, widgets: layout.widgets.map((w) => (w === widget ? { ...w, config } : w)) };
        next = sanitizeLayout(placeWidget(changed, widget.id, box(request)));
        break;
      }
      case "remove": {
        const widget = find(request.id);
        next = { ...layout, widgets: layout.widgets.filter((w) => w !== widget) };
        break;
      }
      case "background":
        next = { ...layout, background: sanitizeBackground(request.background) };
        if (next.background.kind === "image") throw new Error("Pictures are chosen by the person on the page.");
        break;
      case "custom": {
        const config = { ...userConfig(request.config), author: client } as Partial<WidgetConfigs["custom"]>;
        if (typeof request.id === "string" && request.id) {
          const widget = find(request.id);
          if (widget.type !== "custom") throw new Error(`${request.id} is a ${widget.type} widget, not a custom one.`);
          const before = widget.config as WidgetConfigs["custom"];
          const merged = sanitizeLayout({ ...layout, widgets: layout.widgets.map((w) => (w === widget ? { ...w, config: { ...config, consent: [] } } : w)) });
          const after = merged.widgets.find((w) => w.id === widget.id)!.config as WidgetConfigs["custom"];
          after.consent = sameSources(before, after) ? before.consent : [];
          next = placeWidget(merged, widget.id, box(request));
        } else {
          next = sanitizeLayout(addWidget(layout, "custom", { ...config, consent: [] }, box(request)));
        }
        break;
      }
      case "undo":
        this.undo(runtime);
        return this.summary(runtime);
      default:
        throw new Error(`Unknown action ${JSON.stringify(request.action)}`);
    }
    if (next) this.commit(runtime, next);
    return this.summary(runtime);
  }

  private summary(runtime: ProfileRuntime): string {
    const layout = this.layout(runtime);
    const waiting = layout.widgets.flatMap((w) => (w.type === "custom" ? pendingConsent(w.config as WidgetConfigs["custom"]).map((h) => `${w.id}: ${h}`) : []));
    return JSON.stringify(
      {
        background: layout.background,
        widgets: layout.widgets,
        widgetTypes: WIDGET_TYPES,
        ...(waiting.length ? { waitingForConsent: waiting, note: "The person must allow these hosts on the New Tab page before the widget can read them." } : {}),
      },
      null,
      1,
    );
  }

  flush(): void {
    for (const file of this.files.values()) file.flush();
  }
}
