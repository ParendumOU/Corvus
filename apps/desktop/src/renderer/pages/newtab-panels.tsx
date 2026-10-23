import { useEffect, useState } from "react";
import {
  BACKGROUND_SWATCHES,
  SOURCE_KINDS,
  WALLPAPER_SOURCES,
  type Background,
  type CustomSource,
  type NewTabLayout,
  type SourceKind,
  type WallpaperSource,
  type WidgetConfigs,
  type WidgetInstance,
  type WidgetType,
} from "../../shared/newtab";
import { errorMessage, internalApi } from "../common/api";
import { t } from "../common/i18n";
import { IconClose, IconPlus, IconTrash } from "../common/icons";
import { Toggle } from "../common/ui";
import { widgetTemplates, type WidgetTemplate } from "./newtab-templates";

function Panel({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <aside className="nt-panel" role="dialog" aria-label={title}>
      <header>
        <h2>{title}</h2>
        <button type="button" className="icon-btn" title={t("Close")} onClick={onClose}>
          <IconClose size={16} />
        </button>
      </header>
      <div className="nt-panel-body">{children}</div>
    </aside>
  );
}

// ------------------------------------------------------------------------------- add widget

const BUILT_INS: Array<{ type: Exclude<WidgetType, "custom">; title: () => string; description: () => string }> = [
  { type: "greeting", title: () => t("Greeting"), description: () => t("Good morning, with your name.") },
  { type: "search", title: () => t("Search box"), description: () => t("Ask Corvus or type an address.") },
  { type: "shortcuts", title: () => t("Shortcuts"), description: () => t("Sites you pin, plus your most visited ones.") },
  { type: "clock", title: () => t("Clock"), description: () => t("Digital or analog, with other time zones.") },
  { type: "notes", title: () => t("Notes"), description: () => t("A sticky note that saves as you type.") },
];

export function AddWidgetPanel({
  onAdd,
  onTemplate,
  onBlank,
  onClose,
  mcpRunning,
}: {
  onAdd: (type: Exclude<WidgetType, "custom">) => void;
  onTemplate: (template: WidgetTemplate) => void;
  onBlank: () => void;
  onClose: () => void;
  mcpRunning: boolean;
}) {
  return (
    <Panel title={t("Add a widget")} onClose={onClose}>
      <h3>{t("Basics")}</h3>
      <div className="nt-gallery">
        {BUILT_INS.map((b) => (
          <button key={b.type} type="button" className="nt-gallery-item" onClick={() => onAdd(b.type)}>
            <strong>{b.title()}</strong>
            <span>{b.description()}</span>
          </button>
        ))}
      </div>
      <h3>{t("Custom widgets")}</h3>
      <p className="muted small">
        {t("A custom widget shows anything: it reads the data sources you give it (any public address, a feed, a site you are signed in to, or Corvus's own data) and draws them with HTML, CSS and JavaScript. Start from one of these, or from scratch.")}
      </p>
      <div className="nt-gallery">
        {widgetTemplates().map((tpl) => (
          <button key={tpl.id} type="button" className="nt-gallery-item" onClick={() => onTemplate(tpl)}>
            <strong>{tpl.title}</strong>
            <span>{tpl.description}</span>
          </button>
        ))}
        <button type="button" className="nt-gallery-item blank" onClick={onBlank}>
          <strong>
            <IconPlus size={14} /> {t("Blank custom widget")}
          </strong>
          <span>{t("Write its sources and code yourself.")}</span>
        </button>
      </div>
      <p className="nt-panel-hint">
        {mcpRunning
          ? t("AI agents connected over MCP can build widgets for you: ask for the widget you want, in your own words.")
          : t("Turn on the MCP server in Settings > AI agents and an AI agent can build any widget you describe.")}
      </p>
    </Panel>
  );
}

// ------------------------------------------------------------------------------- background

const WALLPAPER_LABEL: Record<WallpaperSource, string> = { bing: "Bing", wikimedia: "Wikimedia Commons", nasa: "NASA APOD", picsum: "Lorem Picsum" };

