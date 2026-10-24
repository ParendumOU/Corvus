/**
 * The open windows of another browser, read from its session file: Firefox's sessionstore
 * (mozLz4-compressed JSON) and Chromium's SNSS command log (the commands Chromium replays to restore
 * a session). Each window comes back as its tabs (address, title, pinned, group) and tab groups
 * (title, color, collapsed). Pure, so the formats are unit tested.
 */
import { GROUP_COLORS, type GroupColor } from "@corvus/shared";

export interface ImportedTab {
  url: string;
  title: string;
  pinned: boolean;
  groupId?: string;
}

export interface ImportedGroup {
  id: string;
  title: string;
  color: GroupColor;
  collapsed: boolean;
}

export interface ImportedWindow {
  tabs: ImportedTab[];
  groups: ImportedGroup[];
}

// ------------------------------------------------------------------ Firefox

/** Decodes one LZ4 block into `out` (sized to the decompressed length); returns the bytes written. */
export function lz4Block(src: Uint8Array, out: Uint8Array): number {
  let i = 0;
  let o = 0;
  while (i < src.length) {
    const token = src[i++]!;
    let literals = token >> 4;
    if (literals === 15) {
      let b: number;
      do {
        b = src[i++]!;
        literals += b;
      } while (b === 255 && i < src.length);
    }
    if (i + literals > src.length || o + literals > out.length) throw new Error("Damaged LZ4 data");
    out.set(src.subarray(i, i + literals), o);
    i += literals;
    o += literals;
    if (i >= src.length) break;
    const offset = src[i]! | (src[i + 1]! << 8);
    i += 2;
    if (offset === 0 || offset > o) throw new Error("Damaged LZ4 data");
    let length = token & 15;
    if (length === 15) {
      let b: number;
      do {
        b = src[i++]!;
        length += b;
      } while (b === 255 && i < src.length);
    }
    length += 4;
    if (o + length > out.length) throw new Error("Damaged LZ4 data");
    for (let ref = o - offset, end = o + length; o < end; ) out[o++] = out[ref++]!;
  }
  return o;
}

const MOZLZ4_MAGIC = "mozLz40\0";

/** The text of a Firefox .jsonlz4 / .mozlz4 file ("mozLz40\0", the size, then one LZ4 block). */
export function decodeMozLz4(buf: Uint8Array): string {
  if (buf.length < 12 || new TextDecoder().decode(buf.subarray(0, 8)) !== MOZLZ4_MAGIC) throw new Error("Not a mozLz4 file");
  const size = new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getUint32(8, true);
  if (size > 512 * 1024 * 1024) throw new Error("Session file too large");
  const out = new Uint8Array(size);
  const written = lz4Block(buf.subarray(12), out);
  return new TextDecoder().decode(out.subarray(0, written));
}

const FIREFOX_COLORS: Record<string, GroupColor> = {
  gray: "grey",
  grey: "grey",
  blue: "blue",
  red: "red",
  yellow: "yellow",
  green: "green",
  pink: "pink",
  purple: "purple",
  cyan: "cyan",
  orange: "orange",
};

/** Firefox's open windows from its sessionstore JSON (tab groups as Firefox 137 and later save them). */
export function firefoxSession(json: unknown): ImportedWindow[] {
  const windows = (json as { windows?: unknown } | null)?.windows;
  if (!Array.isArray(windows)) return [];
  const out: ImportedWindow[] = [];
  for (const w of windows as Array<{ tabs?: unknown; groups?: unknown }>) {
    const groups: ImportedGroup[] = Array.isArray(w.groups)
      ? (w.groups as Array<{ id?: unknown; name?: unknown; color?: unknown; collapsed?: unknown }>)
          .filter((g) => typeof g.id === "string")
          .map((g) => ({ id: String(g.id), title: typeof g.name === "string" ? g.name.slice(0, 200) : "", color: FIREFOX_COLORS[String(g.color)] ?? "grey", collapsed: g.collapsed === true }))
      : [];
    const known = new Set(groups.map((g) => g.id));
    const tabs: ImportedTab[] = [];
    for (const t of Array.isArray(w.tabs) ? (w.tabs as Array<{ entries?: unknown; index?: unknown; pinned?: unknown; hidden?: unknown; groupId?: unknown }>) : []) {
      const entries = Array.isArray(t.entries) ? (t.entries as Array<{ url?: unknown; title?: unknown }>) : [];
      const at = typeof t.index === "number" ? t.index - 1 : entries.length - 1;
      const entry = entries[Math.max(0, Math.min(entries.length - 1, at))];
      if (!entry || typeof entry.url !== "string") continue;
      const group = typeof t.groupId === "string" && known.has(t.groupId) ? t.groupId : undefined;
      tabs.push({ url: entry.url, title: typeof entry.title === "string" ? entry.title.slice(0, 500) : "", pinned: t.pinned === true, ...(group ? { groupId: group } : {}) });
    }
    if (tabs.length > 0) out.push({ tabs, groups: groups.filter((g) => tabs.some((t) => t.groupId === g.id)) });
  }
  return out;
}

