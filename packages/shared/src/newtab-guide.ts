/** How custom New Tab widgets work, for agents (the MCP newtab tools and the Command Bar agent). */
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