export function BackgroundPanel({ background, onChange, onClose }: { background: Background; onChange: (b: Background) => void; onClose: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const dim = background.kind === "image" || background.kind === "wallpaper" ? background.dim : 0.25;
  const blur = background.kind === "image" || background.kind === "wallpaper" ? background.blur : 0;
  const picture = background.kind === "image" || background.kind === "wallpaper";
  const upload = (): void => {
    setError(null);
    void internalApi()
      .call("newtab.pickImage")
      .then((file) => file && onChange({ kind: "image", file, dim, blur }))
      .catch((e: unknown) => setError(errorMessage(e)));
  };
  return (
    <Panel title={t("Background")} onClose={onClose}>
      <h3>{t("Color")}</h3>
      <div className="nt-swatches">
        <button type="button" className={`nt-swatch default ${background.kind === "default" ? "on" : ""}`} title={t("Default")} onClick={() => onChange({ kind: "default" })}>
          {t("Default")}
        </button>
        {BACKGROUND_SWATCHES.map((color) => (
          <button
            key={color}
            type="button"
            className={`nt-swatch ${background.kind === "color" && background.color === color ? "on" : ""}`}
            style={{ background: color }}
            title={color}
            onClick={() => onChange({ kind: "color", color })}
          />
        ))}
        <label className="nt-swatch custom" title={t("Another color")}>
          <input type="color" value={background.kind === "color" ? background.color : "#202124"} onChange={(e) => onChange({ kind: "color", color: e.target.value })} />
        </label>
      </div>
      <h3>{t("Picture")}</h3>
      <div className="nt-wallpapers">
        <button type="button" className={`nt-gallery-item ${background.kind === "image" ? "on" : ""}`} onClick={upload}>
          <strong>{t("Your picture…")}</strong>
          <span>{t("A file from this computer; it stays on this device.")}</span>
        </button>
        {WALLPAPER_SOURCES.map((source) => (
          <button
            key={source}
            type="button"
            className={`nt-gallery-item ${background.kind === "wallpaper" && background.source === source ? "on" : ""}`}
            onClick={() => onChange({ kind: "wallpaper", source, dim, blur })}
          >
            <strong>{WALLPAPER_LABEL[source]}</strong>
            <span>{t("A new picture every day.")}</span>
          </button>
        ))}
      </div>
      {error && <div className="notice error">{error}</div>}
      {picture && (
        <>
          <label className="nt-slider">
            <span>{t("Darken")}</span>
            <input type="range" min={0} max={0.8} step={0.05} value={dim} onChange={(e) => onChange({ ...background, dim: Number(e.target.value) } as Background)} />
          </label>
          <label className="nt-slider">
            <span>{t("Blur")}</span>
            <input type="range" min={0} max={24} step={1} value={blur} onChange={(e) => onChange({ ...background, blur: Number(e.target.value) } as Background)} />
          </label>
        </>
      )}
    </Panel>
  );
}

// ------------------------------------------------------------------------------- widget settings

function TextField({ label, value, onSave, placeholder, multiline, mono }: { label: string; value: string; onSave: (v: string) => void; placeholder?: string; multiline?: boolean; mono?: boolean }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = (): void => {
    if (draft !== value) onSave(draft);
  };
  return (
    <label className="nt-field">
      <span>{label}</span>
      {multiline ? (
        <textarea className={`input ${mono ? "mono" : ""}`} rows={6} value={draft} placeholder={placeholder} spellCheck={false} onChange={(e) => setDraft(e.target.value)} onBlur={commit} />
      ) : (
        <input className="input" value={draft} placeholder={placeholder} spellCheck={false} onChange={(e) => setDraft(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === "Enter" && commit()} />
      )}
    </label>
  );
}

const KIND_LABEL: Record<SourceKind, () => string> = {
  fetch: () => t("Address (JSON or text)"),
  feed: () => t("RSS or Atom feed"),
  page: () => t("Site with my session"),
  corvus: () => t("Corvus data"),
};

function SourcesEditor({ sources, onChange }: { sources: CustomSource[]; onChange: (s: CustomSource[]) => void }) {
  const set = (i: number, patch: Partial<CustomSource>): void => onChange(sources.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  return (
    <div className="nt-sources">
      {sources.map((s, i) => (
        <div key={i} className="nt-source">
          <input className="input mono" value={s.name} title={t("Name the code reads it by")} onChange={(e) => set(i, { name: e.target.value })} />
          <select className="input" value={s.kind} onChange={(e) => set(i, { kind: e.target.value as SourceKind, url: e.target.value === "corvus" ? "watches" : s.url })}>
            {SOURCE_KINDS.map((k) => (
              <option key={k} value={k}>
                {KIND_LABEL[k]()}
              </option>
            ))}
          </select>
          {s.kind === "corvus" ? (
            <select className="input" value={s.url} onChange={(e) => set(i, { url: e.target.value })}>
              <option value="watches">{t("Watched pages")}</option>
              <option value="top-sites">{t("Most visited sites")}</option>
            </select>
          ) : (
            <input className="input" value={s.url} placeholder="https://" onChange={(e) => set(i, { url: e.target.value })} />
          )}
          {s.kind === "page" && <input className="input mono" value={s.select} placeholder={t("CSS selector (optional)")} onChange={(e) => set(i, { select: e.target.value })} />}
          <input className="input" type="number" min={1} value={s.everyMinutes} title={t("Refresh every N minutes")} onChange={(e) => set(i, { everyMinutes: Number(e.target.value) || 15 })} />
          <button type="button" className="icon-btn" title={t("Remove source")} onClick={() => onChange(sources.filter((_, j) => j !== i))}>
            <IconTrash size={14} />
          </button>
        </div>
      ))}
      {sources.length < 8 && (
        <button type="button" className="btn small" onClick={() => onChange([...sources, { name: `source${sources.length + 1}`, kind: "fetch", url: "", select: "", everyMinutes: 15 }])}>
          <IconPlus size={13} /> {t("Add source")}
        </button>
      )}
    </div>
  );
}

export function WidgetSettingsPanel({
  widget,
  onChange,
  onConsent,
  onRemove,
  onClose,
}: {
  widget: WidgetInstance;
  onChange: (config: WidgetInstance["config"]) => void;
  onConsent: (hosts: string[]) => void;
  onRemove: () => void;
  onClose: () => void;
}) {
  const body = (() => {
    switch (widget.type) {
      case "greeting": {
        const c = widget.config as WidgetConfigs["greeting"];
        return <TextField label={t("Name")} value={c.name} placeholder={t("Your profile name")} onSave={(name) => onChange({ ...c, name })} />;
      }
      case "shortcuts": {
        const c = widget.config as WidgetConfigs["shortcuts"];
        return (
          <>
            <div className="nt-field row">
              <span>{t("Show most visited sites")}</span>
              <Toggle label={t("Show most visited sites")} checked={c.topSites} onChange={(topSites) => onChange({ ...c, topSites })} />
            </div>
            {c.hidden.length > 0 && (
              <button type="button" className="btn small" onClick={() => onChange({ ...c, hidden: [] })}>
                {t("Show {n} hidden sites again", { n: c.hidden.length })}
              </button>
            )}
            <p className="muted small">{t("Drag tiles to reorder them; use the pencil and the cross on a tile to edit or remove it.")}</p>
          </>
        );
      }
      case "clock": {
        const c = widget.config as WidgetConfigs["clock"];
        return (
          <>
            <div className="nt-field row">
              <span>{t("Style")}</span>
              <div className="segmented">
                {(["digital", "analog"] as const).map((style) => (
                  <button key={style} type="button" className={c.style === style ? "on" : ""} onClick={() => onChange({ ...c, style })}>
                    {style === "digital" ? t("Digital") : t("Analog")}
                  </button>
                ))}
              </div>
            </div>
            <div className="nt-field row">
              <span>{t("12-hour clock")}</span>
              <Toggle label={t("12-hour clock")} checked={c.hour12} onChange={(hour12) => onChange({ ...c, hour12 })} />
            </div>
            <div className="nt-field row">
              <span>{t("Show seconds")}</span>
              <Toggle label={t("Show seconds")} checked={c.seconds} onChange={(seconds) => onChange({ ...c, seconds })} />
            </div>
            <TextField
              label={t("Other time zones")}
              value={c.zones.join(", ")}
              placeholder="America/New_York, Asia/Tokyo"
              onSave={(v) => onChange({ ...c, zones: v.split(",").map((z) => z.trim()).filter(Boolean) })}
            />
          </>
        );
      }
      case "custom": {
        const c = widget.config as WidgetConfigs["custom"];
        return (
          <>
            <TextField label={t("Title")} value={c.title} onSave={(title) => onChange({ ...c, title })} />
            <h3>{t("Data sources")}</h3>
            <SourcesEditor sources={c.sources} onChange={(sources) => onChange({ ...c, sources })} />
            {c.consent.length > 0 && (
              <div className="nt-field">
                <span>{t("Allowed to read with your session")}</span>
                <div className="inline">
                  {c.consent.map((h) => (
                    <span key={h} className="pill">
                      {h}
                      <button type="button" className="btn small ghost" title={t("Revoke")} onClick={() => onConsent(c.consent.filter((x) => x !== h))}>
                        ×
                      </button>
                    </span>
                  ))}
                </div>
              </div>
            )}
            <TextField label={t("Other hosts its links may open")} value={c.links.join(", ")} placeholder="example.com" onSave={(v) => onChange({ ...c, links: v.split(",").map((h) => h.trim()).filter(Boolean) })} />
            <h3>{t("Code")}</h3>
            <TextField label="HTML" value={c.html} multiline mono onSave={(html) => onChange({ ...c, html })} />
            <TextField label="CSS" value={c.css} multiline mono onSave={(css) => onChange({ ...c, css })} />
            <TextField label="JavaScript" value={c.script} multiline mono onSave={(script) => onChange({ ...c, script })} />
            <p className="muted small">{t("The code reads its data with corvus.onData((data) => …) and opens links with corvus.open(url). It runs isolated: no network, cookies or storage.")}</p>
            {c.author && <p className="muted small">{t("Made by {author}.", { author: c.author })}</p>}
          </>
        );
      }
      default:
        return <p className="muted small">{t("This widget has no settings.")}</p>;
    }
  })();
  return (
    <Panel title={t("Widget settings")} onClose={onClose}>
      {body}
      <button type="button" className="btn small ghost danger nt-remove" onClick={onRemove}>
        <IconTrash size={13} /> {t("Remove widget")}
      </button>
    </Panel>
  );
}

/** The layout with one widget's config replaced. */
export function withConfig(layout: NewTabLayout, id: string, config: WidgetInstance["config"]): NewTabLayout {
  return { ...layout, widgets: layout.widgets.map((w) => (w.id === id ? { ...w, config } : w)) };
}
