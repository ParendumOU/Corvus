import fs from "node:fs";
import path from "node:path";
import { app, desktopCapturer, net, screen, type Session, type WebContents } from "electron";
import type { AgentModelProvider, AgentTurnRequest, AnswerProvider, ProviderEvent, TurnEvent } from "@corvus/ai-engine";
import type { AppContext } from "./context";
import type { BrowserWindowCtl, TabRuntime } from "./window";

/**
 * Marketing capture (CORVUS_CAPTURE=1, scripts/capture-marketing.sh): stages a dark browser window
 * on a fresh profile, serves the demo pages in capture/fixtures under realistic HTTPS URLs, drives
 * the real Command Bar agent and Assist panel with scripted no-network providers and saves each
 * scene as a full-window PNG (everything composited on screen: page, chrome UI, panels, overlay).
 * Never active otherwise.
 */

const STORE_URL = "https://raven-outfitters.shop/products/raven-travel-umbrella";
const ARTICLE_URL = "https://northbound.travel/guides/48-hours-in-bergen";
const DOCS_URL = "https://docs.fieldkit.dev/guides/quickstart";

/** Demo hosts and the fixture each path serves. Only these are intercepted; the rest goes out as usual. */
const SITES: Record<string, Record<string, string>> = {
  "raven-outfitters.shop": { "/products/raven-travel-umbrella": "store.html" },
  "northbound.travel": { "/guides/48-hours-in-bergen": "article.html" },
  "docs.fieldkit.dev": { "/guides/quickstart": "docs.html" },
};

const MODEL = "claude-haiku-5-5";

interface Preset {
  task: string;
  done: string;
  history: Array<{ task: string; url: string; result: string; hoursAgo: number }>;
}

const PRESETS: Record<string, Preset> = {
  en: {
    task: "Buy the Raven travel umbrella",
    done: "Done. I ordered the Raven Travel Umbrella in Midnight black for €39.00. Order RO-48213 arrives Tuesday; the confirmation is open in this tab.",
    history: [
      {
        task: "Turn the Bergen guide into a packing list",
        url: ARTICLE_URL,
        result: "Packing list for Bergen: a compact wind-proof umbrella, a light waterproof shell, merino layers, shoes with grip for wet cobbles and a warm layer for the fjord cruise.",
        hoursAgo: 26,
      },
      {
        task: "Find the Fieldkit CLI install command",
        url: DOCS_URL,
        result: "Install it with curl -fsSL https://get.fieldkit.dev | sh, then run fieldkit init in an empty folder.",
        hoursAgo: 3,
      },
    ],
  },
  es: {
    task: "Compra el paraguas de viaje Raven",
    done: "Listo. He pedido el paraguas de viaje Raven en negro medianoche por 39,00 €. El pedido RO-48213 llega el martes; la confirmación está abierta en esta pestaña.",
    history: [
      {
        task: "Haz una lista de equipaje con la guía de Bergen",
        url: ARTICLE_URL,
        result: "Lista para Bergen: paraguas compacto antiviento, chaqueta impermeable ligera, capas de merino, calzado con buen agarre para el empedrado mojado y una capa de abrigo para el crucero por el fiordo.",
        hoursAgo: 26,
      },
      {
        task: "Busca el comando para instalar la CLI de Fieldkit",
        url: DOCS_URL,
        result: "Instálala con curl -fsSL https://get.fieldkit.dev | sh y luego ejecuta fieldkit init en una carpeta vacía.",
        hoursAgo: 3,
      },
    ],
  },
  et: {
    task: "Osta Raven reisivihmavari",
    done: "Valmis. Tellisin Raven reisivihmavarju värvis kesköömust hinnaga 39,00 €. Tellimus RO-48213 saabub teisipäeval; kinnitus on avatud selles vahekaardis.",
    history: [
      {
        task: "Koosta Bergeni juhendi põhjal pakkimisnimekiri",
        url: ARTICLE_URL,
        result: "Bergeni pakkimisnimekiri: kompaktne tuulekindel vihmavari, kerge veekindel jope, meriinovillased kihid, märjal munakivil haarduvad jalanõud ja soe kiht fjordikruiisiks.",
        hoursAgo: 26,
      },
      {
        task: "Leia Fieldkiti CLI paigalduskäsk",
        url: DOCS_URL,
        result: "Paigalda see käsuga curl -fsSL https://get.fieldkit.dev | sh ja käivita seejärel tühjas kaustas fieldkit init.",
        hoursAgo: 3,
      },
    ],
  },
};

