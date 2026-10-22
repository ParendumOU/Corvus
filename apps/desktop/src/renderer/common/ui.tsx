import { useState } from "react";
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

/** Letter tile for a site; no network request involved. */
export function LetterIcon({ text, size = 16 }: { text: string; size?: number }) {
  const letter = (text.replace(/^www\./, "")[0] ?? "?").toUpperCase();
  return (
    <span
      className="letter-icon"
      style={{ width: size, height: size, fontSize: size * 0.6, background: LETTER_COLORS[hash(text) % LETTER_COLORS.length] }}
      aria-hidden="true"
    >
      {letter}
    </span>
  );
}

/** Favicon with graceful fallback (letter tile, globe, or the Corvus mark for internal pages). */
export function Favicon({ url, src, size = 16 }: { url: string; src?: string; size?: number }) {
  const [failed, setFailed] = useState(false);
  if (url.startsWith("corvus:")) return <CorvusMark size={size} />;
  if (src && !failed) {
    return <img className="favicon" src={src} width={size} height={size} alt="" draggable={false} onError={() => setFailed(true)} />;
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
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
  return d.toLocaleDateString(undefined, { weekday: "long", year: "numeric", month: "long", day: "numeric" });
}
