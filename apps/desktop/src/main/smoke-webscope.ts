import { WebScopeEngine } from "@corvus/webscope";
import { nativeTheme } from "electron";
import type { AppContext } from "./context";
import { narrowWindow } from "./smoke-pairing";
import type { BrowserWindowCtl, TabRuntime } from "./window";

type Check = (name: string, ok: boolean, detail?: unknown) => void;
type Capture = (name: string, wc: Electron.WebContents) => Promise<void>;
const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * WebScope end-to-end: enable capture, scope the local smoke host, capture a real request over CDP,
 * replay it from Node, run a small in-scope fuzz, then open the workbench and check that History, the
 * counters, Target, Findings and Intercept follow new local traffic live, screenshot every tool in
 * light and dark, and check the header from a 480 px page up and the Session popover in English and
 * Spanish.
 */
export async function runWebscopeSmoke(
  ctx: AppContext,
  { url, win, check, capture }: { url: string; win: BrowserWindowCtl; check: Check; capture: Capture },
): Promise<void> {
  const host = new URL(url).hostname;
  ctx.settings.update({ webscope: { enabled: true } });
  ctx.webscope.apply();
  const engine = ctx.webscope.engineFor(win.profile);
  engine.setScope({ enabled: true, include: [{ host, enabled: true }], exclude: [] });
  check("webscope enabled + scoped", ctx.webscope.activeEngine() === engine && engine.isInScope(url), { host });

  // Capture: open a blank tab so the debugger attaches, then load the in-scope page.
  const probe = win.createTab("about:blank");
  await delay(700);
  await probe.view.webContents.loadURL(`${url}webscope-probe`).catch(() => undefined);
  await delay(1500);
  const captured = engine.queryHistory({ host }, 50);
  check("webscope captured a request over CDP", captured.length > 0 && captured.some((h) => h.inScope), captured.slice(0, 3));

  // Repeater: replay an in-scope request from Node.
  const replay = await engine.repeaterSend({ method: "GET", url: `${url}webscope-replay`, headers: [] }).then(
    (e) => e,
    () => null,
  );
  check("webscope repeater replay", replay?.response?.status === 200, { status: replay?.response?.status, source: replay?.source });

  // Repeater refuses out-of-scope targets.
  const refused = await engine.repeaterSend({ method: "GET", url: "https://out-of-scope.example/", headers: [] }).then(
    () => false,
    () => true,
  );
  check("webscope repeater refuses out-of-scope", refused);

  // Fuzzer: small in-scope sniper attack with three payloads.
  const fuzz = await engine
    .fuzz({
      template: { method: "GET", url: `${url}item/§id§`, headers: [] },
      attack: "sniper",
      payloadSets: [{ kind: "wordlist", values: ["a", "b", "c"] }],
      concurrency: 2,
      requestsPerSecond: 10,
      grep: ["smoke page"],
    })
    .then(
      (r) => r,
      () => null,
    );
  check("webscope 3-payload in-scope fuzz", fuzz?.summary.completed === 3 && fuzz.summary.total === 3, fuzz?.summary);

  // Session: save with the captured traffic and open it in a fresh engine; its scope arrives disarmed.
  const saved = JSON.parse(JSON.stringify(engine.exportSession({ includeHistory: true }))) as { history?: unknown[] };
  const copy = new WebScopeEngine();
  const opened = await copy.importSession(saved).catch(() => null);
  check(
    "webscope session save and open",
    !!opened && opened.history === saved.history?.length && opened.history > 0 && copy.getScope().include.length === 1 && !copy.getScope().enabled,
    { opened, saved: saved.history?.length },
  );
  check("webscope fuzz grep + audit", Boolean(fuzz?.rows.some((r) => r.matched.includes("smoke page"))) && engine.auditLog().some((a) => a.action === "fuzz-finish"), {
    matched: fuzz?.rows.filter((r) => r.matched.length).length,
  });

  // Interactive intercept: hold an in-scope request, then forward it edited.
  await ctx.webscope.setInterceptConfig({ enabled: true, interceptRequests: true, interceptResponses: false });
  const interceptTab = win.createTab("about:blank");
  await delay(600);
  void interceptTab.view.webContents.loadURL(`${url}intercept-me`).catch(() => undefined);
  let queue = ctx.webscope.interceptState().queue;
  for (let i = 0; i < 50 && queue.length === 0; i++) {
    await delay(100);
    queue = ctx.webscope.interceptState().queue;
  }
  check("webscope held an in-scope request", queue.length > 0, queue[0] && { host: queue[0].host, path: queue[0].path, phase: queue[0].phase });
  const first = queue[0];
  if (first) {
    await ctx.webscope.interceptForward(first.id, { headers: [...first.request.headers, { name: "X-Corvus-Intercept", value: "1" }] });
    await delay(400);
  }
  check("webscope forwarded the held request", ctx.webscope.interceptState().queue.length === 0);
  await ctx.webscope.setInterceptConfig({ enabled: false, interceptRequests: true, interceptResponses: false });

  // UI: open the workbench. From here on traffic is generated while it is open, against the smoke's
  // own local server, and the page must follow without a reload.
  const page = win.createTab("corvus://webscope");
  const wc = page.view.webContents;
  await delay(1500);
  const ready = await wc.executeJavaScript("Boolean(window.corvusInternal && document.querySelector('.ws-root') && document.querySelector('.ws-tabs') && document.querySelector('.ws-scopestrip'))");
  check("corvus://webscope rendered", ready === true);

  const js = <T>(script: string): Promise<T> => wc.executeJavaScript(script) as Promise<T>;
  const poll = async <T>(script: string, done: (value: T) => boolean, ms = 6000): Promise<T> => {
    let value = await js<T>(script);
    for (let waited = 0; waited < ms && !done(value); waited += 100) {
      await delay(100);
      value = await js<T>(script);
    }
    return value;
  };
  const click = async (script: string): Promise<void> => {
    await wc.executeJavaScript(script);
    await delay(500);
  };
  const showView = (view: string): Promise<void> => click(`(()=>{const b=document.querySelector('.ws-tab[data-view="${view}"]');if(b)b.click();return !!b;})()`);
  // Same-origin fetches from the probe page: every one is a new captured exchange.
  const traffic = (prefix: string, count: number): Promise<unknown> =>
    probe.view.webContents.executeJavaScript(`Promise.all(Array.from({length:${count}},(_,i)=>fetch('/${prefix}-'+i).then((r)=>r.text())))`);
  const ROWS = "[...document.querySelectorAll('.ws-table tbody tr:not(.ws-spacer-row)')]";
  const capturedReadout = "Number(document.querySelector('.ws-readout b')?.textContent)";

  // History and the command bar counter follow new traffic; the marker proves the page never reloaded.
  await js("window.__wsLive = 1");
  const before = await js<number>(capturedReadout);
  await traffic("webscope-live", 5);
  const live = await poll<{ rows: number; captured: number; marker: boolean }>(
    `({ rows: ${ROWS}.filter((r) => r.textContent.includes('/webscope-live-')).length, captured: ${capturedReadout}, marker: window.__wsLive === 1 })`,
    (v) => v.rows === 5 && v.captured === engine.history.size(),
  );
  check("webscope History and the captured counter update live, without a reload", live.rows === 5 && live.marker && live.captured === engine.history.size() && live.captured >= before + 5, { ...live, before, size: engine.history.size() });

  // Scrolled down, new rows must not move the row being read; they are counted on the "new" button.
  await traffic("webscope-fill", 60);
  await poll<number>(capturedReadout, (n) => n === engine.history.size());
  await poll<number>(`${ROWS}.length`, (n) => n >= 40);
  // The first row under the header, and where it sits on screen.
  const rowAtTop = `(() => { const head = document.querySelector('.ws-table thead th').getBoundingClientRect(); const row = ${ROWS}.find((r) => r.getBoundingClientRect().top >= head.bottom - 1); return row ? row.textContent + ' @ ' + Math.round(row.getBoundingClientRect().top) : ''; })()`;
  await js("(() => { const wrap = document.querySelector('.ws-tablewrap'); wrap.scrollTop = 20 * 27 + 9; wrap.dispatchEvent(new Event('scroll')); })()");
  await delay(300);
  const reading = await js<string>(rowAtTop);
  await traffic("webscope-burst", 10);
  const pill = await poll<string>("document.querySelector('.ws-unseen')?.textContent ?? ''", (t) => t.includes("10"));
  const stillReading = await js<string>(rowAtTop);
  check("webscope History keeps the row being read in place while new rows arrive above it", reading !== "" && stillReading === reading && pill.includes("10 new"), { reading, stillReading, pill });
  await capture("webscope-history-live-light", wc);
  await click("document.querySelector('.ws-unseen')?.click()");
  const jumped = await js<{ top: number; pill: boolean; first: string }>(`({ top: document.querySelector('.ws-tablewrap').scrollTop, pill: Boolean(document.querySelector('.ws-unseen')), first: ${ROWS}[0]?.textContent ?? '' })`);
  check("webscope History \"new\" button jumps to the new rows", jumped.top === 0 && !jumped.pill && jumped.first.includes("/webscope-burst-"), jumped);

  // Target and Findings rebuild live from new traffic.
  await showView("target");
  await traffic("webscope-live-target/leaf", 1);
  const target = await poll<boolean>("[...document.querySelectorAll('.ws-tree-seg')].some((s) => s.textContent.startsWith('webscope-live-target'))", Boolean);
  check("webscope Target adds new paths live", target);
  await showView("findings");
  const findingsCount = "[...document.querySelectorAll('.ws-finding-count')].reduce((n, el) => n + parseInt(el.textContent, 10), 0)";
  const findingsBefore = await js<number>(findingsCount);
  await traffic("webscope-live-finding", 1);
  const findingsAfter = await poll<number>(findingsCount, (n) => n > findingsBefore);
  check("webscope Findings add new observations live", findingsAfter > findingsBefore, { findingsBefore, findingsAfter });

  // Intercept: the held queue and the badge on its tab appear and clear as requests are held and forwarded.
  await showView("intercept");
  await ctx.webscope.setInterceptConfig({ enabled: true, interceptRequests: true, interceptResponses: false });
  const held = win.createTab("about:blank");
  await delay(500);
  void held.view.webContents.loadURL(`${url}intercept-live`).catch(() => undefined);
  win.activate(page.id);
  const queued = await poll<{ rows: number; badge: string }>(
    "({ rows: [...document.querySelectorAll('.ws-queue-row')].filter((r) => r.textContent.includes('/intercept-live')).length, badge: document.querySelector('.ws-tab[data-view=\"intercept\"] .ws-held')?.textContent ?? '' })",
    (v) => v.rows === 1 && v.badge === "1",
  );
  check("webscope Intercept shows a held request live, with a count on its tab", queued.rows === 1 && queued.badge === "1", queued);
  for (const q of ctx.webscope.interceptState().queue) await ctx.webscope.interceptForward(q.id, null);
  const released = await poll<{ rows: number; badge: boolean }>("({ rows: document.querySelectorAll('.ws-queue-row').length, badge: Boolean(document.querySelector('.ws-held')) })", (v) => v.rows === 0 && !v.badge);
  check("webscope Intercept clears forwarded requests live", released.rows === 0 && !released.badge, released);
  await ctx.webscope.setInterceptConfig({ enabled: false, interceptRequests: true, interceptResponses: false });

  const original = nativeTheme.themeSource;
  const language = ctx.settings.get().appearance.language;
  try {
    for (const theme of ["light", "dark"] as const) {
      nativeTheme.themeSource = theme;
      await delay(400);
      await showView("history");
      // Prefer the probe page (an HTML body, so the Pretty view has content); else the first row.
      await click(
        "(()=>{const rows=[...document.querySelectorAll('.ws-table tbody tr:not(.ws-spacer-row)')];const r=rows.find(x=>x.textContent.includes('/webscope-probe'))||rows[0];if(r)r.click();return !!r;})()",
      );
      await capture(`webscope-history-${theme}`, wc);
      await click("(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.textContent.includes('Send to Repeater'));if(b)b.click();return !!b;})()");
      await capture(`webscope-repeater-${theme}`, wc);
      for (const tool of ["fuzzer", "target", "findings", "scope", "rules", "decoder", "comparer"]) {
        await showView(tool);
        await capture(`webscope-${tool}-${theme}`, wc);
      }
    }
    // Intercept view: hold a request so the queue + editor render, screenshot both themes, then release.
    await ctx.webscope.setInterceptConfig({ enabled: true, interceptRequests: true, interceptResponses: false });
    const shot = win.createTab("about:blank");
    await delay(500);
    void shot.view.webContents.loadURL(`${url}intercept-shot`).catch(() => undefined);
    let queue = ctx.webscope.interceptState().queue;
    for (let i = 0; i < 40 && queue.length === 0; i++) {
      await delay(100);
      queue = ctx.webscope.interceptState().queue;
    }
    // The held load opened a new tab; bring WebScope back to the front so it renders (a background
    // tab does not run CSS transitions, which would freeze button colours mid theme switch).
    win.activate(page.id);
    await delay(400);
    for (const theme of ["light", "dark"] as const) {
      nativeTheme.themeSource = theme;
      await delay(400);
      await showView("intercept");
      await capture(`webscope-intercept-${theme}`, wc);
    }
    // The header with the held request counted on the Intercept tab.
    await runHeaderSmoke(ctx, { win, page, check, capture, js, poll, click });
    for (const q of ctx.webscope.interceptState().queue) await ctx.webscope.interceptForward(q.id, null);
    await ctx.webscope.setInterceptConfig({ enabled: false, interceptRequests: true, interceptResponses: false });

    await runSessionPanelSmoke(ctx, { win, wc, engine, check, capture, js, poll, click });
  } finally {
    nativeTheme.themeSource = original;
    ctx.settings.update({ appearance: { language } });
  }

  ctx.settings.update({ webscope: { enabled: false } });
  ctx.webscope.apply();
}

