import { useEffect, useMemo, useRef, useState, type DragEvent, type FormEvent } from "react";
import { pendingConsent, webUrl, type Shortcut, type WidgetConfigs, type WidgetInstance } from "../../shared/newtab";
import type { NewTabSite } from "../../shared/newtab-ipc";
import { classifyOmnibox, intentToUrl } from "../../shared/omnibox";
import { internalApi } from "../common/api";
import { t } from "../common/i18n";
import { CorvusMark, IconClose, IconEdit, IconPlus, IconSearch, IconSparkle } from "../common/icons";
import { Favicon, hostOf } from "../common/ui";

export interface WidgetProps<T extends WidgetInstance["type"]> {
  widget: WidgetInstance<T>;
  editing: boolean;
  profileName: string;
  topSites: NewTabSite[];
  update: (config: WidgetConfigs[T]) => void;
}

// ------------------------------------------------------------------------------- greeting

function greeting(): string {
  const h = new Date().getHours();
  if (h < 5) return t("Good night");
  if (h < 12) return t("Good morning");
  if (h < 20) return t("Good afternoon");
  return t("Good evening");
}

export function GreetingWidget({ widget, profileName }: WidgetProps<"greeting">) {
  const name = widget.config.name || profileName;
  return (
    <div className="nt-hero">
      <CorvusMark size={56} />
      <h1>
        {greeting()}
        {name ? <span className="muted">, {name}</span> : null}
      </h1>
    </div>
  );
}

// ------------------------------------------------------------------------------- search

export function SearchWidget() {
  const [query, setQuery] = useState("");
  const submit = (e: FormEvent): void => {
    e.preventDefault();
    if (query.trim()) location.href = intentToUrl(classifyOmnibox(query));
  };
  return (
    <div className="nt-search-wrap">
      <form className="nt-search" onSubmit={submit}>
        <IconSearch size={20} />
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("Ask anything or type a URL")} spellCheck={false} />
        <button type="submit" className="nt-ask" disabled={!query.trim()}>
          <IconSparkle size={16} />
          {t("Ask")}
        </button>
      </form>
    </div>
  );
}

// ------------------------------------------------------------------------------- shortcuts

