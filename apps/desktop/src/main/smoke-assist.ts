import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { clipboard, nativeTheme, type WebContents } from "electron";
import type { AnswerProvider, ProviderEvent } from "@corvus/ai-engine";
import { ASSIST_DEFAULT_WIDTH, type OverlayEvent } from "../shared/assist-ipc";
import type { AppContext } from "./context";
import type { BrowserWindowCtl } from "./window";

/**
 * Corvus Assist + agent overlay smoke (CORVUS_SMOKE_OUT): a fake, no-network provider drives the
 * side panel through summarize and ask, the tab organizer preview, the agents timeline and the
 * in-page agent overlay, captured in light and dark. Verifies the merged panel/overlay render.
 */

interface Helpers {
  win: BrowserWindowCtl;
  check: (name: string, ok: boolean, detail?: unknown) => void;
  capture: (name: string, wc: WebContents) => Promise<void>;
}

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>The Common Raven — Field Notes</title></head>
<body><article><h1>The Common Raven</h1>
<p>The common raven (Corvus corax) is a large all-black passerine bird, the most widely distributed of all corvids.</p>
<h2>Size and range</h2><p>Larger than a crow, the raven has a wingspan of up to 1.3 metres and ranges across the whole Northern Hemisphere, from deserts to the high Arctic.</p>
<h2>Intelligence</h2><p>Ravens solve multi-step puzzles, use tools and have been shown to plan for future events, a trait once thought unique to great apes.</p>
<h2>Behaviour</h2><p>Pairs cooperate to steal food, play in flight and on the ground, and can mimic sounds from their environment, including human speech.</p>
</article></body></html>`;

/** A product page for "Compare tabs" ("/phone-a", "/phone-b"). */
function phonePage(letter: string): string {
  const specs: Record<string, [number, number]> = { a: [5000, 199], b: [4000, 149] };
  const [battery, price] = specs[letter] ?? [3000, 99];
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Phone ${letter.toUpperCase()}</title></head><body><article>
<h1>Phone ${letter.toUpperCase()}</h1><h2>Specs</h2><p>Battery ${battery} mAh. Price ${price} €. A phone with a bright screen and two cameras for everyday use.</p>
</article></body></html>`;
}

/** A mail-like compose page: a textarea, a rich-text editor and a password field, each counting input events. */
const COMPOSE_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Compose</title></head><body>
<textarea id="body" rows="4" cols="60">Helo team,
see you tomorow.</textarea>
<div id="rich" contenteditable="true" style="min-height:40px;border:1px solid #ccc"></div>
<input id="secret" type="password" value="hunter2">
<script>
window.__inputs = 0;
for (const el of document.querySelectorAll("textarea, [contenteditable]")) el.addEventListener("input", () => window.__inputs++);
</script></body></html>`;

function chunk(text: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += 18) out.push(text.slice(i, i + 18));
  return out;
}

const SUMMARY = [
  "TLDR: The common raven is a large, strikingly intelligent black bird found right across the Northern Hemisphere.",
  "- One of the largest songbirds, with a wingspan up to 1.3 m and a vast range [1]",
  "- Solves multi-step puzzles, uses tools and plans ahead for the future [2]",
  "- Pairs cooperate to find food and can mimic sounds, including human speech [3]",
].join("\n");

const ASK =
  "Ravens differ from crows in three clear ways: they are noticeably larger, show a wedge-shaped tail in flight, and give a deep croaking call rather than a caw [1][3].";

/** An answer with artifacts: a table, key figures and a short form, with a citation to drop on copy. */
const ARTIFACT_ANSWER = [
  "Two airlines fly there [2].",
  "```artifact",
  JSON.stringify({ type: "table", title: "Flights", columns: [{ key: "airline", label: "Airline" }, { key: "price", label: "Price", format: "currency", currency: "EUR" }], rows: [{ airline: "Vueling", price: 111 }, { airline: "TAP", price: 99 }] }),
  "```",
  "```artifact",
  JSON.stringify({ type: "cards", layout: "kpi", items: [{ label: "Cheapest", value: "€99", tone: "good" }, { label: "Direct flights", value: "2" }] }),
  "```",
  "To book, I need a few details:",
  "```artifact",
  JSON.stringify({ type: "form", title: "Trip", fields: [{ key: "dates", label: "Dates", required: true }, { key: "bag", label: "Checked bag", type: "checkbox" }], submit_label: "Send details" }),
  "```",
].join("\n");