// ------------------------------------------------------------------ Chromium

/** Reads a base::Pickle (a 4-byte payload size, then fields aligned to 4 bytes). */
class PickleReader {
  private pos = 4;
  private readonly end: number;
  private readonly view: DataView;

  constructor(private readonly buf: Uint8Array) {
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    this.end = buf.length >= 4 ? Math.min(buf.length, 4 + this.view.getUint32(0, true)) : 0;
  }

  private take(bytes: number): number {
    const at = this.pos;
    if (at + bytes > this.end) throw new RangeError("Pickle ended early");
    this.pos += (bytes + 3) & ~3;
    return at;
  }

  int(): number {
    return this.view.getInt32(this.take(4), true);
  }

  uint32(): number {
    return this.view.getUint32(this.take(4), true);
  }

  bool(): boolean {
    return this.int() !== 0;
  }

  uint64(): bigint {
    return this.view.getBigUint64(this.take(8), true);
  }

  string(): string {
    const length = this.int();
    if (length < 0) throw new RangeError("Bad string");
    const at = this.take(length);
    return new TextDecoder().decode(this.buf.subarray(at, at + length));
  }

  string16(): string {
    const chars = this.int();
    if (chars < 0) throw new RangeError("Bad string");
    const at = this.take(chars * 2);
    return new TextDecoder("utf-16le").decode(this.buf.subarray(at, at + chars * 2));
  }
}

const CMD = {
  setTabWindow: 0,
  setTabIndexInWindow: 2,
  updateTabNavigation: 6,
  setSelectedNavigationIndex: 7,
  setWindowType: 9,
  setPinnedState: 12,
  tabClosed: 16,
  windowClosed: 17,
  setTabGroup: 25,
  setTabGroupMetadata2: 27,
} as const;

interface ChromiumTab {
  window: number | null;
  index: number;
  order: number;
  navs: Map<number, { url: string; title: string }>;
  selected: number | null;
  pinned: boolean;
  group: string | null;
}

const groupKey = (high: bigint, low: bigint): string => `g-${high.toString(16)}-${low.toString(16)}`;

/**
 * Chromium's open windows from a session file ("SNSS", a version, then commands: a 16-bit size, an
 * 8-bit id and the payload), replayed in order the way Chromium restores them. Only normal browser
 * windows are kept (no popups or app windows); unknown commands are skipped.
 */
