import http from "node:http";
import type { AddressInfo } from "node:net";
import { nativeTheme, type WebContents } from "electron";
import type { AnswerProvider, ProviderEvent } from "@corvus/ai-engine";
import type { OverlayEvent } from "../shared/assist-ipc";
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

const GROUPS = JSON.stringify({
  groups: [
    { name: "Corvid research", color: "green", tabs: [1, 2, 3] },
    { name: "Raven news", color: "blue", tabs: [4, 5] },
  ],
});

function replyFor(system: string): string {
  if (/Summarize the web page/.test(system)) return SUMMARY;
  if (/Group the user's numbered browser tabs/.test(system)) return GROUPS;
  if (/Answer the user's question/.test(system)) return ASK;
  return ASK;
}

function fakeProvider(): AnswerProvider {
  return {
    kind: "anthropic-api",
    model: "claude-haiku-5-5",
    async *answer(req): AsyncGenerator<ProviderEvent> {
      const reply = replyFor(req.prompt.system);
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
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(PAGE);
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
  } finally {
    nativeTheme.themeSource = themeBefore;
    ctx.assist.setTestProvider(undefined);
    ctx.assist.close(win);
    for (const id of extraTabs) win.closeTab(id);
    win.closeTab(pageTab.id);
    server.close();
  }
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