/** Page widths the header is checked at: WebScope in a split pane or a small window, up to a wide one. */
const HEADER_WIDTHS = [480, 520, 640, 800, 1280];

interface HeaderAudit {
  width: number;
  /** Width the top bar's items take, spacer aside: how much room is left. */
  topbar: number;
  /** Items outside the page or their row, overlapping, with text cut off or broken over lines, or with neither text nor tooltip. */
  problems: string[];
}

const HEADER_AUDIT = `(() => {
  const problems = [];
  let topbar = 0;
  const name = (el) => el.getAttribute('class') + ' "' + el.textContent.trim().slice(0, 24) + '"';
  const inside = (r, box) => r.left >= box.left - 1 && r.right <= box.right + 1 && r.top >= box.top - 1 && r.bottom <= box.bottom + 1;
  for (const row of document.querySelectorAll('.ws-topbar, .ws-tabs, .ws-scopestrip')) {
    const box = row.getBoundingClientRect();
    if (!inside(box, { left: 0, right: innerWidth, top: 0, bottom: innerHeight })) problems.push('outside the page: ' + name(row));
    const items = row.matches('.ws-tabs') ? [...row.querySelectorAll('.ws-tab')] : [...row.children].filter((el) => !el.matches('.ws-spacer') && el.getClientRects().length > 0);
    if (row.matches('.ws-topbar')) {
      const style = getComputedStyle(row);
      topbar = Math.round(items.reduce((w, el) => w + el.getBoundingClientRect().width, 0) + parseFloat(style.columnGap) * (row.children.length - 1) + parseFloat(style.paddingLeft) + parseFloat(style.paddingRight));
    }
    items.forEach((el, i) => {
      const r = el.getBoundingClientRect();
      if (!inside(r, box)) problems.push('clipped: ' + name(el));
      for (const other of items.slice(i + 1)) {
        const o = other.getBoundingClientRect();
        if (Math.min(r.right, o.right) - Math.max(r.left, o.left) > 1 && Math.min(r.bottom, o.bottom) - Math.max(r.top, o.top) > 1) problems.push('overlaps: ' + name(el) + ' / ' + name(other));
      }
      let shown = '';
      const texts = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      for (let node = texts.nextNode(); node; node = texts.nextNode()) {
        const range = document.createRange();
        range.selectNodeContents(node);
        const lines = new Set([...range.getClientRects()].filter((l) => l.width > 0).map((l) => Math.round(l.top)));
        if (!node.textContent.trim() || lines.size === 0) continue;
        shown += node.textContent;
        if (lines.size > 1) problems.push('broken over lines: ' + name(el));
        if (!inside(range.getBoundingClientRect(), r)) problems.push('text cut off: ' + name(el));
      }
      if (!shown.trim() && !el.title && !el.getAttribute('aria-label')) problems.push('neither text nor tooltip: ' + name(el));
    });
  }
  return { width: innerWidth, topbar, problems };
})()`;