export function chromiumSession(buf: Uint8Array): ImportedWindow[] {
  if (buf.length < 8 || new TextDecoder().decode(buf.subarray(0, 4)) !== "SNSS") throw new Error("Not a Chromium session file");
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const tabs = new Map<number, ChromiumTab>();
  const windowTypes = new Map<number, number>();
  const closedWindows = new Set<number>();
  const groups = new Map<string, { title: string; color: GroupColor; collapsed: boolean }>();
  let order = 0;
  const tab = (id: number): ChromiumTab => {
    let t = tabs.get(id);
    if (!t) {
      t = { window: null, index: Number.MAX_SAFE_INTEGER, order: order++, navs: new Map(), selected: null, pinned: false, group: null };
      tabs.set(id, t);
    }
    return t;
  };

  for (let pos = 8; pos + 2 <= buf.length; ) {
    const size = view.getUint16(pos, true);
    if (size === 0 || pos + 2 + size > buf.length) break;
    const id = buf[pos + 2]!;
    const body = buf.subarray(pos + 3, pos + 2 + size);
    pos += 2 + size;
    const p = new DataView(body.buffer, body.byteOffset, body.byteLength);
    const i32 = (at: number): number | null => (at + 4 <= body.length ? p.getInt32(at, true) : null);
    try {
      switch (id) {
        case CMD.setTabWindow: {
          const window = i32(0);
          const tabId = i32(4);
          if (window !== null && tabId !== null) tab(tabId).window = window;
          break;
        }
        case CMD.setTabIndexInWindow: {
          const tabId = i32(0);
          const index = i32(4);
          if (tabId !== null && index !== null) tab(tabId).index = index;
          break;
        }
        case CMD.updateTabNavigation: {
          const r = new PickleReader(body);
          const tabId = r.int();
          const index = r.int();
          const url = r.string();
          const title = r.string16();
          tab(tabId).navs.set(index, { url, title });
          break;
        }
        case CMD.setSelectedNavigationIndex: {
          const tabId = i32(0);
          const index = i32(4);
          if (tabId !== null && index !== null) tab(tabId).selected = index;
          break;
        }
        case CMD.setWindowType: {
          const window = i32(0);
          const type = i32(4);
          if (window !== null && type !== null) windowTypes.set(window, type);
          break;
        }
        case CMD.setPinnedState: {
          const tabId = i32(0);
          if (tabId !== null && body.length >= 5) tab(tabId).pinned = body[4] !== 0;
          break;
        }
        case CMD.tabClosed: {
          const tabId = i32(0);
          if (tabId !== null) tabs.delete(tabId);
          break;
        }
        case CMD.windowClosed: {
          const window = i32(0);
          if (window !== null) closedWindows.add(window);
          break;
        }
        case CMD.setTabGroup: {
          // { int32 tab_id; (4 bytes padding) uint64 high; uint64 low; bool has_group; }
          const tabId = i32(0);
          if (tabId === null || body.length < 25) break;
          tab(tabId).group = body[24] !== 0 ? groupKey(p.getBigUint64(8, true), p.getBigUint64(16, true)) : null;
          break;
        }
        case CMD.setTabGroupMetadata2: {
          const r = new PickleReader(body);
          const key = groupKey(r.uint64(), r.uint64());
          const title = r.string16();
          const color = GROUP_COLORS[r.uint32()] ?? "grey";
          let collapsed = false;
          try {
            collapsed = r.bool();
          } catch {
            collapsed = false;
          }
          groups.set(key, { title: title.slice(0, 200), color, collapsed });
          break;
        }
        default:
          break;
      }
    } catch {
      // A damaged command is skipped, as Chromium does.
    }
  }

  const byWindow = new Map<number, ChromiumTab[]>();
  for (const t of tabs.values()) {
    if (t.window === null || closedWindows.has(t.window) || (windowTypes.get(t.window) ?? 0) !== 0) continue;
    const list = byWindow.get(t.window) ?? [];
    list.push(t);
    byWindow.set(t.window, list);
  }
  const out: ImportedWindow[] = [];
  for (const list of byWindow.values()) {
    const windowTabs: ImportedTab[] = [];
    for (const t of list.sort((a, b) => a.index - b.index || a.order - b.order)) {
      const latest = [...t.navs.keys()].sort((a, b) => b - a)[0];
      const nav = (t.selected !== null ? t.navs.get(t.selected) : undefined) ?? (latest !== undefined ? t.navs.get(latest) : undefined);
      if (!nav || !nav.url) continue;
      windowTabs.push({ url: nav.url, title: nav.title.slice(0, 500), pinned: t.pinned, ...(t.group && groups.has(t.group) && !t.pinned ? { groupId: t.group } : {}) });
    }
    if (windowTabs.length === 0) continue;
    const used = new Set(windowTabs.map((t) => t.groupId).filter(Boolean));
    out.push({ tabs: windowTabs, groups: [...groups.entries()].filter(([key]) => used.has(key)).map(([id, g]) => ({ id, ...g })) });
  }
  return out;
}