const GROUPS = JSON.stringify({
  groups: [
    { name: "Corvid research", color: "green", tabs: [1, 2, 3] },
    { name: "Raven news", color: "blue", tabs: [4, 5] },
  ],
});

function replyFor(system: string, user: string): string {
  // The comparer: one column per page it was given, read back from the pages' own specs.
  if (/Compare the numbered web pages/.test(system)) {
    const pages = [...user.matchAll(/<page n="\d+">[\s\S]*?Battery (\d+) mAh[\s\S]*?Price (\d+) €[\s\S]*?<\/page>/g)];
    return JSON.stringify({
      rows: [
        { label: "Battery", values: pages.map((p) => `${p[1]} mAh`) },
        { label: "Price", values: pages.map((p) => `${p[2]} €`) },
      ],
      verdict: "Phone A lasts longer; Phone B costs less.",
    });
  }
  // The writing helper: the field's text with its typos fixed, or a reply drafted for the request.
  if (/writing helper inside a text field/.test(system)) {
    if (/<request>/.test(user)) return "\"Thanks for the invitation, I will be there on Friday.\"";
    return (/<text>\n([\s\S]*)\n<\/text>/.exec(user)?.[1] ?? "").replace("Helo", "Hello").replace("tomorow", "tomorrow");
  }
  // The translator: echo every numbered segment back, marked as Spanish.
  if (/a translator\. Translate each numbered segment/.test(system)) {
    return user
      .split("\n")
      .map((line) => /^(\d+)\|(.*)$/.exec(line))
      .filter((m): m is RegExpExecArray => m !== null)
      .map((m) => `${m[1]}|[es] ${m[2]}`)
      .join("\n");
  }
  if (/Summarize the web page/.test(system)) return SUMMARY;
  if (/Group the user's numbered browser tabs/.test(system)) return GROUPS;
  if (/Answer the user's question/.test(system) && /<question>[^<]*options as a table/.test(user)) return ARTIFACT_ANSWER;
  if (/Answer the user's question/.test(system) && /<question>«Trip»/.test(user)) return "Noted: I will look for flights on those dates.";
  if (/Answer the user's question/.test(system)) return ASK;
  return ASK;
}

/** The last prompt the fake provider was given (what Assist actually sent). */
let lastUserPrompt = "";

// A stand-in YouTube watch page: a player object with captions and a seek that records calls.
const WATCH_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Ravens explained - YouTube</title></head><body>
<div id="movie_player"></div>
<script>
window.__seeks = [];
const player = document.getElementById("movie_player");
player.getPlayerResponse = () => ({
  videoDetails: { videoId: "ravens12345", title: "Ravens explained" },
  captions: { playerCaptionsTracklistRenderer: { captionTracks: [{ baseUrl: "/api/timedtext?v=ravens12345&lang=en", languageCode: "en" }] } },
});
player.seekTo = (t) => window.__seeks.push(t);
player.playVideo = () => {};
</script></body></html>`;

const CAPTIONS = JSON.stringify({
  events: [
    { tStartMs: 0, segs: [{ utf8: "Ravens are large black birds." }] },
    { tStartMs: 70_000, segs: [{ utf8: "They can solve puzzles." }] },
    { tStartMs: 140_000, segs: [{ utf8: "They mate for life." }] },
  ],
});

function fakeProvider(): AnswerProvider {
  return {
    kind: "anthropic-api",
    model: "claude-haiku-5-5",
    async *answer(req): AsyncGenerator<ProviderEvent> {
      lastUserPrompt = req.prompt.user;
      const reply = replyFor(req.prompt.system, req.prompt.user);
      for (const part of chunk(reply)) {
        if (req.signal?.aborted) return;
        await new Promise((r) => setTimeout(r, 4));
        yield { type: "delta", text: part };
      }
      yield { type: "usage", inputTokens: Math.ceil((req.prompt.system.length + req.prompt.user.length) / 3), outputTokens: Math.ceil(reply.length / 3.4), model: "claude-haiku-5-5" };
    },
  };
}

const ORGANIZE_TABS: Array<[string, string]> = [
  ["/raven", "Common raven — Wikipedia"],
  ["/intelligence", "How smart are ravens? — Cornell Lab"],
  ["/puzzle", "Raven solves an eight-step puzzle (video)"],
  ["/news-london", "Ravens return to nest in London — The Guardian"],
  ["/news-plan", "Ravens plan for the future, study finds — NYT"],
];

async function poll(wc: WebContents, expr: string, timeoutMs = 8000): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if ((await wc.executeJavaScript(`Boolean(${expr})`).catch(() => false)) === true) return true;
    await new Promise((r) => setTimeout(r, 120));
  }
  return false;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function runAssistSmoke(ctx: AppContext, h: Helpers): Promise<void> {
  const { win, check, capture } = h;
  const themeBefore = nativeTheme.themeSource;
  const closers: Array<() => void> = [];
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    const route = _req.url ?? "/";
    res.end(route.startsWith("/compose") ? COMPOSE_PAGE : route.startsWith("/phone-") ? phonePage(route.slice(7, 8)) : PAGE);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  ctx.assist.setTestProvider(fakeProvider());
  const extraTabs: string[] = [];
  const pageTab = win.createTab(`${base}/raven`, { activate: true });
  await poll(pageTab.view.webContents, "document.querySelector('h1')");

  try {
    ctx.assist.open(win, "assist");
    const panel = ctx.assist.panelWebContents(win);
    check("assist panel view", Boolean(panel));
    if (!panel) return;
    await poll(panel, "document.querySelector('.composer textarea')");

    for (const theme of ["light", "dark"] as const) {
      nativeTheme.themeSource = theme;
      await sleep(200);
      ctx.assist.setView(win, "assist");

      // Summarize.
      ctx.assist.activeAction(win, "summarize");
      const summarized = await poll(panel, "document.querySelector('.msg.summary .tldr') && document.querySelectorAll('.msg.summary .points li').length >= 3 && document.querySelector('.msg.summary .usage')");
      check(`assist summarize (${theme})`, summarized, summarized ? undefined : await panel.executeJavaScript("document.querySelector('.thread')?.innerText?.slice(0,300)"));
      await sleep(150);
      await capture(`assist-summary-${theme}`, panel);

      // Ask.
      ctx.assist.activeAction(win, "ask", "How can I tell a raven from a crow?");
      const asked = await poll(panel, "document.querySelector('.question') && [...document.querySelectorAll('.msg.ask .rich')].some((e) => e.innerText.includes('crows'))");
      check(`assist ask (${theme})`, asked, asked ? undefined : await panel.executeJavaScript("document.querySelector('.thread')?.innerText?.slice(0,300)"));
      await panel.executeJavaScript("document.querySelector('.composer textarea').value = 'Do ravens mate for life?'; document.querySelector('.composer textarea').dispatchEvent(new Event('input', { bubbles: true }))").catch(() => 0);
      await sleep(200);
      await capture(`assist-ask-${theme}`, panel);
      ctx.assist.clear(win);
    }

    // Artifacts: the panel draws the answer's table, key figures and form; the table sorts; Copy
    // writes the answer out without citations; the form's answers go back as the next question.
    nativeTheme.themeSource = "light";
    ctx.assist.activeAction(win, "ask", "Show the options as a table");
    const drawn = await poll(panel, "document.querySelectorAll('.artifact-table tbody tr').length === 2 && document.querySelectorAll('.artifact-cards .kpi').length === 2 && document.querySelector('.artifact-form input')");
    check("assist answers draw their artifacts (table, key figures, form)", drawn, drawn ? undefined : await panel.executeJavaScript("document.querySelector('.thread')?.innerText?.slice(0,400)"));
    await capture("assist-artifacts", panel);
    await panel.executeJavaScript("document.querySelectorAll('.artifact-table th button')[1]?.click()");
    const sorted = await poll(panel, "document.querySelector('.artifact-table tbody tr td')?.innerText === 'TAP'");
    check("an artifact table sorts by a column", sorted);
    clipboard.writeText("");
    await panel.executeJavaScript("document.querySelector('.msg-copy')?.click()");
    let copiedAnswer = "";
    for (let i = 0; i < 20 && !copiedAnswer; i++) {
      await sleep(100);
      copiedAnswer = String(await clipboard.readText());
    }
    check("copy writes the answer out with its tables, without citations", copiedAnswer.includes("| Airline | Price |") && copiedAnswer.includes("- Cheapest: €99") && !copiedAnswer.includes("[2]"), copiedAnswer.slice(0, 300));
    await panel.executeJavaScript(
      "(() => { const el = document.querySelector('.artifact-form input:not([type=checkbox])'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, '3-5 May'); el.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('.artifact-form input[type=checkbox]')?.click(); })()",
    );
    await sleep(100);
    await panel.executeJavaScript("document.querySelector('.artifact-form button[type=submit]')?.click()");
    const replied = await poll(panel, "[...document.querySelectorAll('.question')].some((q) => q.innerText.includes('«Trip»') && q.innerText.includes('3-5 May')) && [...document.querySelectorAll('.msg.ask .rich')].some((e) => e.innerText.includes('Noted'))");
    check("a form in an answer sends what the person filled in as the next question", replied, replied ? undefined : await panel.executeJavaScript("document.querySelector('.thread')?.innerText?.slice(-400)"));
    ctx.assist.clear(win);

    // The panel's left edge drags it wider; a double-click puts the default width back.
    const panelWidth = (): Promise<number> => panel.executeJavaScript("window.innerWidth") as Promise<number>;
    const widthBefore = await panelWidth();
    // The handle measures the drag in screen coordinates (the panel moves under the pointer as it grows).
    panel.sendInputEvent({ type: "mouseDown", x: 3, y: 300, globalX: 1003, globalY: 300, button: "left", clickCount: 1 });
    for (const x of [-20, -60, -100]) {
      panel.sendInputEvent({ type: "mouseMove", x, y: 300, globalX: 1000 + x, globalY: 300, button: "left", modifiers: ["leftbuttondown"] });
      await sleep(60);
    }
    panel.sendInputEvent({ type: "mouseUp", x: -100, y: 300, globalX: 900, globalY: 300, button: "left", clickCount: 1 });
    let wider = widthBefore;
    for (let i = 0; i < 20 && wider < widthBefore + 60; i++) {
      await sleep(100);
      wider = await panelWidth();
    }
    check("dragging the Assist panel's edge makes it wider", wider >= widthBefore + 60, { widthBefore, after: wider });
    await panel.executeJavaScript("document.querySelector('.resize')?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))");
    let reset = wider;
    for (let i = 0; i < 20 && reset !== ASSIST_DEFAULT_WIDTH; i++) {
      await sleep(100);
      reset = await panelWidth();
    }
    check("double-clicking the edge puts the default width back", reset === ASSIST_DEFAULT_WIDTH, { widthBefore, after: reset });

    // Page translation from the address bar: offered for a page in another language, translated
    // in place, and the original back on a second click.
    nativeTheme.themeSource = "light";
    ctx.settings.update({ translate: { targetLanguage: "es", offer: true } });
    win.activate(pageTab.id);
    win.loadUrl(pageTab.id, `${base}/raven`);
    const chromeUi = win.chrome.webContents;
    const translateState = async (want: string): Promise<boolean> => {
      for (let i = 0; i < 80; i++) {
        if (win.state().translate?.state === want) return true;
        await sleep(100);
      }
      return false;
    };
    const offered = (await translateState("offer")) && (await poll(chromeUi, "document.querySelector('.omni-translate.offer')"));
    check("a page in another language offers translation in the address bar", offered, win.state().translate);
    const original = (await pageTab.view.webContents.executeJavaScript("document.querySelector('h1').textContent")) as string;
    await chromeUi.executeJavaScript("document.querySelector('.omni-translate')?.click()");
    const translated = await translateState("translated");
    const heading = (await pageTab.view.webContents.executeJavaScript("document.querySelector('h1').textContent")) as string;
    check("translate puts the translation in place", translated && heading === `[es] ${original.trim()}` && (win.state().translate?.translated ?? 0) > 1, {
      state: win.state().translate,
      heading,
    });
    await capture("translate-page", chromeUi);
    await chromeUi.executeJavaScript("document.querySelector('.omni-translate')?.click()");
    const restored = (await translateState("offer")) && (await poll(pageTab.view.webContents, `document.querySelector('h1').textContent === ${JSON.stringify(original)}`));
    check("show original puts the page's own text back", restored, win.state().translate);
    ctx.settings.update({ translate: { targetLanguage: "", offer: true } });

    // A YouTube video: Summarize reads its captions as timestamped stretches, and a cited stretch
    // jumps the video to its moment.
    // youtube.com is HSTS-preloaded: the stand-in is served over HTTPS with a throwaway certificate.
    const tls = selfSignedCert("www.youtube.com");
    const videoServer = https.createServer(tls ?? {}, (req, res) => {
      res.writeHead(200, { "Content-Type": req.url?.startsWith("/api/timedtext") ? "application/json" : "text/html; charset=utf-8" });
      res.end(req.url?.startsWith("/api/timedtext") ? CAPTIONS : WATCH_PAGE);
    });
    await new Promise<void>((resolve) => videoServer.listen(0, "127.0.0.1", resolve));
    closers.push(() => videoServer.close());
    const port = (videoServer.address() as AddressInfo).port;
    const videoTab = win.createTab(`https://www.youtube.com:${port}/watch?v=ravens12345`, { activate: true });
    extraTabs.push(videoTab.id);
    await poll(videoTab.view.webContents, "document.getElementById('movie_player') && window.__seeks");
    lastUserPrompt = "";
    ctx.assist.activeAction(win, "summarize");
    const videoSummary = await poll(panel, "document.querySelectorAll('.msg.summary .tldr').length > 0");
    check(
      "assist summarizes a video from its captions",
      videoSummary && lastUserPrompt.includes("kind: video transcript") && lastUserPrompt.includes("[3] 2:20") && lastUserPrompt.includes("They mate for life."),
      lastUserPrompt.slice(0, 400),
    );
    await ctx.assist.jumpToSection(win, 1);
    const seeks = (await videoTab.view.webContents.executeJavaScript("window.__seeks")) as number[];
    check("a cited stretch jumps the video to its moment", JSON.stringify(seeks) === "[70]", seeks);
    await capture("assist-video-summary", panel);
    ctx.assist.clear(win);
    win.activate(pageTab.id);

    // Agents timeline: connect a client and record a realistic run.
    nativeTheme.themeSource = "light";
    ctx.settings.update({ mcp: { enabled: true } });
    await ctx.mcp.apply();
    seedTimeline(ctx);
    for (const theme of ["light", "dark"] as const) {
      nativeTheme.themeSource = theme;
      ctx.assist.setView(win, "agents");
      const shown = await poll(panel, "document.querySelector('.agents .timeline li') && document.querySelector('.agents .kill h3') && document.querySelector('.agents .clients li')");
      check(`agent activity timeline (${theme})`, shown, shown ? undefined : await panel.executeJavaScript("document.querySelector('.agents')?.innerText?.slice(0,300)"));
      await sleep(150);
      await capture(`agent-activity-${theme}`, panel);
    }
    ctx.settings.update({ mcp: { enabled: false } });
    await ctx.mcp.apply();

    // Agent overlay over the page (cursor, ring, caption, edge frame).
    win.activate(pageTab.id);
    for (const theme of ["light", "dark"] as const) {
      nativeTheme.themeSource = theme;
      const dark = theme === "dark";
      const bounds = pageTab.view.getBounds();
      ctx.agents.layout(win, bounds);
      const overlay = ctx.agents.overlayFor(win);
      const event: OverlayEvent = {
        type: "act",
        caption: "Claude Code: clicking 'Add to cart'",
        target: { x: Math.round(bounds.width * 0.32), y: Math.round(bounds.height * 0.42), width: 168, height: 44 },
        kind: "click",
        dark,
      };
      overlay.show(event, 6000);
      await sleep(700);
      const owc = overlay.webContents;
      const ok = Boolean(owc) && (await poll(owc!, "document.querySelector('.caption.show') && document.querySelector('.ring.show') && document.querySelector('.cursor.show')"));
      check(`agent overlay (${theme})`, ok, ok ? undefined : await owc?.executeJavaScript("document.body.innerHTML.length"));
      await sleep(150);
      if (owc) await capture(`agent-overlay-${theme}`, owc);
      overlay.hide();
      await sleep(250);
    }

    // Tab organizer preview (chrome overlay).
    for (const id of ORGANIZE_TABS) extraTabs.push(win.createTab(`${base}${id[0]}`, { activate: false }).id);
    await sleep(400);
    const chrome = win.chrome.webContents;
    for (const theme of ["light", "dark"] as const) {
      nativeTheme.themeSource = theme;
      ctx.windows.broadcastState();
      await sleep(150);
      win.runCommand({ type: "organize-tabs" });
      const shown = await poll(chrome, "document.querySelector('.organizer .org-group') && document.querySelectorAll('.organizer .org-group').length >= 1 && document.querySelector('.organizer .org-foot')");
      check(`tab organizer preview (${theme})`, shown, shown ? undefined : await chrome.executeJavaScript("document.querySelector('.organizer')?.innerText?.slice(0,300)"));
      await sleep(200);
      await capture(`tab-organizer-${theme}`, chrome);
      await chrome.executeJavaScript("document.querySelector('.organizer .org-foot .btn')?.click()").catch(() => 0);
      await sleep(200);
    }

    // AI agents settings: the access-level picker and status card. The page owns its state, so the
    // Full/caution state is driven through its own button (also exercises the real update IPC).
    ctx.settings.update({ mcp: { accessLevel: "standard", allowEvaluate: false, enabled: true } });
    await ctx.mcp.apply();
    const settingsTab = win.createTab("corvus://settings/#agents", { activate: true });
    const swc = settingsTab.view.webContents;
    await poll(swc, "document.querySelector('.access-seg button.on')");
    for (const theme of ["light", "dark"] as const) {
      nativeTheme.themeSource = theme;
      ctx.windows.broadcastState();
      await poll(swc, `matchMedia('(prefers-color-scheme: dark)').matches === ${theme === "dark"}`);
      // Light shows the standard default; dark picks Full to show its caution.
      const target = theme === "dark" ? "Full" : "Standard";
      await swc.executeJavaScript(`[...document.querySelectorAll('.access-seg button')].find((b) => b.textContent.trim() === ${JSON.stringify(target)})?.click()`).catch(() => 0);
      await swc.executeJavaScript("document.getElementById('agents')?.scrollIntoView({ block: 'start' })").catch(() => 0);
      const ready = await poll(swc, theme === "dark" ? "document.querySelector('.access-seg button.full.on') && document.querySelector('.access-caution')" : "document.querySelector('.access-seg button.on')");
      check(`settings access-level picker (${theme})`, ready, ready ? undefined : await swc.executeJavaScript("document.querySelector('#agents')?.innerText?.slice(0,200)"));
      await sleep(450);
      await capture(`settings-agents-${theme}`, swc);
    }
    ctx.settings.update({ mcp: { accessLevel: "standard", allowEvaluate: false, enabled: false } });
    await ctx.mcp.apply();
    win.closeTab(settingsTab.id);

    // "Write with Corvus AI": the text waits in the panel and goes into the field on Insert only.
    nativeTheme.themeSource = "light";
    const compose = win.createTab(`${base}/compose`, { activate: true });
    extraTabs.push(compose.id);
    const cwc = compose.view.webContents;
    await poll(cwc, "document.getElementById('body')");
    ctx.assist.open(win, "assist");
    ctx.assist.clear(win);
    cwc.focus();
    await cwc.executeJavaScript("document.getElementById('body').focus(); true");
    await ctx.assist.writeInField(win, compose, "fix");
    const proposed = await poll(panel, "[...document.querySelectorAll('.msg.write .write-actions button')].some((b) => b.textContent.includes('Insert'))");
    const untouched = (await cwc.executeJavaScript("document.getElementById('body').value")) as string;
    check("write: the fixed text waits in the panel, the field is untouched", proposed && untouched === "Helo team,\nsee you tomorow.", { proposed, untouched });
    await capture("assist-write", panel);
    await panel.executeJavaScript("[...document.querySelectorAll('.msg.write .write-actions button')].find((b) => b.textContent.includes('Insert'))?.click()");
    const fixed = await poll(cwc, "document.getElementById('body').value === 'Hello team,\\nsee you tomorrow.' && window.__inputs > 0");
    check("write: Insert puts the text in the field as an edit the page sees", fixed, await cwc.executeJavaScript("({ value: document.getElementById('body').value, inputs: window.__inputs })"));

    // "Write…" asks in the composer, then drafts into an empty rich-text editor.
    cwc.focus();
    await cwc.executeJavaScript("document.getElementById('rich').focus(); true");
    await ctx.assist.writeInField(win, compose, "custom");
    const asking = await poll(panel, "document.querySelector('.write-target') && document.querySelector('.composer textarea').placeholder.includes('write in the field')");
    await panel.executeJavaScript(
      "(() => { const t = document.querySelector('.composer textarea'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(t, 'Accept the invitation for Friday'); t.dispatchEvent(new Event('input', { bubbles: true })); })()",
    );
    await sleep(100);
    await panel.executeJavaScript("document.querySelector('.composer .send')?.click()");
    const drafted = await poll(panel, "[...document.querySelectorAll('.msg.write')].some((m) => m.innerText.includes('Thanks for the invitation') && !m.innerText.includes('\"Thanks'))");
    await panel.executeJavaScript("[...document.querySelectorAll('.msg.write')].at(-1).querySelector('.write-actions .primary')?.click()");
    const rich = await poll(cwc, "document.getElementById('rich').innerText.trim() === 'Thanks for the invitation, I will be there on Friday.'");
    check("write: “Write…” drafts from the composer's request into a rich-text field", asking && drafted && rich, {
      asking,
      drafted,
      rich: await cwc.executeJavaScript("document.getElementById('rich').innerText"),
    });

    // A password field is never read.
    cwc.focus();
    await cwc.executeJavaScript("document.getElementById('secret').focus(); true");
    const before = lastUserPrompt;
    await ctx.assist.writeInField(win, compose, "fix");
    const refused = await poll(panel, "[...document.querySelectorAll('.msg.write .error')].some((e) => e.textContent.includes('text field'))");
    check("write: a password field is never sent to the AI", refused && lastUserPrompt === before && !lastUserPrompt.includes("hunter2"), { refused });

    // "Compare tabs": pick two pages in the panel (one asleep), get a table with a column each.
    const phoneA = win.createTab(`${base}/phone-a`, { activate: true });
    const phoneB = win.createTab(`${base}/phone-b`, { activate: false });
    extraTabs.push(phoneA.id, phoneB.id);
    await poll(phoneA.view.webContents, "document.querySelector('h1')");
    await poll(phoneB.view.webContents, "document.querySelector('h1')");
    const asleep = win.sleepTab(phoneB.id);
    ctx.assist.clear(win);
    ctx.assist.openCompare(win, phoneA.id);
    const picking = await poll(panel, "document.querySelectorAll('.compare-picker .compare-item').length >= 2");
    await panel.executeJavaScript(
      "[...document.querySelectorAll('.compare-picker .compare-item')].find((l) => l.textContent.includes('Phone B'))?.querySelector('input')?.click()",
    );
    await panel.executeJavaScript(
      "(() => { const f = document.querySelector('.compare-focus'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(f, 'battery and price'); f.dispatchEvent(new Event('input', { bubbles: true })); })()",
    );
    await sleep(100);
    await panel.executeJavaScript("document.querySelector('.compare-picker .btn.primary')?.click()");
    const tabled = await poll(panel, "document.querySelectorAll('.compare-table thead .compare-page').length === 2 && document.querySelectorAll('.compare-table tbody tr').length === 2 && document.querySelector('.compare-verdict')", 12_000);
    const cells = (await panel.executeJavaScript("[...document.querySelectorAll('.compare-table tbody td')].map((td) => td.textContent)")) as string[];
    check("compare: two tabs (one asleep) become a table with a column each", picking && asleep && tabled && cells.join() === "5000 mAh,4000 mAh,199 €,149 €" && lastUserPrompt.includes("<request>battery and price</request>"), {
      picking,
      asleep,
      cells,
    });
    await capture("assist-compare", panel);
    clipboard.clear();
    await panel.executeJavaScript("[...document.querySelectorAll('.msg.compare .btn')].find((b) => b.textContent.includes('Copy table'))?.click()");
    await sleep(200);
    const copied = String(await clipboard.readText());
    check("compare: Copy table puts a Markdown table on the clipboard", copied.includes("| Battery | 5000 mAh | 4000 mAh |"), copied.slice(0, 200));
  } finally {
    nativeTheme.themeSource = themeBefore;
    ctx.assist.setTestProvider(undefined);
    ctx.assist.close(win);
    for (const id of extraTabs) win.closeTab(id);
    win.closeTab(pageTab.id);
    server.close();
    for (const close of closers) close();
  }
}

/** A throwaway self-signed certificate for `host` (openssl, as in the Docker image), or null. */
function selfSignedCert(host: string): { key: Buffer; cert: Buffer } | null {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "corvus-smoke-tls-"));
  const key = path.join(dir, "key.pem");
  const cert = path.join(dir, "cert.pem");
  const made = spawnSync(
    "openssl",
    ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "2", "-subj", `/CN=${host}`, "-addext", `subjectAltName=DNS:${host}`],
    { stdio: "ignore" },
  );
  return made.status === 0 ? { key: fs.readFileSync(key), cert: fs.readFileSync(cert) } : null;
}

/** A short, realistic agent run so the timeline and clients list have content. */
function seedTimeline(ctx: AppContext): void {
  const client = "claude-code";
  ctx.agents.clientConnected(client, true);
  const now = Date.now();
  const steps: Array<[string, unknown, number, number]> = [
    ["navigate", { url: "https://example.org/shop" }, 320, 180],
    ["page_snapshot", { maxChars: 2000 }, 140, 1820],
    ["click", { ref: "e12" }, 90, 0],
    ["type", { ref: "e7", text: "field notes" }, 60, 0],
    ["get_text", { maxChars: 4000 }, 110, 3600],
  ];
  let at = now - 9000;
  for (const [tool, args, durationMs, resultChars] of steps) {
    ctx.agents.toolCall({ client, tool, args, at });
    ctx.agents.toolResult({ client, tool, at, durationMs, ok: true, resultChars });
    at += 1600;
  }
  ctx.agents.toolCall({ client, tool: "get_html", args: { selector: "main" }, at });
}