/**
 * The header (top bar, tool tabs with the held count on Intercept, scope strip) from a split pane to
 * a wide window, in English and Spanish, light and dark: nothing outside the page, clipped,
 * overlapping or broken over lines, and the Session popover fits the narrowest page.
 */
async function runHeaderSmoke(
  ctx: AppContext,
  {
    win,
    page,
    check,
    capture,
    js,
    poll,
    click,
  }: {
    win: BrowserWindowCtl;
    page: TabRuntime;
    check: Check;
    capture: Capture;
    js: <T>(script: string) => Promise<T>;
    poll: <T>(script: string, done: (value: T) => boolean, ms?: number) => Promise<T>;
    click: (script: string) => Promise<void>;
  },
): Promise<void> {
  const wc = page.view.webContents;
  const setWidth = async (width: number): Promise<void> => {
    page.view.setBounds({ ...page.view.getBounds(), width });
    await delay(400);
  };
  for (const language of ["en", "es"] as const) {
    ctx.settings.update({ appearance: { language } });
    wc.reload();
    await poll<boolean>("Boolean(document.querySelector('.ws-tab .ws-held') && !document.querySelector('.ws-topbtn').disabled)", Boolean);
    for (const width of HEADER_WIDTHS) {
      await setWidth(width);
      for (const theme of ["light", "dark"] as const) {
        nativeTheme.themeSource = theme;
        await delay(400);
        if (theme === "light") {
          const audit = await js<HeaderAudit>(HEADER_AUDIT);
          check(`webscope header (${language}, ${width} px): nothing clipped, overlapping or broken over lines`, audit.width === width && audit.problems.length === 0, audit);
        }
        await capture(`webscope-header-${language}-${width}-${theme}`, wc);
      }
    }
    const narrowest = HEADER_WIDTHS[0]!;
    await setWidth(narrowest);
    nativeTheme.themeSource = "light";
    await delay(400);
    await click("document.querySelector('.ws-topbtn').click()");
    const session = await poll<SessionPanelAudit | null>(SESSION_AUDIT, (a) => a !== null);
    check(`webscope Session popover (${language}) fits a ${narrowest} px page`, !!session && session.width === narrowest && session.placed && session.aligned && session.fits, session);
    await capture(`webscope-header-${language}-${narrowest}-session`, wc);
    await click("document.querySelector('.ws-topbtn').click()");
    win.relayout();
    await delay(300);
  }
}

