/**
 * Starting points for custom widgets in the "Add widget" gallery. Each one is an ordinary custom
 * widget (sources + HTML/CSS/JS) the person can edit or an AI agent can rewrite; they show what
 * the widget runtime can do, they are not special cases.
 */
import type { WidgetConfigs } from "../../shared/newtab";
import { t } from "../common/i18n";

export interface WidgetTemplate {
  id: string;
  title: string;
  description: string;
  w: number;
  h: number;
  config: Omit<WidgetConfigs["custom"], "author" | "consent">;
}

const listCss = ".cw-list li { justify-content: space-between; } .price { font-variant-numeric: tabular-nums; font-weight: 600; }";

export function widgetTemplates(): WidgetTemplate[] {
  return [
    {
      id: "crypto",
      title: t("Crypto prices"),
      description: t("Bitcoin, Ethereum and Solana with the 24-hour change, from CoinGecko."),
      w: 3,
      h: 4,
      config: {
        title: "Crypto",
        html: '<div class="cw-title">Crypto</div><ul class="cw-list" id="list"><li class="cw-muted">…</li></ul>',
        css: listCss,
        script: [
          "const names = { bitcoin: 'BTC', ethereum: 'ETH', solana: 'SOL' };",
          "corvus.onData((d) => {",
          "  const p = d.prices || {};",
          "  if (p.error) { list.innerHTML = '<li class=\"cw-error\">' + p.error + '</li>'; return; }",
          "  list.innerHTML = Object.keys(names).map((id) => {",
          "    const row = p[id] || {}; const ch = row.eur_24h_change || 0;",
          "    return '<li><span>' + names[id] + '</span><span><span class=\"price\">' + (row.eur || 0).toLocaleString(corvus.lang, { style: 'currency', currency: 'EUR' }) +",
          "      '</span> <span class=\"' + (ch >= 0 ? 'cw-up' : 'cw-down') + '\">' + (ch >= 0 ? '+' : '') + ch.toFixed(1) + '%</span></span></li>';",
          "  }).join('');",
          "});",
        ].join("\n"),
        sources: [
          { name: "prices", kind: "fetch", url: "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum,solana&vs_currencies=eur&include_24hr_change=true", select: "", everyMinutes: 2 },
        ],
        links: ["www.coingecko.com"],
      },
    },
    {
      id: "stocks",
      title: t("Stock quotes"),
      description: t("Apple, Microsoft and the IBEX 35 with the change since the last close (Yahoo Finance, delayed)."),
      w: 3,
      h: 4,
      config: {
        title: "Stocks",
        html: '<div class="cw-title">Stocks</div><ul class="cw-list" id="list"><li class="cw-muted">…</li></ul>',
        css: listCss,
        script: [
          "const label = { aapl: 'AAPL', msft: 'MSFT', ibex: 'IBEX 35' };",
          "corvus.onData((d) => {",
          "  list.innerHTML = Object.keys(label).map((key) => {",
          "    const meta = (((d[key] || {}).chart || {}).result || [])[0];",
          "    if (!meta) return '<li><span>' + label[key] + '</span><span class=\"cw-muted\">—</span></li>';",
          "    const m = meta.meta; const ch = ((m.regularMarketPrice - m.chartPreviousClose) / m.chartPreviousClose) * 100;",
          "    return '<li><span>' + label[key] + '</span><span><span class=\"price\">' + m.regularMarketPrice.toLocaleString(corvus.lang, { maximumFractionDigits: 2 }) + ' ' + (m.currency || '') +",
          "      '</span> <span class=\"' + (ch >= 0 ? 'cw-up' : 'cw-down') + '\">' + (ch >= 0 ? '+' : '') + ch.toFixed(2) + '%</span></span></li>';",
          "  }).join('');",
          "});",
        ].join("\n"),
        sources: [
          { name: "aapl", kind: "fetch", url: "https://query1.finance.yahoo.com/v8/finance/chart/AAPL?range=1d&interval=1d", select: "", everyMinutes: 5 },
          { name: "msft", kind: "fetch", url: "https://query1.finance.yahoo.com/v8/finance/chart/MSFT?range=1d&interval=1d", select: "", everyMinutes: 5 },
          { name: "ibex", kind: "fetch", url: "https://query1.finance.yahoo.com/v8/finance/chart/%5EIBEX?range=1d&interval=1d", select: "", everyMinutes: 5 },
        ],
        links: ["finance.yahoo.com"],
      },
    },
    {
      id: "weather",
      title: t("Weather"),
      description: t("Current temperature and today's range for Madrid, from Open-Meteo. Change the coordinates in its settings."),
      w: 3,
      h: 3,
      config: {
        title: "Weather",
        html: '<div class="cw-title">Madrid</div><div class="cw-value" id="now">…</div><div class="cw-sub" id="range"></div>',
        css: "",
        script: [
          "const sky = (c) => c === 0 ? '☀️' : c < 3 ? '🌤️' : c < 4 ? '☁️' : c < 50 ? '🌫️' : c < 70 ? '🌧️' : c < 80 ? '❄️' : '⛈️';",
          "corvus.onData((d) => {",
          "  const w = d.weather || {};",
          "  if (!w.current) { now.textContent = '—'; return; }",
          "  now.textContent = sky(w.current.weather_code) + ' ' + Math.round(w.current.temperature_2m) + '°';",
          "  range.textContent = Math.round(w.daily.temperature_2m_min[0]) + '° / ' + Math.round(w.daily.temperature_2m_max[0]) + '°';",
          "});",
        ].join("\n"),
        sources: [
          {
            name: "weather",
            kind: "fetch",
            url: "https://api.open-meteo.com/v1/forecast?latitude=40.4168&longitude=-3.7038&current=temperature_2m,weather_code&daily=temperature_2m_max,temperature_2m_min&forecast_days=1&timezone=auto",
            select: "",
            everyMinutes: 15,
          },
        ],
        links: [],
      },
    },
    {
      id: "news",
      title: t("News feed"),
      description: t("Latest headlines from any RSS or Atom feed (Hacker News to start)."),
      w: 4,
      h: 6,
      config: {
        title: "News",
        html: '<div class="cw-title">Hacker News</div><ul class="cw-list" id="list"><li class="cw-muted">…</li></ul>',
        css: ".cw-list li { flex-direction: column; align-items: flex-start; gap: 2px; } .cw-list a { color: var(--text); font-weight: 500; }",
        script: [
          "corvus.onData((d) => {",
          "  const items = Array.isArray(d.feed) ? d.feed.slice(0, 12) : [];",
          "  list.innerHTML = items.map((i) => {",
          "    const a = document.createElement('a'); a.href = i.url; a.textContent = i.title;",
          "    return '<li>' + a.outerHTML + '<span class=\"cw-sub\">' + (i.at ? new Date(i.at).toLocaleString(corvus.lang, { hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short' }) : '') + '</span></li>';",
          "  }).join('') || '<li class=\"cw-muted\">' + ((d.feed && d.feed.error) || 'No items') + '</li>';",
          "});",
        ].join("\n"),
        sources: [{ name: "feed", kind: "feed", url: "https://hnrss.org/frontpage", select: "", everyMinutes: 15 }],
        links: ["news.ycombinator.com"],
      },
    },
    {
      id: "watched",
      title: t("Watched pages"),
      description: t("Pages you watch with Corvus and what changed on them."),
      w: 4,
      h: 4,
      config: {
        title: "Watched pages",
        html: '<div class="cw-title">Watched pages</div><ul class="cw-list" id="list"><li class="cw-muted">…</li></ul>',
        css: ".cw-list li { flex-direction: column; align-items: flex-start; gap: 2px; } .dot { color: var(--accent); }",
        script: [
          "corvus.onData((d) => {",
          "  const items = Array.isArray(d.watches) ? d.watches : [];",
          "  list.innerHTML = items.slice(0, 8).map((w) => {",
          "    const a = document.createElement('a'); a.href = w.url; a.textContent = w.title;",
          "    const s = document.createElement('span'); s.className = 'cw-sub'; s.textContent = w.summary || '';",
          "    return '<li><span>' + (w.unseen ? '<span class=\"dot\">● </span>' : '') + a.outerHTML + '</span>' + s.outerHTML + '</li>';",
          "  }).join('') || '<li class=\"cw-muted\">Watch a page from its menu to see it here.</li>';",
          "});",
        ].join("\n"),
        sources: [{ name: "watches", kind: "corvus", url: "watches", select: "", everyMinutes: 5 }],
        links: [],
      },
    },
    {
      id: "unread",
      title: t("Unread on a site"),
      description: t("The unread count of a site you are signed in to (X to start; change the address in its settings). Asks before reading with your session."),
      w: 3,
      h: 2,
      config: {
        title: "X",
        html: '<div class="cw-row"><div><div class="cw-title">X</div><div class="cw-sub" id="sub">…</div></div><div class="cw-value" id="n"></div></div>',
        css: "body { display: flex; align-items: center; }",
        script: [
          "corvus.onData((d) => {",
          "  const p = d.site || {};",
          "  if (p.error) { sub.textContent = p.error; n.textContent = ''; return; }",
          "  n.textContent = p.count === null ? '0' : String(p.count);",
          "  sub.textContent = p.count ? 'new notifications' : 'nothing new';",
          "});",
          "document.body.addEventListener('click', () => corvus.open('https://x.com/notifications'));",
        ].join("\n"),
        sources: [{ name: "site", kind: "page", url: "https://x.com/home", select: "", everyMinutes: 15 }],
        links: [],
      },
    },
  ];
}