const SUMMARY = [
  "TLDR: A rain-proof weekend in Bergen: historic wharves and seafood on day one, mountain views and a fjord cruise on day two.",
  "- Start at Bryggen's UNESCO-listed wharf houses, then grab lunch at the harbour fish market [2]",
  "- Ride the Fløibanen funicular up Mount Fløyen for the classic view over the city [3]",
  "- On day two, take the three-hour Mostraumen cruise past waterfalls and narrow straits [4]",
  "- It rains on more than 200 days a year, so pack a compact umbrella and a light shell [5]",
].join("\n");

interface Frame {
  file: string;
  title: string;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function log(step: string, data?: unknown): void {
  console.log(`[capture] ${step}${data === undefined ? "" : `: ${JSON.stringify(data)}`}`);
}

async function until(cond: () => boolean, ms: number, what: string): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return;
    await sleep(60);
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function poll(wc: WebContents, expr: string, what: string, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if ((await wc.executeJavaScript(`Boolean(${expr})`).catch(() => false)) === true) return;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** Serves the fixture pages for the demo hosts on this profile's session, over the https scheme. */
function serveFixtures(ses: Session, dir: string): void {
  ses.protocol.handle("https", (request) => {
    const url = new URL(request.url);
    const pages = SITES[url.host];
    if (!pages) return net.fetch(request, { bypassCustomProtocolHandlers: true });
    const file = pages[url.pathname];
    if (!file) return new Response("Not found", { status: 404, headers: { "content-type": "text/plain" } });
    return new Response(fs.readFileSync(path.join(dir, file)), {
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
    });
  });
}

/** Finds an element ref by accessible name in the latest snapshot handed to the model. */
function refFor(messages: AgentTurnRequest["messages"], name: string): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    for (const block of messages[i]!.content) {
      if (block.type === "tool_result" && block.content.includes("elements:")) {
        const match = block.content.match(new RegExp(`(\\be\\d+)\\s+\\w+\\s+"${name}`));
        if (match) return match[1]!;
      }
    }
  }
  return "e1";
}

function issuedTurns(req: AgentTurnRequest): number {
  return req.messages.filter((m) => m.role === "assistant" && m.content.some((c) => c.type === "tool_use")).length;
}

/**
 * The hero run: open the product, read it, pick a colour, read again (held so the "working" frame
 * can be taken), click Buy now (gated by approval), read the confirmation and report back.
 */
function heroProvider(done: string, holdWorking: () => Promise<void>): AgentModelProvider {
  const usage = [
    [1640, 38],
    [2380, 22],
    [2460, 41],
    [2890, 24],
    [2950, 39],
    [3120, 26],
    [3310, 84],
  ] as const;
  return {
    kind: "anthropic-api",
    model: MODEL,
    async *streamTurn(req): AsyncGenerator<TurnEvent> {
      const n = issuedTurns(req);
      const [input, output] = usage[Math.min(n, usage.length - 1)]!;
      const tool = (name: string, args: unknown): TurnEvent => ({ type: "tool_use", id: `hero${n}`, name, input: args });
      await sleep(260);
      if (n === 0) yield tool("navigate", { url: STORE_URL });
      else if (n === 1) yield tool("page_snapshot", {});
      else if (n === 2) yield tool("click", { ref: refFor(req.messages, "Midnight black") });
      else if (n === 3) {
        yield tool("page_snapshot", {});
        await holdWorking();
      } else if (n === 4) yield tool("click", { ref: refFor(req.messages, "Buy now") });
      else if (n === 5) yield tool("page_snapshot", {});
      else {
        for (const word of done.split(/(?<= )/)) {
          yield { type: "text", text: word };
          await sleep(12);
        }
        yield { type: "usage", inputTokens: input, outputTokens: output, model: MODEL };
        yield { type: "end", stopReason: "end_turn" };
        return;
      }
      yield { type: "usage", inputTokens: input, outputTokens: output, model: MODEL };
      yield { type: "end", stopReason: "tool_use" };
    },
  };
}

