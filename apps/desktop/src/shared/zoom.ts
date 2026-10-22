/** Page zoom: Chrome's preset steps and the per-site storage format (keyed by host, like Chrome). */

export const ZOOM_FACTORS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5] as const;
export const MIN_ZOOM = ZOOM_FACTORS[0];
export const MAX_ZOOM = ZOOM_FACTORS[ZOOM_FACTORS.length - 1] as number;
const EPSILON = 0.001;

/** Next preset factor in the given direction; 0 resets to 100%. */
export function stepZoom(current: number, delta: 1 | -1 | 0): number {
  if (delta === 0 || !Number.isFinite(current)) return 1;
  if (delta > 0) return ZOOM_FACTORS.find((f) => f > current + EPSILON) ?? MAX_ZOOM;
  for (let i = ZOOM_FACTORS.length - 1; i >= 0; i--) {
    const f = ZOOM_FACTORS[i] as number;
    if (f < current - EPSILON) return f;
  }
  return MIN_ZOOM;
}

export function zoomPercent(factor: number): number {
  return Math.round(factor * 100);
}

export function isDefaultZoom(factor: number): boolean {
  return Math.abs(factor - 1) < EPSILON;
}

/** Storage key for a page: the hostname for web pages and internal pages, null otherwise. */
export function zoomKey(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol === "http:" || parsed.protocol === "https:" || parsed.protocol === "corvus:") {
    return parsed.hostname ? parsed.hostname.toLowerCase() : null;
  }
  return parsed.protocol === "file:" ? "file" : null;
}

export type ZoomMap = Record<string, number>;

function clampZoom(factor: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, factor));
}

export function setZoom(map: ZoomMap, key: string, factor: number): ZoomMap {
  if (!key || !Number.isFinite(factor)) return map;
  const value = clampZoom(factor);
  const next = { ...map };
  if (isDefaultZoom(value)) delete next[key];
  else next[key] = value;
  return next;
}

export function zoomFor(map: ZoomMap, key: string | null): number {
  return key ? (map[key] ?? 1) : 1;
}

export function reviveZoomMap(raw: unknown): ZoomMap {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  const out: ZoomMap = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === "number" && Number.isFinite(value) && !isDefaultZoom(value)) out[key] = clampZoom(value);
  }
  return out;
}
