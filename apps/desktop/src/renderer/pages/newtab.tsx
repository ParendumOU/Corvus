import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import {
  GRID_COLUMNS,
  addWidget,
  defaultConfig,
  placeWidget,
  type Background,
  type NewTabLayout,
  type WidgetConfigs,
  type WidgetInstance,
  type WidgetType,
} from "../../shared/newtab";
import type { NewTabView, WallpaperView } from "../../shared/newtab-ipc";
import { errorMessage, internalApi } from "../common/api";
import { t } from "../common/i18n";
import { IconAgent, IconEdit, IconSettings } from "../common/icons";
import { AddWidgetPanel, BackgroundPanel, WidgetSettingsPanel, withConfig } from "./newtab-panels";
import type { WidgetTemplate } from "./newtab-templates";
import { ClockWidget, CustomWidget, GreetingWidget, NotesWidget, SearchWidget, ShortcutsWidget, type WidgetProps } from "./newtab-widgets";
import { mount } from "./shell";
import "./newtab.css";

const ROW = 48;
const GAP = 16;
/** Widgets drawn without a card (they sit on the background). */
const BARE = new Set<WidgetType>(["greeting", "search", "shortcuts"]);

const WIDGET_NAMES: Record<Exclude<WidgetType, "custom">, () => string> = {
  greeting: () => t("Greeting"),
  search: () => t("Search box"),
  shortcuts: () => t("Shortcuts"),
  clock: () => t("Clock"),
  notes: () => t("Notes"),
};

type Panel = null | "add" | "background" | { widget: string };
type Gesture = { id: string; mode: "move" | "resize"; startX: number; startY: number; origin: WidgetInstance; base: NewTabLayout };

