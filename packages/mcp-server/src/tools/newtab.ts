import { z } from "zod";
import { errorResult, need, text, type ToolContext } from "./types.js";

/**
 * The New Tab page as a dashboard agents can build: built-in widgets (greeting, search, shortcuts,
 * clock, notes) and custom widgets written in HTML/CSS/JS that Corvus runs sandboxed and feeds
 * with data from the sources they declare. Standard level: it changes Corvus's own page, never a
 * website, and every change is undoable by the person (newtab_undo, or Undo on the page).
 */
export const NEWTAB_GUIDE = `How custom New Tab widgets work:
- Code runs in a sandboxed frame: no network, no cookies, no forms, no popups. Data comes only from
  the sources you declare; Corvus reads them and hands them in.
- In script: corvus.onData((data) => ...) is called with { <sourceName>: value } on load and on every
  refresh; corvus.data holds the latest. A failed source is { error }. corvus.open(url) opens a link
  (only hosts of your sources or of "links"). corvus.theme is "dark" or "light"; corvus.lang is
  "en" or "es".
- Source kinds: fetch (public http(s) URL, JSON when it parses, else text), feed (RSS/Atom as
  [{ title, url, source, at }]), page (a page read with the person's session: { url, title, count,
  text }, count = unread number in the title, text = innerText of "select"; the person must allow
  the host first; at least every 10 minutes), corvus ("watches": watched pages and their latest
  change, "top-sites": most visited sites). everyMinutes sets the refresh.
- Widgets with page or corvus sources can only show images from data: URLs.
- Style with the page's look: CSS variables --text, --text-2, --text-3, --accent, --accent-soft,
  --surface, --surface-2, --border, --success, --warning, --danger; classes cw-title, cw-sub,
  cw-value, cw-up, cw-down, cw-muted, cw-list (li rows), cw-row, cw-chip, cw-grid, cw-link.
  Keep the background transparent: the card around the widget is drawn by Corvus.
- Grid: 12 columns; rows of 48 px. Size w x h in cells.`;

const box = {
  x: z.number().int().min(0).max(11).optional(),
  y: z.number().int().min(0).max(79).optional(),
  w: z.number().int().min(1).max(12).optional(),
  h: z.number().int().min(1).max(40).optional(),
};

const source = z.object({
  name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,31}$/).describe("Key the widget reads (corvus.data[name])"),
  kind: z.enum(["fetch", "feed", "page", "corvus"]),
  url: z.string().min(1).max(2048).describe('Address (fetch, feed, page) or "watches" / "top-sites" (corvus)'),
  select: z.string().max(200).optional().describe("page: CSS selector whose text to read"),
  everyMinutes: z.number().int().min(1).max(1440).optional(),
});

export function registerNewTabTools({ controller, register, client }: ToolContext): void {
  const run = async (request: Record<string, unknown>) => {
    try {
      return text(await need(controller.newtab?.bind(controller), "newtab")(request, client()));
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err));
    }
  };

  register(
    "newtab_layout",
    { description: "The New Tab dashboard: widgets, positions, settings, background, and how to build custom widgets.", requires: "newtab", inputSchema: {}, readOnly: true },
    async () => {
      const res = await run({ action: "get" });
      return res.isError ? res : text(`${(res.content[0] as { text: string }).text}\n\n${NEWTAB_GUIDE}`);
    },
  );

  register(
    "newtab_add_widget",
    {
      description: "Add a built-in widget (greeting, search, shortcuts, clock, notes) to the New Tab page.",
      requires: "newtab",
      inputSchema: {
        type: z.enum(["greeting", "search", "shortcuts", "clock", "notes"]),
        config: z.record(z.string(), z.unknown()).optional().describe("Widget settings, as newtab_layout shows them"),
        ...box,
      },
    },
    (a) => run({ action: "add", ...a }),
  );

  register(
    "newtab_custom_widget",
    {
      description: "Create or replace a custom New Tab widget (HTML/CSS/JS fed by declared data sources). Read newtab_layout first.",
      requires: "newtab",
      inputSchema: {
        id: z.string().max(40).optional().describe("Existing custom widget to replace; omit to create one"),
        title: z.string().max(80),
        html: z.string().max(65536).describe("Body markup"),
        css: z.string().max(65536).optional(),
        script: z.string().max(65536).optional().describe("Runs after the markup; use corvus.onData(fn)"),
        sources: z.array(source).max(8).optional(),
        links: z.array(z.string().max(253)).max(20).optional().describe("Extra hosts corvus.open may open"),
        ...box,
      },
    },
    (a) => {
      const { id, x, y, w, h, ...config } = a;
      return run({ action: "custom", ...(id ? { id } : {}), config, x, y, w, h });
    },
  );

  register(
    "newtab_update_widget",
    {
      description: "Move, resize or change the settings of a New Tab widget by id.",
      requires: "newtab",
      inputSchema: { id: z.string().min(1).max(40), config: z.record(z.string(), z.unknown()).optional(), ...box },
    },
    (a) => run({ action: "update", ...a }),
  );

  register(
    "newtab_remove_widget",
    { description: "Remove a widget from the New Tab page by id.", requires: "newtab", inputSchema: { id: z.string().min(1).max(40) } },
    (a) => run({ action: "remove", id: a.id }),
  );

  register(
    "newtab_set_background",
    {
      description: "Set the New Tab background: default, a color, or a daily wallpaper (bing, wikimedia, nasa, picsum).",
      requires: "newtab",
      inputSchema: {
        kind: z.enum(["default", "color", "wallpaper"]),
        color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
        source: z.enum(["bing", "wikimedia", "nasa", "picsum"]).optional(),
        dim: z.number().min(0).max(0.8).optional().describe("Darken the picture (0 to 0.8)"),
        blur: z.number().min(0).max(24).optional(),
      },
    },
    (a) => run({ action: "background", background: a }),
  );

  register(
    "newtab_undo",
    { description: "Undo the last change to the New Tab page.", requires: "newtab", inputSchema: {} },
    () => run({ action: "undo" }),
  );
}
