import http from "node:http";
import type { AddressInfo } from "node:net";
import { nativeTheme, type WebContents } from "electron";
import type { AnswerProvider, ProviderEvent } from "@corvus/ai-engine";
import type { ReaderTheme } from "../shared/reader-ipc";
import type { AppContext } from "./context";
import type { BrowserWindowCtl } from "./window";

/**
 * Reader-mode smoke (CORVUS_SMOKE_OUT): opens a local article, toggles reader mode, runs the
 * Key-points AI tool with a fake no-network provider, saves it to the reading library and opens
 * corvus://reading. Captures the reader in light/sepia/dark and the library page.
 */

interface Helpers {
  win: BrowserWindowCtl;
  check: (name: string, ok: boolean, detail?: unknown) => void;
  capture: (name: string, wc: WebContents) => Promise<void>;
}

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>The Common Raven — Field Notes</title></head>
<body>
<nav>Home · About · Contact — site navigation that must not appear in the reader</nav>
<article>
<h1>The Common Raven</h1>
<p>The common raven (Corvus corax) is a large all-black passerine bird, the most widely distributed of all corvids. It ranges across the whole of the Northern Hemisphere, from the hottest deserts to the high Arctic, a span few birds can match in the natural world.</p>
<p>For centuries ravens have appeared in myth and literature as clever, watchful companions, and modern research has borne that reputation out in careful experiments conducted around the world.</p>
<h2>Intelligence</h2>
<p>Ravens solve multi-step puzzles, fashion and use simple tools, and have been shown to plan for future events, a capacity once thought unique to great apes and humans. In the laboratory they trade tokens for food and clearly weigh a better reward that will arrive later.</p>
<h2>Behaviour</h2>
<p>Pairs cooperate to find and store food, play in flight and on the ground, and can mimic many sounds from their environment, including human speech. Young ravens form loose flocks before they settle into the lifelong territorial pairs that define the adult birds.</p>
</article>
<footer>Copyright notice and related links that the reader should drop entirely.</footer>
</body></html>`;

const KEY_POINTS = [
  "- The common raven is the most widely distributed of all corvids, found across the Northern Hemisphere [1]",
  "- Ravens solve multi-step puzzles, use tools and plan for the future [2]",
  "- Pairs cooperate to find food and can mimic sounds, including human speech [3]",
].join("\n");

const TLDR = "The common raven is a large, strikingly intelligent black bird found right across the Northern Hemisphere.";

function chunk(text: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += 20) out.push(text.slice(i, i + 20));
  return out;
}

function replyFor(system: string): string {
  if (/key points/i.test(system)) return KEY_POINTS;
  if (/TL;DR/i.test(system)) return TLDR;
  if (/plain, clear language/i.test(system)) return "In short: ravens are big, clever black birds that live almost everywhere.";
  return TLDR;
}

function fakeProvider(): AnswerProvider {
  return {
    kind: "anthropic-api",
    model: "claude-haiku-5-5",
    async *answer(req): AsyncGenerator<ProviderEvent> {
      const reply = replyFor(req.prompt.system);
      for (const part of chunk(reply)) {
        if (req.signal?.aborted) return;
        await new Promise((r) => setTimeout(r, 3));
        yield { type: "delta", text: part };
      }
      yield { type: "usage", inputTokens: 120, outputTokens: Math.ceil(reply.length / 3.4), model: "claude-haiku-5-5" };
    },
  };
}

async function poll(wc: WebContents, expr: string, timeoutMs = 8000): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if ((await wc.executeJavaScript(`Boolean(${expr})`).catch(() => false)) === true) return true;
    await new Promise((r) => setTimeout(r, 120));
  }
  return false;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function runReaderSmoke(ctx: AppContext, h: Helpers): Promise<void> {
  const { win, check, capture } = h;
  const themeBefore = nativeTheme.themeSource;
  const settingsBefore = ctx.settings.get().reader;
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(PAGE);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  ctx.assist.setTestProvider(fakeProvider());
  nativeTheme.themeSource = "light";
  const pageTab = win.createTab(`${base}/raven`, { activate: true });
  await poll(pageTab.view.webContents, "document.querySelector('h1')");
  await sleep(300);

  try {
    // Readerable detection surfaces the omnibox button.
    await ctx.reader.probe(win, pageTab);
    check("reader detects article", ctx.reader.isReaderable(pageTab));

    ctx.reader.toggle(win);
    const reader = ctx.reader.readerWebContents(win);
    check("reader view", Boolean(reader));
    if (!reader) return;
    const rendered = await poll(reader, "document.querySelector('.reader-content p') && document.querySelector('.reader-meta')");
    check("reader renders article", rendered, rendered ? undefined : await reader.executeJavaScript("document.querySelector('.reader-root')?.innerText?.slice(0,200)"));
    const clean = await reader.executeJavaScript("document.querySelector('.reader-content')?.innerText || ''");
    check("reader strips page chrome", String(clean).includes("Corvus corax") && !String(clean).includes("site navigation"), String(clean).slice(0, 120));

    // Key points tool.
    ctx.reader.tool(win, "key-points", "");
    const keyed = await poll(reader, "document.querySelectorAll('.msg ul.points li').length >= 3 && document.querySelector('.msg .cite')");
    check("reader key points", keyed, keyed ? undefined : await reader.executeJavaScript("document.querySelector('.strip-scroll')?.innerText?.slice(0,200)"));

    for (const theme of ["light", "sepia", "dark"] as const) {
      ctx.reader.setSettings(win, { theme });
      const applied = await poll(reader, `document.querySelector('.reader-root')?.getAttribute('data-theme') === ${JSON.stringify(theme)}`);
      check(`reader ${theme} theme`, applied);
      await sleep(150);
      await capture(`reader-${theme}`, reader);
    }
    ctx.reader.setSettings(win, { theme: settingsBefore.theme as ReaderTheme });

    // Save to the reading library.
    ctx.reader.save(win);
    await poll(reader, "/Saved/.test(document.querySelector('.reader-bar')?.innerText || '')");
    check("reader save to library", win.profile.reading.hasUrl(`${base}/raven`));

    const readingTab = win.createTab("corvus://reading/", { activate: true });
    const rwc = readingTab.view.webContents;
    const listed = await poll(rwc, "window.corvusInternal && document.querySelector('.list-row') && /Common Raven/.test(document.body.innerText)");
    check("corvus://reading lists the article", listed, listed ? undefined : await rwc.executeJavaScript("document.body?.innerText?.slice(0,200)"));
    const keptMd = win.profile.reading.get(win.profile.reading.list()[0]?.id ?? "")?.markdown ?? "";
    check("saved article keeps markdown + key points", keptMd.includes("Common Raven") && (win.profile.reading.list()[0]?.keyPoints.length ?? 0) >= 3);
    await sleep(200);
    await capture("reading-list", rwc);
    win.closeTab(readingTab.id);
  } finally {
    nativeTheme.themeSource = themeBefore;
    ctx.assist.setTestProvider(undefined);
    ctx.reader.close(win);
    win.closeTab(pageTab.id);
    server.close();
  }
}