interface SessionPanelAudit {
  head: string;
  titles: string[];
  buttons: string[][];
  option: string;
  /** Under the Session button and fully inside the window. */
  placed: boolean;
  /** The Save and Open actions share a right edge and a width. */
  aligned: boolean;
  /** Nothing in the popover sticks out of it or scrolls sideways. */
  fits: boolean;
  width: number;
}

const SESSION_AUDIT = `(() => {
  const p = document.querySelector('.ws-session');
  if (!p || getComputedStyle(p).visibility === 'hidden') return null;
  const r = p.getBoundingClientRect();
  const button = document.querySelector('.ws-topbtn').getBoundingClientRect();
  const cards = [...p.querySelectorAll('.ws-session-card')];
  const actions = cards.map((c) => [...c.querySelectorAll('.ws-session-actions .btn')].pop()?.getBoundingClientRect());
  return {
    head: p.querySelector('h2')?.textContent ?? '',
    titles: cards.map((c) => c.querySelector('h3')?.textContent ?? ''),
    buttons: cards.map((c) => [...c.querySelectorAll('.ws-session-actions .btn')].map((b) => b.textContent)),
    option: p.querySelector('.ws-session-option')?.textContent ?? '',
    placed: r.top >= button.bottom - 1 && r.left >= 0 && r.right <= window.innerWidth && r.bottom <= window.innerHeight,
    aligned: actions.length === 2 && actions.every((a) => a && Math.abs(a.right - actions[0].right) < 1 && Math.abs(a.width - actions[0].width) < 1),
    fits: p.scrollWidth <= p.clientWidth + 1 && [...p.querySelectorAll('h2, h3, p, label, button')].every((el) => { const b = el.getBoundingClientRect(); return b.left >= r.left - 1 && b.right <= r.right + 1; }),
    width: window.innerWidth,
  };
})()`;