function useWallpaper(background: Background): WallpaperView | null {
  const [wp, setWp] = useState<WallpaperView | null>(null);
  const source = background.kind === "wallpaper" ? background.source : null;
  useEffect(() => {
    setWp(null);
    if (!source) return;
    let alive = true;
    void internalApi()
      .call("newtab.wallpaper", source)
      .then((v) => alive && setWp(v))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [source]);
  return wp;
}

function BackgroundLayer({ background }: { background: Background }) {
  const wp = useWallpaper(background);
  const picture = background.kind === "image" ? `corvus://newtab/media/${background.file}` : background.kind === "wallpaper" ? wp?.url : undefined;
  if (background.kind === "default") return null;
  return (
    <div className="nt-bg" aria-hidden={!wp}>
      {background.kind === "color" ? (
        <div className="nt-bg-fill" style={{ background: background.color }} />
      ) : (
        picture && (
          <>
            <div className="nt-bg-fill" style={{ backgroundImage: `url("${picture}")`, filter: background.blur ? `blur(${background.blur}px)` : undefined, inset: background.blur ? -background.blur * 2 : 0 }} />
            <div className="nt-bg-dim" style={{ opacity: background.dim }} />
          </>
        )
      )}
      {wp && (
        <a className="nt-credit" href={wp.link}>
          {wp.credit}
        </a>
      )}
    </div>
  );
}

/** Light or dark text for what sits on the background (pictures are dimmed, colors are measured). */
function surfaceTone(background: Background): "light" | "dark" | null {
  if (background.kind === "image" || background.kind === "wallpaper") return "dark";
  if (background.kind !== "color") return null;
  const n = parseInt(background.color.slice(1), 16);
  const luminance = (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
  return luminance > 0.6 ? "light" : "dark";
}

function WidgetBody(props: WidgetProps<WidgetType> & { onConsent: (hosts: string[]) => void; tone: "light" | "dark" | null }) {
  switch (props.widget.type) {
    case "greeting":
      return <GreetingWidget {...(props as unknown as WidgetProps<"greeting">)} />;
    case "search":
      return <SearchWidget />;
    case "shortcuts":
      return <ShortcutsWidget {...(props as unknown as WidgetProps<"shortcuts">)} />;
    case "clock":
      return <ClockWidget {...(props as unknown as WidgetProps<"clock">)} />;
    case "notes":
      return <NotesWidget {...(props as unknown as WidgetProps<"notes">)} />;
    case "custom":
      return <CustomWidget {...(props as unknown as WidgetProps<"custom">)} onConsent={props.onConsent} tone={props.tone} />;
  }
}

function NewTab() {
  const api = internalApi();
  const [view, setView] = useState<NewTabView | null>(null);
  const [editing, setEditing] = useState(false);
  const [panel, setPanel] = useState<Panel>(null);
  const [gesture, setGesture] = useState<Gesture | null>(null);
  const [error, setError] = useState<string | null>(null);
  const grid = useRef<HTMLDivElement>(null);

  const load = useCallback(() => void api.call("newtab.view").then(setView), [api]);
  useEffect(() => {
    load();
    return api.onEvent((e) => {
      if (e.type === "newtab-changed") load();
    });
  }, [api, load]);

  const save = (layout: NewTabLayout): void => {
    setError(null);
    setView((v) => (v ? { ...v, layout } : v));
    api
      .call("newtab.save", layout)
      .then(setView)
      .catch((e: unknown) => setError(errorMessage(e)));
  };
  const run = (p: Promise<NewTabView>): void => {
    setError(null);
    p.then(setView).catch((e: unknown) => setError(errorMessage(e)));
  };

  if (!view) return <div className="newtab" />;
  const layout = view.layout;
  const rows = Math.max(8, ...layout.widgets.map((w) => w.y + w.h)) + (editing ? 3 : 0);

  // -------------------------------------------------------------------- drag and resize
  const pitch = (): { x: number; y: number } => {
    const width = grid.current?.getBoundingClientRect().width ?? 1200;
    return { x: (width - GAP * (GRID_COLUMNS - 1)) / GRID_COLUMNS + GAP, y: ROW + GAP };
  };
  const begin = (widget: WidgetInstance, mode: Gesture["mode"]) => (e: ReactPointerEvent): void => {
    if (!editing || e.button !== 0) return;
    e.preventDefault();
    (e.target as Element).setPointerCapture?.(e.pointerId);
    setGesture({ id: widget.id, mode, startX: e.clientX, startY: e.clientY, origin: widget, base: layout });
  };
  const move = (e: ReactPointerEvent): void => {
    if (!gesture) return;
    const p = pitch();
    const dx = Math.round((e.clientX - gesture.startX) / p.x);
    const dy = Math.round((e.clientY - gesture.startY) / p.y);
    const o = gesture.origin;
    const box = gesture.mode === "move" ? { x: o.x + dx, y: o.y + dy } : { w: o.w + dx, h: o.h + dy };
    const next = placeWidget(gesture.base, gesture.id, box);
    setView((v) => (v ? { ...v, layout: next } : v));
  };
  const end = (): void => {
    if (!gesture) return;
    setGesture(null);
    if (view.layout !== gesture.base) save(view.layout);
  };

  // -------------------------------------------------------------------- widget changes
  const updateConfig = (id: string) => (config: WidgetInstance["config"]) => save(withConfig(layout, id, config));
  const consent = (id: string) => (hosts: string[]) => run(api.call("newtab.consent", id, hosts));
  const add = (type: Exclude<WidgetType, "custom">): void => {
    save(addWidget(layout, type));
    setPanel(null);
  };
  const addTemplate = (tpl: WidgetTemplate): void => {
    save(addWidget(layout, "custom", { ...tpl.config, author: tpl.title, consent: [] }, { w: tpl.w, h: tpl.h }));
    setPanel(null);
  };
  const addBlank = (): void => {
    const next = addWidget(layout, "custom", {
      ...defaultConfig("custom"),
      title: t("My widget"),
      html: `<div class="cw-title">${t("Hello")}</div><div class="cw-sub">${t("Edit this widget to show anything.")}</div>`,
      author: t("you"),
    });
    save(next);
    setPanel({ widget: next.widgets[next.widgets.length - 1]!.id });
  };
  const remove = (id: string): void => {
    save({ ...layout, widgets: layout.widgets.filter((w) => w.id !== id) });
    setPanel(null);
  };

  const tone = surfaceTone(layout.background);
  const selected = panel && typeof panel === "object" ? layout.widgets.find((w) => w.id === panel.widget) : undefined;

  return (
    <div className={`newtab ${editing ? "editing" : ""} ${tone ? `on-${tone}` : ""} ${layout.background.kind !== "default" ? "has-bg" : ""}`} onPointerMove={move} onPointerUp={end}>
      <BackgroundLayer background={layout.background} />
      {view.privateWindow && (
        <div className="nt-private" data-newtab-private>
          <strong>{t("Private window")}</strong>
          <span>{t("Corvus keeps no history of this window, and its cookies and site data go when the last private window closes. Downloads and bookmarks you make stay. Extensions and AI agents do not see it.")}</span>
        </div>
      )}
      <div ref={grid} className="nt-grid" style={{ gridTemplateRows: `repeat(${rows}, ${ROW}px)` }}>
        {layout.widgets.map((w) => (
          <section
            key={w.id}
            className={`nt-widget nt-w-${w.type} ${BARE.has(w.type) ? "bare" : "nt-card"} ${gesture?.id === w.id ? "moving" : ""}`}
            data-widget={w.id}
            style={{ gridColumn: `${w.x + 1} / span ${w.w}`, gridRow: `${w.y + 1} / span ${w.h}` }}
          >
            <WidgetBody widget={w} editing={editing} profileName={view.profileName} topSites={view.topSites} update={updateConfig(w.id)} onConsent={consent(w.id)} tone={tone} />
            {editing && (
              <>
                <div className="nt-handle" title={t("Drag to move")} onPointerDown={begin(w, "move")} />
                <div className="nt-widget-tools">
                  <span className="nt-widget-name">{w.type === "custom" ? (w.config as WidgetConfigs["custom"]).title || t("Custom widget") : WIDGET_NAMES[w.type]()}</span>
                  <button type="button" title={t("Widget settings")} onClick={() => setPanel({ widget: w.id })}>
                    <IconSettings size={14} />
                  </button>
                </div>
                <div className="nt-resize" title={t("Drag to resize")} onPointerDown={begin(w, "resize")} />
              </>
            )}
          </section>
        ))}
      </div>

      {error && <div className="notice error nt-error">{error}</div>}

      <div className="nt-dock">
        {editing ? (
          <>
            <button type="button" className="btn small" onClick={() => setPanel("add")}>
              {t("Add widget")}
            </button>
            <button type="button" className="btn small" onClick={() => setPanel("background")}>
              {t("Background")}
            </button>
            <button type="button" className="btn small" disabled={!view.canUndo} onClick={() => run(api.call("newtab.undo"))}>
              {t("Undo")}
            </button>
            <button type="button" className="btn small ghost" onClick={() => confirm(t("Go back to the original New Tab page?")) && run(api.call("newtab.reset"))}>
              {t("Reset")}
            </button>
            <button
              type="button"
              className="btn small primary"
              onClick={() => {
                setEditing(false);
                setPanel(null);
              }}
            >
              {t("Done")}
            </button>
          </>
        ) : (
          <>
            {view.mcpRunning && (
              <a className="nt-agent" href="corvus://settings/#agents" title={t("AI agents can connect to this browser via MCP")}>
                <IconAgent size={14} />
              </a>
            )}
            <button type="button" className="btn small nt-customize" onClick={() => setEditing(true)}>
              <IconEdit size={13} /> {t("Customize")}
            </button>
          </>
        )}
      </div>

      {panel === "add" && <AddWidgetPanel onAdd={add} onTemplate={addTemplate} onBlank={addBlank} onClose={() => setPanel(null)} mcpRunning={view.mcpRunning} />}
      {panel === "background" && <BackgroundPanel background={layout.background} onChange={(background) => save({ ...layout, background })} onClose={() => setPanel(null)} />}
      {selected && (
        <WidgetSettingsPanel widget={selected} onChange={updateConfig(selected.id)} onConsent={consent(selected.id)} onRemove={() => remove(selected.id)} onClose={() => setPanel(null)} />
      )}
    </div>
  );
}

mount(<NewTab />);
