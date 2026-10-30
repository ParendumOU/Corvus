import { useState } from "react";
import { cachedFaviconUrl, faviconSrcToShow } from "../../shared/favicon";
import { liveSourceName } from "../../shared/live-history";
import { t } from "./i18n";
import { CorvusMark, IconGlobe } from "./icons";

const LETTER_COLORS = ["#5b5bd6", "#1a73e8", "#188038", "#d93025", "#e37400", "#9334e6", "#007b83", "#d01884"];

function hash(text: string): number {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) | 0;
  return Math.abs(h);
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** The letter and colour of a site's letter tile (also drawn into native menus). */
export function letterTile(text: string): { letter: string; color: string } {
  return { letter: (text.replace(/^www\./, "")[0] ?? "?").toUpperCase(), color: LETTER_COLORS[hash(text) % LETTER_COLORS.length]! };
}

/** Letter tile for a site; no network request involved. */
export function LetterIcon({ text, size = 16 }: { text: string; size?: number }) {
  const { letter, color } = letterTile(text);
  return (
    <span className="letter-icon" style={{ width: size, height: size, fontSize: size * 0.6, background: color }} aria-hidden="true">
      {letter}
    </span>
  );
}

const SOURCE_TILES: Record<string, { letter: string; color: string }> = {
  chrome: { letter: "C", color: "#1a73e8" },
  edge: { letter: "E", color: "#0a7bd1" },
  brave: { letter: "B", color: "#e2401c" },
  vivaldi: { letter: "V", color: "#d63a3a" },
  opera: { letter: "O", color: "#d6132a" },
  "opera-gx": { letter: "O", color: "#c2185b" },
  chromium: { letter: "C", color: "#3c6fd6" },
  firefox: { letter: "F", color: "#d35400" },
};

/** The browser a history page came from (live history from other browsers): a small round tile with its initial. */
export function SourceBadge({ source, size = 14 }: { source: string; size?: number }) {
  const tile = SOURCE_TILES[source] ?? { letter: source.slice(0, 1).toUpperCase(), color: "#5f6368" };
  const label = t("From {browser}", { browser: liveSourceName(source) });
  return (
    <span className="source-badge" role="img" title={label} aria-label={label} data-source={source} style={{ width: size, height: size, fontSize: Math.round(size * 0.62), background: tile.color }}>
      {tile.letter}
    </span>
  );
}

/** The profile the browser UI shows icons of (pages in tabs get their own profile's). */
let faviconProfile = "";
/** Its icon cache's revision: when it goes up, a bookmark may show another icon (cachedFaviconUrl). */
let faviconRevision = 0;
export function setFaviconProfile(id: string, revision = 0): void {
  faviconProfile = id;
  faviconRevision = revision;
}

/** The key the main process wrote on this page's <html> for its corvus://favicon/ requests. */
const faviconKey = typeof document !== "undefined" ? (document.documentElement.dataset.faviconKey ?? "") : "";

/** Favicon with graceful fallback (letter tile, globe, or the Corvus mark for internal pages). */
export function Favicon({ url, src, size = 16 }: { url: string; src?: string; size?: number }) {
  // Remember which icon failed, not that one did: a tab's <Favicon> stays mounted while its page
  // swaps icons, and a working icon must not stay hidden behind an earlier one's load error.
  const [failed, setFailed] = useState<string[]>([]);
  if (url.startsWith("corvus:")) return <CorvusMark size={size} />;
  // No icon of its own (a bookmark, a history entry): the site's icon from Corvus's cache.
  const own = src ?? (/^https?:/i.test(url) ? cachedFaviconUrl(url, faviconProfile || undefined, faviconKey || undefined, faviconRevision) : undefined);
  const shown = faviconSrcToShow(own, failed, url, src !== undefined);
  if (shown) {
    return (
      <img
        key={shown}
        className="favicon"
        src={shown}
        width={size}
        height={size}
        alt=""
        draggable={false}
        onError={() => setFailed((list) => [...list.slice(-7), shown])}
      />
    );
  }
  const host = hostOf(url);
  if (host && /^https?:/.test(url)) return <LetterIcon text={host} size={size} />;
  return <IconGlobe size={size} />;
}

export function Toggle({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      className={`toggle ${checked ? "on" : ""}`}
      onClick={() => onChange(!checked)}
    >
      <span className="knob" />
    </button>
  );
}

export function formatTime(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

export function dayLabel(ms: number): string {
  const d = new Date(ms);
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return t("Today");
  if (d.toDateString() === yesterday.toDateString()) return t("Yesterday");
  return d.toLocaleDateString(undefined, { weekday: "long", year: "numeric", month: "long", day: "numeric" });
}

/** Previous, "1-5 of 12", Next under a list shown `size` items at a time (`page` counts from 0); nothing when one page holds them all. */
export function Pager({ page, size, total, onPage }: { page: number; size: number; total: number; onPage: (page: number) => void }) {
  if (total <= size) return null;
  const last = Math.ceil(total / size) - 1;
  return (
    <div className="pager">
      <button className="btn small ghost" disabled={page <= 0} onClick={() => onPage(page - 1)}>
        {t("Previous")}
      </button>
      <span className="muted small">{t("{from}-{to} of {total}", { from: page * size + 1, to: Math.min(total, (page + 1) * size), total })}</span>
      <button className="btn small ghost" disabled={page >= last} onClick={() => onPage(page + 1)}>
        {t("Next")}
      </button>
    </div>
  );
}
