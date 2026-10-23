/**
 * Pure geometry and key handling for the agent's coordinate ("visual") tools: click_at, hover_at,
 * scroll_at, press_key and type_text.
 *
 * Coordinate spaces:
 * - screenshot px: pixels of the image the model saw. Corvus sizes agent screenshots to the
 *   viewport's CSS pixels (1:1) unless the viewport is larger than the image cap, then scales down.
 * - CSS px: the page's viewport coordinates (what elementFromPoint takes).
 * - DIP: the tab view's device-independent pixels (what webContents.sendInputEvent takes).
 *   DIP = CSS px x page zoom factor. Device scale (HiDPI) never enters: capturePage returns physical
 *   pixels, which the screenshot step resizes back to CSS px before the model sees them.
 */

/** Long-edge and total-pixel caps for an agent screenshot (vision models downscale beyond these anyway). */
export const SHOT_MAX_EDGE = 1280;
export const SHOT_MAX_PIXELS = 1_000_000;

/** What the model saw: the image size and the CSS viewport it shows. */
export interface ShotGeometry {
  width: number;
  height: number;
  cssWidth: number;
  cssHeight: number;
}

/** Image size for a viewport of cssWidth x cssHeight CSS px: 1:1 when it fits the caps, else scaled down. */
export function fitShot(cssWidth: number, cssHeight: number): ShotGeometry {
  const w = Math.max(1, Math.round(cssWidth));
  const h = Math.max(1, Math.round(cssHeight));
  const scale = Math.min(1, SHOT_MAX_EDGE / Math.max(w, h), Math.sqrt(SHOT_MAX_PIXELS / (w * h)));
  return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)), cssWidth: w, cssHeight: h };
}

export interface Point {
  x: number;
  y: number;
}

/** Reads {x, y} from a tool input; null unless both are finite numbers. */
export function pointOf(input: unknown): Point | null {
  const o = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const x = typeof o.x === "number" ? o.x : typeof o.x === "string" ? Number(o.x) : NaN;
  const y = typeof o.y === "number" ? o.y : typeof o.y === "string" ? Number(o.y) : NaN;
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
}

/**
 * Screenshot pixel -> viewport CSS px. Without a screenshot yet, the point is taken as CSS px.
 * Returns null when the point is outside the screenshot / viewport.
 */
export function shotToCss(shot: ShotGeometry | null | undefined, p: Point): Point | null {
  const sx = shot ? shot.cssWidth / shot.width : 1;
  const sy = shot ? shot.cssHeight / shot.height : 1;
  const x = p.x * sx;
  const y = p.y * sy;
  if (x < 0 || y < 0) return null;
  if (shot && (x >= shot.cssWidth || y >= shot.cssHeight)) return null;
  return { x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10 };
}

/** Viewport CSS px -> tab view DIP for sendInputEvent (page zoom applies, device scale does not). */
export function cssToDip(p: Point, zoom: number): Point {
  const z = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  return { x: Math.round(p.x * z), y: Math.round(p.y * z) };
}

// --------------------------------------------------------------------------- keys

export type Modifier = "shift" | "control" | "alt" | "meta";

/** One key press for sendInputEvent: Electron keyCode, optional char event text, modifiers. */
export interface KeyPress {
  keyCode: string;
  char: string | null;
  modifiers: Modifier[];
  /** Display name, e.g. "Control+A". */
  label: string;
}

const MODIFIER_ALIASES: Record<string, Modifier> = {
  shift: "shift",
  ctrl: "control",
  control: "control",
  alt: "alt",
  option: "alt",
  meta: "meta",
  cmd: "meta",
  command: "meta",
  super: "meta",
  win: "meta",
};