const newShortcutId = (): string => `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export function ShortcutsWidget({ widget, editing, topSites, update }: WidgetProps<"shortcuts">) {
  const c = widget.config;
  const [form, setForm] = useState<{ id: string | null; title: string; url: string } | null>(null);
  const dragged = useRef<string | null>(null);

  const pinnedUrls = new Set(c.pinned.map((p) => p.url));
  const hidden = new Set(c.hidden);
  const tops: Shortcut[] = c.topSites
    ? topSites.filter((s) => !pinnedUrls.has(s.url) && !hidden.has(s.url)).map((s) => ({ id: `top:${s.url}`, title: s.title || hostOf(s.url), url: s.url }))
    : [];
  const tiles = [...c.pinned, ...tops].slice(0, 24);
  const favicons = new Map(topSites.map((s) => [s.url, s.faviconUrl]));

  const remove = (s: Shortcut): void => {
    if (s.id.startsWith("top:")) update({ ...c, hidden: [...c.hidden, s.url] });
    else update({ ...c, pinned: c.pinned.filter((p) => p.id !== s.id) });
  };
  const save = (e: FormEvent): void => {
    e.preventDefault();
    if (!form) return;
    const url = webUrl(intentToUrl(classifyOmnibox(form.url)));
    if (!url) return;
    const entry = { id: form.id && !form.id.startsWith("top:") ? form.id : newShortcutId(), title: form.title.trim() || hostOf(url), url };
    const pinned = form.id && !form.id.startsWith("top:") ? c.pinned.map((p) => (p.id === form.id ? entry : p)) : [...c.pinned, entry];
    update({ ...c, pinned });
    setForm(null);
  };
  /** Dropping a tile pins it at the drop position, so the order sticks. */
  const drop = (target: Shortcut) => (e: DragEvent): void => {
    e.preventDefault();
    const from = dragged.current;
    dragged.current = null;
    if (!from || from === target.id) return;
    const all = tiles.map((s) => (s.id.startsWith("top:") ? { ...s, id: newShortcutId() } : s));
    const fromIndex = tiles.findIndex((s) => s.id === from);
    const toIndex = tiles.findIndex((s) => s.id === target.id);
    const [moved] = all.splice(fromIndex, 1);
    all.splice(toIndex, 0, moved!);
    const upTo = Math.max(fromIndex, toIndex);
    update({ ...c, pinned: all.slice(0, Math.max(upTo + 1, c.pinned.length)) });
  };

  return (
    <div className="nt-sites">
      {tiles.map((s) => (
        <a
          key={s.id}
          className="nt-site"
          href={s.url}
          title={s.title || s.url}
          draggable
          onDragStart={() => (dragged.current = s.id)}
          onDragOver={(e) => e.preventDefault()}
          onDrop={drop(s)}
        >
          <span className="nt-site-icon">
            <Favicon url={s.url} src={favicons.get(s.url)} size={24} />
          </span>
          <span className="nt-site-name">{s.title || hostOf(s.url)}</span>
          <span className="nt-site-tools">
            <button
              type="button"
              title={t("Edit shortcut")}
              onClick={(e) => {
                e.preventDefault();
                setForm({ id: s.id, title: s.title, url: s.url });
              }}
            >
              <IconEdit size={12} />
            </button>
            <button
              type="button"
              title={s.id.startsWith("top:") ? t("Hide this site") : t("Remove shortcut")}
              onClick={(e) => {
                e.preventDefault();
                remove(s);
              }}
            >
              <IconClose size={12} />
            </button>
          </span>
        </a>
      ))}
      {(editing || tiles.length < 24) && (
        <button type="button" className="nt-site nt-site-add" title={t("Add shortcut")} onClick={() => setForm({ id: null, title: "", url: "" })}>
          <span className="nt-site-icon">
            <IconPlus size={20} />
          </span>
          <span className="nt-site-name">{t("Add shortcut")}</span>
        </button>
      )}
      {form && (
        <form className="nt-shortcut-form" onSubmit={save}>
          <input autoFocus placeholder={t("Name")} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
          <input placeholder={t("Address")} value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} />
          <button type="submit" className="btn small primary" disabled={!form.url.trim()}>
            {t("Save")}
          </button>
          <button type="button" className="btn small ghost" onClick={() => setForm(null)}>
            {t("Cancel")}
          </button>
        </form>
      )}
    </div>
  );
}

// ------------------------------------------------------------------------------- clock

function useNow(seconds: boolean): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), seconds ? 1000 : 15_000);
    return () => clearInterval(timer);
  }, [seconds]);
  return now;
}

function AnalogClock({ now }: { now: Date }) {
  const s = now.getSeconds();
  const m = now.getMinutes() + s / 60;
  const h = (now.getHours() % 12) + m / 60;
  const hand = (turn: number, length: number, width: number, cls: string) => {
    const a = (turn * 2 - 0.5) * Math.PI;
    return <line className={cls} x1="50" y1="50" x2={50 + Math.cos(a) * length} y2={50 + Math.sin(a) * length} strokeWidth={width} strokeLinecap="round" />;
  };
  return (
    <svg className="nt-analog" viewBox="0 0 100 100" aria-hidden="true">
      <circle cx="50" cy="50" r="46" className="face" />
      {Array.from({ length: 12 }, (_, i) => {
        const a = (i / 12) * 2 * Math.PI;
        return <line key={i} className="tick" x1={50 + Math.cos(a) * 38} y1={50 + Math.sin(a) * 38} x2={50 + Math.cos(a) * 42} y2={50 + Math.sin(a) * 42} />;
      })}
      {hand(h / 12, 22, 4, "hour")}
      {hand(m / 60, 32, 3, "minute")}
      {hand(s / 60, 36, 1.2, "second")}
      <circle cx="50" cy="50" r="2.6" className="pin" />
    </svg>
  );
}

export function ClockWidget({ widget }: WidgetProps<"clock">) {
  const c = widget.config;
  const now = useNow(c.seconds || c.style === "analog");
  const time = (zone?: string) =>
    now.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", ...(c.seconds ? { second: "2-digit" } : {}), hour12: c.hour12, ...(zone ? { timeZone: zone } : {}) });
  return (
    <div className={`nt-clock ${c.style}`}>
      {c.style === "analog" ? <AnalogClock now={now} /> : <div className="nt-clock-time">{time()}</div>}
      <div className="nt-clock-date">{now.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" })}</div>
      {c.zones.length > 0 && (
        <ul className="nt-clock-zones">
          {c.zones.map((z) => (
            <li key={z}>
              <span>{z.split("/").pop()?.replace(/_/g, " ")}</span>
              <span>{time(z)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ------------------------------------------------------------------------------- notes

export function NotesWidget({ widget, update }: WidgetProps<"notes">) {
  const [draft, setDraft] = useState(widget.config.text);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => setDraft(widget.config.text), [widget.config.text]);
  return (
    <textarea
      className="nt-notes"
      value={draft}
      placeholder={t("Notes, to-dos, anything…")}
      spellCheck
      onChange={(e) => {
        const text = e.target.value;
        setDraft(text);
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => update({ text }), 600);
      }}
    />
  );
}

// ------------------------------------------------------------------------------- custom

/** The widget's frame address changes with its code, so an edit reloads it. */
function codeVersion(c: WidgetConfigs["custom"]): string {
  let h = 0;
  const s = c.html + c.css + c.script + JSON.stringify(c.sources);
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

export function CustomWidget({ widget, editing, onConsent, tone }: WidgetProps<"custom"> & { onConsent: (hosts: string[]) => void; tone: "light" | "dark" | null }) {
  const c = widget.config;
  const frame = useRef<HTMLIFrameElement>(null);
  const version = useMemo(() => codeVersion(c), [c]);
  const waiting = pendingConsent(c);
  const refreshMs = Math.max(60_000, Math.min(...c.sources.map((s) => s.everyMinutes * 60_000), 3_600_000));

  useEffect(() => {
    const api = internalApi();
    let alive = true;
    const push = (): void => {
      void api.call("newtab.customData", widget.id).then((data) => {
        if (alive) frame.current?.contentWindow?.postMessage({ type: "corvus:data", data }, "*");
      });
    };
    const onMessage = (e: MessageEvent): void => {
      if (!frame.current || e.source !== frame.current.contentWindow) return;
      const msg = e.data as { type?: string; url?: unknown };
      if (msg?.type === "corvus:ready" || msg?.type === "corvus:refresh") push();
      else if (msg?.type === "corvus:open" && typeof msg.url === "string") void api.call("newtab.openFromWidget", widget.id, msg.url);
    };
    window.addEventListener("message", onMessage);
    const timer = setInterval(push, refreshMs);
    return () => {
      alive = false;
      window.removeEventListener("message", onMessage);
      clearInterval(timer);
    };
  }, [widget.id, version, refreshMs, c.consent.join(",")]);

  return (
    <div className="nt-custom">
      <iframe
        ref={frame}
        className="nt-custom-frame"
        title={c.title || t("Custom widget")}
        sandbox="allow-scripts"
        src={`corvus://newtab/widget/${encodeURIComponent(widget.id)}?v=${version}&c=${c.consent.length}${tone ? `&tone=${tone}` : ""}`}
        style={editing ? { pointerEvents: "none" } : undefined}
      />
      {waiting.length > 0 && (
        <div className="nt-consent" role="dialog" aria-label={t("Allow reading with your session")}>
          <p>{t("This widget wants to read {hosts} with your signed-in session.", { hosts: waiting.join(", ") })}</p>
          <div className="inline">
            <button type="button" className="btn small primary" onClick={() => onConsent([...c.consent, ...waiting])}>
              {t("Allow")}
            </button>
          </div>
        </div>
      )}
      {editing && c.author && <span className="nt-author">{t("by {author}", { author: c.author })}</span>}
    </div>
  );
}