/** A short earlier run for the history page: open a page, read it, answer. */
function historyProvider(url: string, result: string, size: number): AgentModelProvider {
  return {
    kind: "anthropic-api",
    model: MODEL,
    async *streamTurn(req): AsyncGenerator<TurnEvent> {
      const n = issuedTurns(req);
      if (n === 0) yield { type: "tool_use", id: "h0", name: "navigate", input: { url } };
      else if (n === 1) yield { type: "tool_use", id: "h1", name: "extract", input: {} };
      else {
        yield { type: "text", text: result };
        yield { type: "usage", inputTokens: Math.round(2210 * size), outputTokens: Math.round(result.length / 3.6), model: MODEL };
        yield { type: "end", stopReason: "end_turn" };
        return;
      }
      yield { type: "usage", inputTokens: Math.round((1480 + n * 760) * size), outputTokens: 28 + n * 9, model: MODEL };
      yield { type: "end", stopReason: "tool_use" };
    },
  };
}

const QUESTION = "Where should I go if it pours all day?";

const ANSWER =
  "Stay close to the harbour. The Hanseatic Museum on Bryggen [2] shows how merchants lived on the wharf, and the four KODE art museums by the city lake [4] hold a large Munch collection and stay open late on Thursdays.";

function answerProvider(): AnswerProvider {
  return {
    kind: "anthropic-api",
    model: MODEL,
    async *answer(req): AsyncGenerator<ProviderEvent> {
      const summary = /Summarize the web page/.test(req.prompt.system);
      const reply = summary ? SUMMARY : ANSWER;
      for (let i = 0; i < reply.length; i += 24) {
        if (req.signal?.aborted) return;
        await sleep(30);
        yield { type: "delta", text: reply.slice(i, i + 24) };
      }
      yield { type: "usage", inputTokens: summary ? 1914 : 2046, outputTokens: summary ? 142 : 61, model: MODEL };
    },
  };
}

class Recorder {
  readonly frames: Frame[] = [];

  constructor(
    private readonly win: BrowserWindowCtl,
    private readonly dir: string,
  ) {}

  /** Grabs the whole window as composited on screen. */
  async shot(file: string, title: string): Promise<void> {
    await sleep(350);
    const bounds = this.win.win.getBounds();
    const display = screen.getPrimaryDisplay();
    const scale = display.scaleFactor;
    const sources = await desktopCapturer.getSources({
      types: ["screen"],
      thumbnailSize: { width: Math.round(display.size.width * scale), height: Math.round(display.size.height * scale) },
    });
    const image = sources[0]?.thumbnail;
    if (!image || image.isEmpty()) throw new Error("screen capture returned no image");
    const png = image
      .crop({
        x: Math.round(bounds.x * scale),
        y: Math.round(bounds.y * scale),
        width: Math.round(bounds.width * scale),
        height: Math.round(bounds.height * scale),
      })
      .toPNG();
    fs.writeFileSync(path.join(this.dir, file), png);
    this.frames.push({ file, title });
    log("frame", { file, bytes: png.length });
  }
}

async function loaded(tab: TabRuntime): Promise<void> {
  await until(() => !tab.loading && tab.title !== tab.url && Boolean(tab.faviconUrl), 15_000, `load of ${tab.url}`);
}

async function overlayGone(ctx: AppContext, win: BrowserWindowCtl): Promise<void> {
  await until(() => !ctx.agents.overlayFor(win).visible, 6000, "agent overlay to hide");
  await sleep(350);
}