/** DOM key names and common spellings -> Electron accelerator key codes (with the char they type). */
const NAMED_KEYS: Record<string, { keyCode: string; char: string | null }> = {
  enter: { keyCode: "Enter", char: "\r" },
  return: { keyCode: "Enter", char: "\r" },
  numpadenter: { keyCode: "Enter", char: "\r" },
  tab: { keyCode: "Tab", char: null },
  escape: { keyCode: "Escape", char: null },
  esc: { keyCode: "Escape", char: null },
  backspace: { keyCode: "Backspace", char: null },
  delete: { keyCode: "Delete", char: null },
  del: { keyCode: "Delete", char: null },
  insert: { keyCode: "Insert", char: null },
  space: { keyCode: "Space", char: " " },
  spacebar: { keyCode: "Space", char: " " },
  " ": { keyCode: "Space", char: " " },
  arrowup: { keyCode: "Up", char: null },
  up: { keyCode: "Up", char: null },
  arrowdown: { keyCode: "Down", char: null },
  down: { keyCode: "Down", char: null },
  arrowleft: { keyCode: "Left", char: null },
  left: { keyCode: "Left", char: null },
  arrowright: { keyCode: "Right", char: null },
  right: { keyCode: "Right", char: null },
  home: { keyCode: "Home", char: null },
  end: { keyCode: "End", char: null },
  pageup: { keyCode: "PageUp", char: null },
  pagedown: { keyCode: "PageDown", char: null },
};

/**
 * Parses a key for press_key: "Enter", "ArrowDown", "a", "F5", or a combo like "Control+A" /
 * "Shift+Tab", plus optional extra modifiers. Null for anything that is not one key.
 */
export function parseKey(key: string, extraModifiers: unknown = []): KeyPress | null {
  const trimmed = key.trim();
  const raw = trimmed === "" && key.length > 0 ? "Space" : trimmed;
  if (!raw || raw.length > 40) return null;
  const parts = raw === "+" ? ["+"] : raw.split("+").map((p) => p.trim());
  const base = parts.pop();
  if (base === undefined || base === "") return null;
  const modifiers = new Set<Modifier>();
  for (const m of [...parts, ...(Array.isArray(extraModifiers) ? extraModifiers : [])]) {
    const mod = typeof m === "string" ? MODIFIER_ALIASES[m.trim().toLowerCase()] : undefined;
    if (!mod) return null;
    modifiers.add(mod);
  }
  let keyCode: string;
  let char: string | null;
  const named = NAMED_KEYS[base.toLowerCase()];
  if (named) {
    ({ keyCode, char } = named);
  } else if (/^f([1-9]|1[0-9]|2[0-4])$/i.test(base)) {
    keyCode = base.toUpperCase();
    char = null;
  } else if ([...base].length === 1) {
    const letter = /^[a-z]$/i.test(base);
    keyCode = letter ? base.toUpperCase() : base;
    char = letter ? (modifiers.has("shift") ? base.toUpperCase() : base.toLowerCase()) : base;
  } else {
    return null;
  }
  const mods = (["control", "alt", "shift", "meta"] as const).filter((m) => modifiers.has(m));
  // A shortcut (Control+A) runs a command; it must not also type the letter.
  if (mods.includes("control") || mods.includes("meta") || mods.includes("alt")) char = keyCode === "Enter" ? char : null;
  const names: Record<Modifier, string> = { control: "Control", alt: "Alt", shift: "Shift", meta: "Meta" };
  const shown = keyCode.length === 1 ? keyCode : keyCode === "Up" || keyCode === "Down" || keyCode === "Left" || keyCode === "Right" ? `Arrow${keyCode}` : keyCode;
  return { keyCode, char, modifiers: mods, label: [...mods.map((m) => names[m]), shown].join("+") };
}

/** Keys that activate the focused control (a button or link) or submit its form. */
export function isActivationKey(press: KeyPress): boolean {
  return press.keyCode === "Enter" || press.keyCode === "Space";
}

export const WHEEL_DEFAULT = 400;
export const WHEEL_MAX = 3000;

/**
 * Wheel deltas (DOM convention: positive deltaY scrolls down) for scroll_at {direction, amount}.
 * direction: up | down (default) | left | right; amount in px, default 400, capped at 3000.
 */
export function wheelDelta(input: unknown): { deltaX: number; deltaY: number } {
  const o = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const dir = typeof o.direction === "string" ? o.direction.toLowerCase() : "down";
  const raw = typeof o.amount === "number" && Number.isFinite(o.amount) ? Math.abs(o.amount) : WHEEL_DEFAULT;
  const amount = Math.max(1, Math.min(WHEEL_MAX, Math.round(raw)));
  if (dir === "up") return { deltaX: 0, deltaY: -amount };
  if (dir === "left") return { deltaX: -amount, deltaY: 0 };
  if (dir === "right") return { deltaX: amount, deltaY: 0 };
  return { deltaX: 0, deltaY: amount };
}