/**
 * The Session popover in English and Spanish: titles, the traffic option, aligned actions, the
 * in-panel confirmation and the feedback after saving and opening, wide and narrow.
 */
async function runSessionPanelSmoke(
  ctx: AppContext,
  {
    win,
    wc,
    engine,
    check,
    capture,
    js,
    poll,
    click,
  }: {
    win: BrowserWindowCtl;
    wc: Electron.WebContents;
    engine: WebScopeEngine;
    check: Check;
    capture: Capture;
    js: <T>(script: string) => Promise<T>;
    poll: <T>(script: string, done: (value: T) => boolean, ms?: number) => Promise<T>;
    click: (script: string) => Promise<void>;
  },
): Promise<void> {
  const scope = engine.getScope();
  const sessionFile = JSON.stringify(engine.exportSession({ includeHistory: false }));
  const expected = {
    en: { head: "Session", titles: ["Save session", "Open session"], buttons: [["Save to file"], ["Open file…"]], option: "Include captured traffic (", saved: "Session saved", opened: "Session opened", replace: "Replace the current scope and rules with smoke-session.json?" },
    es: { head: "Sesión", titles: ["Guardar sesión", "Abrir sesión"], buttons: [["Guardar en archivo"], ["Abrir archivo…"]], option: "Incluir el tráfico capturado (", saved: "Sesión guardada", opened: "Sesión abierta", replace: "¿Sustituir el alcance y las reglas actuales por smoke-session.json?" },
  } as const;
  const toggle = "document.querySelector('.ws-topbtn').click()";
  for (const language of ["en", "es"] as const) {
    const want = expected[language];
    ctx.settings.update({ appearance: { language } });
    wc.reload();
    await poll<boolean>("Boolean(document.querySelector('.ws-topbtn') && !document.querySelector('.ws-topbtn').disabled)", Boolean);
    for (const theme of ["light", "dark"] as const) {
      nativeTheme.themeSource = theme;
      await delay(400);
      await click(toggle);
      const audit = await poll<SessionPanelAudit | null>(SESSION_AUDIT, (a) => a !== null);
      if (theme === "light") {
        check(
          `webscope Session popover (${language}): titles, traffic option and aligned Save and Open actions`,
          !!audit && audit.head === want.head && JSON.stringify(audit.titles) === JSON.stringify(want.titles) && JSON.stringify(audit.buttons) === JSON.stringify(want.buttons) && audit.option.startsWith(want.option) && audit.placed && audit.aligned && audit.fits,
          audit,
        );
      }
      await capture(`webscope-session-${language}-${theme}`, wc);
      await click(toggle);
    }
    nativeTheme.themeSource = "light";
    await delay(300);
    await click(toggle);

    // Include traffic: the privacy warning shows; saving reports the file and what went in it.
    await click("document.querySelector('.ws-session-option input').click()");
    const warned = await js<boolean>("Boolean(document.querySelector('.ws-session-warn'))");
    await click("document.querySelector('.ws-session-card .btn.primary').click()");
    const saved = await poll<string>("document.querySelector('.ws-session-msg.ok')?.textContent ?? ''", (t) => t.length > 0);
    check(`webscope Session popover (${language}): traffic warning and feedback after saving`, warned && saved.startsWith(want.saved) && saved.includes("corvus-webscope-session-"), { warned, saved });
    await capture(`webscope-session-${language}-saved`, wc);

    // Open: a scope is set, so the panel asks before replacing it, then reports what it added.
    await js(`(() => {
      const input = document.querySelector('.ws-session input[type=file]');
      const files = new DataTransfer();
      files.items.add(new File([${JSON.stringify(sessionFile)}], 'smoke-session.json', { type: 'application/json' }));
      input.files = files.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    const confirm = await poll<string>("document.querySelector('.ws-session-confirm p')?.textContent ?? ''", (t) => t.length > 0);
    await capture(`webscope-session-${language}-confirm`, wc);
    await click("document.querySelector('.ws-session-confirm .btn.primary').click()");
    const opened = await poll<string>("document.querySelector('.ws-session-msg.ok')?.textContent ?? ''", (t) => t.startsWith(want.opened));
    const view = await js<string>("document.querySelector('.ws-tab.active')?.dataset.view ?? ''");
    check(`webscope Session popover (${language}): asks before replacing the scope, then reports the opened session`, confirm === want.replace && opened.startsWith(want.opened) && view === "scope", { confirm, opened, view });
    await capture(`webscope-session-${language}-opened`, wc);
    // The opened session arrives disarmed: arm the smoke scope again.
    engine.setScope(scope);

    // Narrow window: the popover stays under its button and inside the window, nothing cut off.
    await narrowWindow(win.win, async () => {
      const narrow = await poll<SessionPanelAudit | null>(SESSION_AUDIT, (a) => a !== null && a.width <= 600);
      check(`webscope Session popover (${language}) fits a narrow window`, !!narrow && narrow.placed && narrow.aligned && narrow.fits, narrow);
      await capture(`webscope-session-${language}-narrow`, wc);
    });
    await js("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))");
    await delay(200);
    check(`webscope Session popover (${language}) closes with Escape`, (await js<boolean>("Boolean(document.querySelector('.ws-session'))")) === false);
  }
}