/** Two short earlier runs so the run history has more than the hero run; dated back a little. */
async function seedHistory(ctx: AppContext, win: BrowserWindowCtl, preset: Preset): Promise<void> {
  const runView = () => ctx.agentRunner.windowExtras(win).agentRun;
  for (const [i, item] of preset.history.entries()) {
    ctx.agentRunner.setTestProvider(historyProvider(item.url, item.result, 1.35 - i * 0.4));
    ctx.agentRunner.start(win, item.task);
    await until(() => runView()?.status === "done", 20_000, `history run "${item.task}"`);
    const view = runView()!;
    if (view.tabId) win.closeTab(view.tabId);
    ctx.agentRunner.clear(win);
    const stored = win.profile.agentRuns.get(view.id);
    if (stored) {
      const startedAt = Date.now() - item.hoursAgo * 3_600_000;
      win.profile.agentRuns.commit({ ...stored, startedAt, endedAt: startedAt + 14_000 });
    }
  }
  ctx.assist.close(win);
  // Those runs happened "earlier": no leftover overlay, timeline entries or live indicator.
  ctx.agents.overlayFor(win).hide();
  ctx.agents.clear();
  await sleep(4200);
  win.pushState();
}

export async function runMarketingCapture(ctx: AppContext): Promise<void> {
  const lang = process.env.CORVUS_CAPTURE_LANG && PRESETS[process.env.CORVUS_CAPTURE_LANG] ? process.env.CORVUS_CAPTURE_LANG : "en";
  const preset = { ...PRESETS[lang]! };
  if (process.env.CORVUS_CAPTURE_TASK) preset.task = process.env.CORVUS_CAPTURE_TASK;
  const outDir = path.resolve(process.env.CORVUS_CAPTURE_OUT ?? "out/marketing");
  const fixtures = path.resolve(process.env.CORVUS_CAPTURE_FIXTURES ?? path.resolve(process.cwd(), "capture/fixtures"));
  const width = Number(process.env.CORVUS_CAPTURE_WIDTH) || 1600;
  const height = Number(process.env.CORVUS_CAPTURE_HEIGHT) || 1000;
  fs.mkdirSync(outDir, { recursive: true });

  const win = ctx.windows.target();
  const rec = new Recorder(win, outDir);
  const chrome = win.chrome.webContents;
  const runView = () => ctx.agentRunner.windowExtras(win).agentRun;
  let failed = false;

  try {
    ctx.settings.update({ appearance: { theme: "dark", showBookmarksBar: false }, onboarding: { completed: true }, mcp: { enabled: true } });
    await ctx.mcp.apply();
    win.win.setBounds({ x: 0, y: 0, width, height });
    serveFixtures(win.profile.session, fixtures);
    ctx.assist.setTestProvider(answerProvider());

    const initial = win.tabIds();
    const store = win.createTab(STORE_URL, { activate: true });
    const article = win.createTab(ARTICLE_URL, { activate: false });
    const docs = win.createTab(DOCS_URL, { activate: false });
    for (const id of initial) win.closeTab(id);
    await Promise.all([loaded(store), loaded(article), loaded(docs)]);

    await seedHistory(ctx, win, preset);
    win.activate(store.id);
    win.focusContent();
    await sleep(800);
    await rec.shot("00-browser.png", "Corvus with the Raven Outfitters store open");

    // 1. Command bar with the task typed in agent mode.
    win.sendCommand({ type: "open-command-palette" });
    await poll(chrome, "document.querySelector('.cmdbar .cmd-input')", "command bar");
    chrome.focus();
    await chrome.executeJavaScript(
      `(() => {
        const input = document.querySelector('.cmdbar .cmd-input');
        input.focus();
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(`> ${preset.task}`)});
        input.dispatchEvent(new Event('input', { bubbles: true }));
      })()`,
    );
    await poll(chrome, "document.querySelector('.cmdbar .cmd-row.agent')", "agent row");
    await rec.shot("01-command-bar.png", "Command bar: ask Corvus to do a task");

    // 2. Run it from the bar (Enter), hold while the agent is mid-task with its cursor on the page.
    let reachedWorking: () => void = () => undefined;
    let releaseWorking: () => void = () => undefined;
    const working = new Promise<void>((resolve) => (reachedWorking = resolve));
    const released = new Promise<void>((resolve) => (releaseWorking = resolve));
    ctx.agentRunner.setTestProvider(
      heroProvider(preset.done, async () => {
        reachedWorking();
        await released;
      }),
    );
    win.pushState();
    await sleep(150);
    await chrome.executeJavaScript(
      "document.querySelector('.cmdbar .cmd-input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))",
    );
    await Promise.race([working, sleep(30_000).then(() => Promise.reject(new Error("hero run never reached the working step")))]);
    await poll(chrome, "document.querySelectorAll('.cmdbar .run-panel .run-steps .step').length >= 4", "run steps");
    await rec.shot("02-agent-working.png", "The agent at work, with its cursor on the page");
    releaseWorking();

    // 3. The risky click waits for the user's OK.
    await until(() => runView()?.status === "awaiting-approval", 20_000, "approval request");
    await poll(chrome, "document.querySelector('.cmdbar .run-panel .run-approval .appr-actions .btn')", "approval card");
    await overlayGone(ctx, win);
    await rec.shot("03-needs-approval.png", "Risky actions wait for your OK");

    // 4. Approved: the order goes through and the run reports back.
    ctx.agentRunner.approve(win, "approve");
    await until(() => runView()?.status === "done", 30_000, "run to finish");
    await poll(chrome, "document.querySelector('.cmdbar .run-panel .run-chip.done') && document.querySelector('.cmdbar .run-panel .step.msg')", "done state");
    await overlayGone(ctx, win);
    await rec.shot("04-done.png", "Done, with a summary of what the agent did");

    const agentTab = runView()?.tabId;
    win.sendCommand({ type: "close-overlays" });
    ctx.agentRunner.clear(win);
    ctx.agentRunner.setTestProvider(undefined);
    if (agentTab) win.closeTab(agentTab);
    ctx.assist.close(win);

    // 5. Assist summarizes the article with section citations.
    win.activate(article.id);
    win.focusContent();
    ctx.assist.open(win, "assist");
    const panel = ctx.assist.panelWebContents(win);
    if (!panel) throw new Error("no Assist panel");
    await poll(panel, "document.querySelector('.composer textarea')", "Assist panel");
    ctx.assist.activeAction(win, "summarize");
    await poll(panel, "document.querySelectorAll('.msg.summary .points li').length >= 4 && document.querySelector('.msg.summary .usage')", "summary", 15_000);
    ctx.assist.activeAction(win, "ask", QUESTION);
    await poll(panel, "[...document.querySelectorAll('.msg.ask')].some((m) => m.querySelector('.usage') && m.querySelectorAll('.cite').length >= 2)", "answer", 15_000);
    await panel.executeJavaScript("document.activeElement?.blur()");
    await rec.shot("05-assist.png", "Assist summarizes the page and answers questions, with citations");
    ctx.assist.close(win);

    // 6. Split view: the guide next to the shop.
    win.enterSplit(article.id, store.id);
    await sleep(700);
    await rec.shot("06-split-view.png", "Split view: two tabs side by side");
    win.exitSplit();

    // 7. Run history.
    const runsTab = win.createTab("corvus://agent-runs/", { activate: true });
    const runs = runsTab.view.webContents;
    await poll(runs, "document.querySelectorAll('.ar-run').length >= 3", "agent runs list");
    await runs.executeJavaScript("document.querySelector('.ar-run .ar-steps-toggle')?.click(); document.activeElement?.blur()");
    await poll(runs, "document.querySelector('.ar-run .ar-steps')", "expanded run");
    // The virtual display's pointer rests mid-screen; park it on empty space so no row shows hover.
    const pageBounds = runsTab.view.getBounds();
    runs.sendInputEvent({ type: "mouseMove", x: pageBounds.width - 40, y: pageBounds.height - 40 });
    await rec.shot("07-agent-runs.png", "Every agent run, reviewable afterwards");
  } catch (err) {
    failed = true;
    log("error", (err as Error).stack ?? String(err));
  } finally {
    const manifest = {
      product: "Corvus",
      lang,
      task: preset.task,
      size: { width, height, scale: screen.getPrimaryDisplay().scaleFactor },
      frames: rec.frames,
    };
    fs.writeFileSync(path.join(outDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    log("RESULT", failed ? "FAILED" : "OK");
    app.exit(failed ? 1 : 0);
  }
}
