/**
 * The document of a custom New Tab widget, served at corvus://newtab/widget/<id> into a frame with
 * sandbox="allow-scripts" (an opaque origin: no cookies, storage or access to the page around it).
 * Its own CSP allows only its inline code, no network at all; widgets that hold private data
 * (page or corvus sources) cannot even load images from the web, so nothing can leak through an
 * image address. Data arrives by postMessage from the New Tab page (see newtab-widgets.tsx).
 */
import type { WidgetConfigs } from "../shared/newtab";

const LIGHT = "--text:#1f2023;--text-2:#5f6368;--text-3:#80868b;--border:#dadce0;--border-soft:#e8eaed;--surface:#ffffff;--surface-2:#f1f3f6;--accent:#5b5bd6;--accent-soft:rgba(91,91,214,.12);--success:#188038;--warning:#b06000;--danger:#d93025";
const DARK = "--text:#f1f2f4;--text-2:rgba(241,242,244,.72);--text-3:rgba(241,242,244,.5);--border:rgba(255,255,255,.16);--border-soft:rgba(255,255,255,.1);--surface:#2a2b30;--surface-2:rgba(255,255,255,.08);--accent:#8b8cf8;--accent-soft:rgba(139,140,248,.16);--success:#81c995;--warning:#fdd663;--danger:#f28b82";

const TOKENS = `
:root{--font:"Inter","Segoe UI Variable","Segoe UI",system-ui,-apple-system,Roboto,sans-serif;--mono:"JetBrains Mono","Cascadia Code",Consolas,monospace;
--text:#1f2023;--text-2:#5f6368;--text-3:#80868b;--border:#dadce0;--border-soft:#e8eaed;--surface:#ffffff;--surface-2:#f1f3f6;
--accent:#5b5bd6;--accent-soft:rgba(91,91,214,.12);--success:#188038;--warning:#b06000;--danger:#d93025}
@media (prefers-color-scheme:dark){:root{--text:#e8eaed;--text-2:#9aa0a6;--text-3:#80868b;--border:#3c4043;--border-soft:#34363a;
--surface:#2a2b30;--surface-2:#323338;--accent:#8b8cf8;--accent-soft:rgba(139,140,248,.16);--success:#81c995;--warning:#fdd663;--danger:#f28b82}}`;

const KIT = `
*{box-sizing:border-box}html,body{margin:0;height:100%;background:transparent}
body{font:13.5px/1.45 var(--font);color:var(--text);overflow:auto;overflow-wrap:anywhere}
a{color:var(--accent);text-decoration:none;cursor:pointer}a:hover{text-decoration:underline}
.cw-title{font-size:13px;font-weight:650;letter-spacing:.01em;margin:0 0 6px}
.cw-sub,.cw-muted{color:var(--text-2);font-size:12px}
.cw-value{font-size:28px;font-weight:700;letter-spacing:-.02em;font-variant-numeric:tabular-nums;line-height:1.15}
.cw-up{color:var(--success)}.cw-down{color:var(--danger)}
.cw-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column}
.cw-list>li{display:flex;align-items:center;gap:8px;padding:7px 0;border-top:1px solid var(--border-soft)}
.cw-list>li:first-child{border-top:none}
.cw-row{display:flex;align-items:center;justify-content:space-between;gap:10px}
.cw-chip{display:inline-flex;align-items:center;padding:1px 8px;border-radius:20px;background:var(--surface-2);color:var(--text-2);font-size:11.5px}
.cw-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(110px,1fr));gap:10px}
.cw-link{color:inherit}.cw-link:hover{color:var(--accent)}
.cw-error{color:var(--danger);font-size:12px}`;

/** window.corvus for widget code: data handed in by the page, a way to open links. */
const BOOTSTRAP = `(() => {
  const listeners = [];
  const corvus = {
    data: null,
    theme: document.documentElement.dataset.tone || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"),
    lang: document.documentElement.lang || "en",
    onData(fn) { if (typeof fn !== "function") return; listeners.push(fn); if (corvus.data) try { fn(corvus.data); } catch (e) { console.error(e); } },
    open(url) { parent.postMessage({ type: "corvus:open", url: String(url) }, "*"); },
    refresh() { parent.postMessage({ type: "corvus:refresh" }, "*"); },
  };
  window.corvus = corvus;
  addEventListener("message", (e) => {
    if (e.source !== parent || !e.data || e.data.type !== "corvus:data") return;
    corvus.data = e.data.data;
    for (const fn of listeners) try { fn(corvus.data); } catch (err) { console.error(err); }
  });
  addEventListener("click", (e) => {
    const a = e.target instanceof Element ? e.target.closest("a[href]") : null;
    if (!a) return;
    e.preventDefault();
    corvus.open(a.href);
  });
  parent.postMessage({ type: "corvus:ready" }, "*");
})();`;

/** True when a widget reads data that belongs to the person (their session or Corvus's data). */
export function holdsPrivateData(config: WidgetConfigs["custom"]): boolean {
  return config.sources.some((s) => s.kind === "page" || s.kind === "corvus");
}

/** </script> and </style> inside the person's or an agent's code would end the element early. */
const inert = (code: string, tag: "script" | "style"): string => code.replace(new RegExp(`</${tag}`, "gi"), `<\\/${tag}`);

/**
 * `tone` is how the card around the widget looks (dark glass on pictures); null follows the system.
 * The document never sets color-scheme: Chromium paints an opaque backdrop under a frame whose
 * scheme differs from the page around it, which would hide the card.
 */
export function widgetDocument(config: WidgetConfigs["custom"], lang: string, tone: "light" | "dark" | null = null): { html: string; csp: string } {
  const privateData = holdsPrivateData(config);
  const csp = [
    "default-src 'none'",
    "script-src 'unsafe-inline'",
    "style-src 'unsafe-inline'",
    privateData ? "img-src data:" : "img-src https: data:",
    "font-src data:",
    privateData ? "media-src 'none'" : "media-src https:",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'self'",
  ].join("; ");
  const html = `<!doctype html><html lang="${lang === "es" ? "es" : "en"}"${tone ? ` data-tone="${tone}"` : ""}><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>${TOKENS}${tone ? `:root{${tone === "dark" ? DARK : LIGHT}}` : ""}${KIT}</style><style>${inert(config.css, "style")}</style></head>
<body>${config.html}<script>${BOOTSTRAP}</script><script>${inert(config.script, "script")}</script></body></html>`;
  return { html, csp };
}
