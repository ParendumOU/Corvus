import { nativeTheme, type WebContents } from "electron";
import type { SearchCategory, SearchResult } from "@corvus/shared";
import type { AppContext } from "./context";
import type { BrowserWindowCtl } from "./window";

/**
 * Search page smoke: a fake retriever and a fake structured provider (no network, no API key)
 * drive corvus://search through every tab in light and dark, with screenshots.
 */

interface Helpers {
  win: BrowserWindowCtl;
  check: (name: string, ok: boolean, detail?: unknown) => void;
  capture: (name: string, wc: WebContents) => Promise<void>;
}

const QUERY = "common raven";

function hash(text: string): number {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function svgUrl(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/** Abstract landscape placeholder (sky gradient, sun, ridge) in a seeded palette. */
function picture(seed: string, w: number, h: number): string {
  const n = hash(seed);
  const hue = n % 360;
  const sun = { x: 20 + (n % 60), y: 18 + (n % 25), r: 8 + (n % 9) };
  const ridge = 55 + (n % 20);
  return svgUrl(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 100 ${Math.round((100 * h) / w)}" preserveAspectRatio="xMidYMid slice">` +
      `<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="hsl(${hue},45%,72%)"/><stop offset="1" stop-color="hsl(${(hue + 40) % 360},40%,38%)"/></linearGradient></defs>` +
      `<rect width="100" height="200" fill="url(#g)"/>` +
      `<circle cx="${sun.x}" cy="${sun.y}" r="${sun.r}" fill="hsl(${(hue + 180) % 360},70%,86%)" opacity=".85"/>` +
      `<path d="M0 ${ridge} L18 ${ridge - 12} L34 ${ridge - 4} L52 ${ridge - 20} L70 ${ridge - 6} L86 ${ridge - 14} L100 ${ridge - 8} L100 200 L0 200 Z" fill="hsl(${(hue + 200) % 360},25%,18%)" opacity=".8"/>` +
      `<path d="M38 ${ridge - 26} q4 -3 8 0 q4 -3 8 0" stroke="#111" stroke-width="1.2" fill="none"/>` +
      `</svg>`,
  );
}

function favicon(domain: string): string {
  const hue = hash(domain) % 360;
  const letter = (domain[0] ?? "?").toUpperCase();
  return svgUrl(
    `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" rx="7" fill="hsl(${hue},55%,45%)"/>` +
      `<text x="16" y="22" font-family="sans-serif" font-size="18" font-weight="700" fill="#fff" text-anchor="middle">${letter}</text></svg>`,
  );
}

function result(rank: number, url: string, title: string, snippet: string, extra: Partial<SearchResult> = {}): SearchResult {
  return { url, title, snippet, source: new URL(url).hostname.replace(/^www\./, ""), rank, ...extra };
}

const GENERAL: SearchResult[] = [
  result(1, "https://en.wikipedia.org/wiki/Common_raven", "Common raven - Wikipedia", "The common raven (Corvus corax) is a large all-black passerine bird. It is the most widely distributed of all corvids, found across the Northern Hemisphere."),
  result(2, "https://www.reddit.com/r/corvids/comments/raven_vs_crow", "How do you tell a raven from a crow? : r/corvids", "Ravens are bigger, have a wedge-shaped tail in flight and a deep croaking call. Crows have a fan-shaped tail and caw. Ravens also soar more often."),
  result(3, "https://www.allaboutbirds.org/guide/Common_Raven/overview", "Common Raven Overview, All About Birds, Cornell Lab of Ornithology", "Not just a big crow, the Common Raven is an acrobatic flier, often seen soaring, tumbling and playing in the air. Ravens are among the smartest of birds."),
  result(4, "https://www.youtube.com/watch?v=raven-puzzle", "Raven solves an eight-step puzzle (video)", "Watch a captive raven work through a multi-step puzzle box to reach a food reward, filmed at a corvid research lab."),
  result(5, "https://www.audubon.org/field-guide/bird/common-raven", "Common Raven | Audubon Field Guide", "Larger than a Red-tailed Hawk, the raven thrives in deserts, mountains and northern forests. Range, habitat, feeding and nesting notes."),
  result(6, "https://birdblog.example.net/2009/ravens-and-crows", "Ravens and crows, my notes from 2009", "Some old observations from my backyard about ravens and crows, and why I think they are the same species with a size difference."),
  result(7, "https://www.nationalgeographic.com/animals/birds/facts/common-raven", "Common Raven | National Geographic", "Ravens have been observed in pairs teaming up to steal food, and they can mimic sounds from their environment, including human speech."),
  result(8, "https://www.britannica.com/animal/common-raven", "Common raven | Bird, Description, & Facts | Britannica", "Common raven, largest member of the crow family, with a wingspan of up to 1.3 metres. It is found throughout the Northern Hemisphere."),
];

const NEWS_ITEMS: Array<[string, string, string, string]> = [
  ["https://www.nytimes.com/2026/10/18/science/ravens-planning.html", "Ravens plan for the future as well as great apes, study finds", "13 hours ago", "The New York Times"],
  ["https://www.theguardian.com/environment/2026/oct/17/ravens-return-london", "Ravens return to nest in London for the first time in 150 years", "1 day ago", "The Guardian"],
  ["https://www.nationalgeographic.com/animals/article/raven-wolves-yellowstone", "In Yellowstone, ravens follow wolves to their next meal", "2 days ago", "National Geographic"],
  ["https://www.bbc.com/news/science-environment-raven-tower", "The Tower of London welcomes two new raven chicks", "3 days ago", "BBC News"],
  ["https://www.scientificamerican.com/article/corvid-cognition-2026", "What corvid brains reveal about intelligence", "4 days ago", "Scientific American"],
  ["https://apnews.com/article/raven-rescue-alaska", "Alaska wildlife center releases rehabilitated raven", "6 days ago", "AP News"],
];

const IMAGE_SIZES: Array<[number, number]> = [
  [1600, 1067], [900, 1200], [1200, 1200], [1920, 1080], [1000, 1400], [1400, 933], [1200, 800], [800, 1000],
  [1600, 900], [1100, 1100], [1300, 866], [900, 1350], [1500, 1000], [1200, 900], [1000, 750], [1400, 1050],
];

const IMAGE_SITES = ["wikimedia.org", "allaboutbirds.org", "flickr.com", "audubon.org", "britannica.com", "pexels.com", "unsplash.com", "nps.gov"];

const VIDEOS: Array<[string, string, string, string, string]> = [
  ["https://www.youtube.com/watch?v=raven-1", "Ravens: the smartest birds in the world?", "12:04", "Nature Lab", "2 weeks ago"],
  ["https://www.youtube.com/watch?v=raven-2", "Raven solves an eight-step puzzle", "4:31", "Corvid Research", "1 month ago"],
  ["https://vimeo.com/raven-3", "A year with a family of ravens", "28:15", "Field Notes Films", "3 months ago"],
  ["https://www.youtube.com/watch?v=raven-4", "Raven vs crow: how to tell them apart", "6:48", "Birding Basics", "5 months ago"],
  ["https://www.dailymotion.com/video/raven-5", "Ravens talking: mimicry recorded in the wild", "3:12", "WildSound", "8 months ago"],
  ["https://www.youtube.com/watch?v=raven-6", "Why ravens play in the snow", "8:56", "Nature Lab", "1 year ago"],
];

function vertical(category: SearchCategory): SearchResult[] {
  if (category === "news") {
    return NEWS_ITEMS.map(([url, title, age, publisher], i) =>
      result(i + 1, url, title, "Researchers and wildlife officials describe new observations of raven behavior, from planning and tool use to social play.", {
        age,
        publisher,
        thumbnail: picture(url, 320, 200),
      }),
    );
  }
  if (category === "images") {
    return IMAGE_SIZES.map(([w, h], i) => {
      const site = IMAGE_SITES[i % IMAGE_SITES.length]!;
      const src = picture(`img${i}`, Math.round(w / 4), Math.round(h / 4));
      return result(i + 1, `https://${site}/raven/${i}`, `Common raven photo ${i + 1}`, "", {
        image: { src, width: w, height: h, format: "jpeg" },
        thumbnail: src,
      });
    });
  }
  if (category === "videos") {
    return VIDEOS.map(([url, title, duration, publisher, age], i) =>
      result(i + 1, url, title, "A short documentary segment on raven behavior and intelligence.", { duration, publisher, age, thumbnail: picture(url, 320, 180) }),
    );
  }
  return GENERAL;
}

const STRUCTURED_REPLY = [
  "The common raven (Corvus corax) is the largest all-black songbird, found across the Northern Hemisphere and known for its intelligence and playful flight [1][3].",
  "It is bigger than a crow, with a wedge-shaped tail and a deep croaking call [2][5].",
  "P: Wingspan reaches about 1.3 m, making it the largest member of the crow family [8]",
  "P: Ravens solve multi-step puzzles and plan ahead for future rewards [3][4]",
  "P: Pairs cooperate to steal food and can mimic sounds, including human speech [7]",
  "P: They live in deserts, mountains and northern forests and often follow wolves [5]",
  "C: high",
  "D: One older blog claims ravens and crows are the same species; field guides disagree",
  "R: 1|9|reference|Comprehensive encyclopedia entry covering taxonomy, range, behavior and the raven in culture",
  "R: 2|6|forum|Community thread with practical tips for telling ravens and crows apart in the field",
  "R: 3|10|official,reference|Cornell Lab species guide with identification, sounds, range map and behavior notes",
  "R: 4|7|video|Lab footage of a raven solving an eight-step puzzle box for food",
  "R: 5|8|reference|Audubon field guide entry on range, habitat, feeding and nesting",
  "R: 6|2|opinion,outdated|Personal 2009 blog notes; wrongly claims ravens and crows are one species",
  "R: 7|7|news|Magazine overview of raven intelligence, cooperation and vocal mimicry",
  "R: 8|8|reference|Short encyclopedia article with size, distribution and diet facts",
  "E: Common raven|Large black passerine bird of the crow family, Corvus corax",
  "F: Scientific name|Corvus corax",
  "F: Wingspan|Up to 1.3 m",
  "F: Lifespan|10-15 years in the wild",
  "F: Range|Northern Hemisphere",
  "F: Diet|Omnivore and scavenger",
  "Q: How smart are ravens compared to crows?",
  "Q: Raven vs crow identification",
  "Q: Do ravens mate for life?",
].join("\n");

function fakeRetriever() {
  return {
    kind: "searxng" as const,
    categories: ["news", "images", "videos"] as const,
    async search(_query: string, opts: { category?: SearchCategory; maxResults: number }) {
      await new Promise((r) => setTimeout(r, 150));
      return vertical(opts.category ?? "general").slice(0, Math.max(opts.maxResults, 8));
    },
  };
}

/** The part of the reply each call writes: the rating call (its prompt asks for R: lines) the per-source records. */
function replyFor(system: string): string {
  const rating = system.includes("R: n|");
  return STRUCTURED_REPLY.split("\n")
    .filter((line) => /^[REFQ]: /.test(line) === rating)
    .join("\n");
}

/** The user messages the fake provider was asked to answer, newest last. */
const prompts: string[] = [];

function fakeProvider(chunkMs = 6, onChunk?: () => void) {
  return {
    kind: "anthropic-api" as const,
    model: "claude-haiku-5-5",
    async *answer(req: { prompt: { system: string; user: string }; signal?: AbortSignal }) {
      prompts.push(req.prompt.user);
      const reply = replyFor(req.prompt.system);
      for (let i = 0; i < reply.length; i += 14) {
        if (req.signal?.aborted) return;
        await new Promise((r) => setTimeout(r, chunkMs));
        onChunk?.();
        yield { type: "delta" as const, text: reply.slice(i, i + 14) };
      }
      const input = Math.ceil((req.prompt.system.length + req.prompt.user.length) / 3);
      yield { type: "usage" as const, inputTokens: input, outputTokens: Math.ceil(reply.length / 3.4), model: "claude-haiku-5-5" };
    },
  };
}

/**
 * The fake retriever and provider, for other smoke checks that need an AI search answer (`chunkMs`
 * between pieces of it; `onChunk` hears each piece the provider writes).
 */
export function fakeSearchDeps(chunkMs?: number, onChunk?: () => void): { engine: unknown } {
  return { engine: { retrievers: [fakeRetriever()], provider: fakeProvider(chunkMs, onChunk) } };
}

async function waitFor(wc: WebContents, expression: string, timeoutMs = 10_000): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if ((await wc.executeJavaScript(`Boolean(${expression})`).catch(() => false)) === true) return true;
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

function pageUrl(category: SearchCategory): string {
  return `corvus://search/?q=${encodeURIComponent(QUERY)}${category === "general" ? "" : `&cat=${category}`}`;
}

/**
 * In the page: watch layout shifts, every answer text and AI note ever shown, and when each part
 * appears, from now until `window.__layout.stop`.
 */
const WATCH_LAYOUT = `(() => {
  const w = { since: performance.now(), shift: 0, shifts: [], answers: [], notes: {}, at: {}, stop: false };
  window.__layout = w;
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) {
      if (e.startTime < w.since || e.hadRecentInput) continue;
      w.shift += e.value;
      if (w.shifts.length < 12) w.shifts.push({ ms: Math.round(e.startTime - w.since), value: +e.value.toFixed(4), nodes: (e.sources || []).map((s) => s.node && (s.node.className || s.node.nodeName)).slice(0, 3) });
    }
  }).observe({ type: "layout-shift", buffered: true });
  const mark = (key, seen) => { if (seen && w.at[key] === undefined) w.at[key] = Math.round(performance.now() - w.since); };
  const sample = () => {
    if (w.stop) return;
    const answer = (document.querySelector(".turn .answer-text")?.textContent ?? "").trim();
    if (answer && !w.answers.includes(answer)) w.answers.push(answer);
    for (const li of document.querySelectorAll(".sources .source")) {
      const text = (li.querySelector(".source-ai-text")?.textContent ?? "").trim();
      const seen = (w.notes[li.dataset.rank] ??= []);
      if (text && !seen.includes(text)) seen.push(text);
    }
    mark("text", answer);
    mark("answer", document.querySelector(".turn.read"));
    mark("ratings", document.querySelector(".source-rail[data-score]"));
    mark("settled", document.querySelector(".turn.settled"));
    requestAnimationFrame(sample);
  };
  requestAnimationFrame(sample);
  return true;
})()`;

/** Position of every source title within the sources pane, and each row's height. */
const LAYOUT = `(() => {
  const pane = document.querySelector(".sources-pane");
  const top = pane ? pane.getBoundingClientRect().top - pane.scrollTop : 0;
  const rows = [...document.querySelectorAll(".sources .source")];
  return {
    titles: Object.fromEntries(rows.map((r) => [r.querySelector(".source-title")?.href, Math.round(r.getBoundingClientRect().top - top)])),
    heights: [...new Set(rows.map((r) => Math.round(r.getBoundingClientRect().height)))],
  };
})()`;

interface Layout {
  titles: Record<string, number>;
  heights: number[];
}

/**
 * A live search with a slow AI answer (about 4 s): titles, domains and snippets come at once
 * without waiting for the AI; the answer then appears a whole sentence at a time, the ratings and
 * AI notes fill lines kept for them, and nothing in the sources pane moves. Pointing at a citation
 * lights its source and the other way round, and a follow-up is answered in the conversation.
 */
async function checkStableWhileLoading(ctx: AppContext, h: Helpers, tabId: string, wc: WebContents): Promise<void> {
  const { win, check, capture } = h;
  ctx.search.setTestDeps({ engine: { retrievers: [fakeRetriever()], provider: fakeProvider(30) }, favicon: async (domain) => favicon(domain) });
  // A query of its own, so the answer is not replayed from the cache.
  win.loadUrl(tabId, `corvus://search/?q=${encodeURIComponent(`${QUERY} layout ${Date.now()}`)}`);
  const shown = await waitFor(wc, "document.querySelectorAll('.sources .source-title').length === 8");
  await wc.executeJavaScript(WATCH_LAYOUT);
  const first = (await wc.executeJavaScript(`(() => ({
    writing: !document.querySelector(".turn.read"),
    titles: [...document.querySelectorAll(".sources .source")].every((r) => r.querySelector(".source-title")?.textContent.trim() && r.querySelector(".source-domain")?.textContent.trim()),
    snippets: [...document.querySelectorAll(".sources .source-snippet")].filter((el) => el.textContent.trim()).length,
    notes: [...document.querySelectorAll(".sources .source-ai-text")].filter((el) => el.textContent.trim()).length,
    found: document.querySelector(".steps .step.done")?.textContent ?? "",
  }))()`)) as { writing: boolean; titles: boolean; snippets: number; notes: number; found: string };
  check(
    "search: titles, domains and snippets come at once, and the steps say the results are in",
    shown && first.writing && first.titles && first.snippets === 8 && first.notes === 0 && /8/.test(first.found),
    first,
  );
  const before = (await wc.executeJavaScript(LAYOUT)) as Layout;
  await capture("search-loading", wc);
  await new Promise((r) => setTimeout(r, 1200));
  await capture("search-loading-later", wc);
  const settled = await waitFor(wc, "document.querySelector('.turn.settled') && document.querySelectorAll('.source-rail[data-score]').length === 8 && document.querySelector('.turn-entity')", 20_000);
  await new Promise((r) => setTimeout(r, 400));
  const watched = (await wc.executeJavaScript("(() => { window.__layout.stop = true; const { shift, shifts, answers, notes, at } = window.__layout; return { shift: +shift.toFixed(4), shifts, answers, notes, at }; })()")) as {
    shift: number;
    shifts: unknown[];
    answers: string[];
    notes: Record<string, string[]>;
    at: { text?: number; answer?: number; ratings?: number; settled?: number };
  };
  const after = (await wc.executeJavaScript(LAYOUT)) as Layout;
  const moved = Object.entries(before.titles)
    .map(([href, top]) => ({ href, by: (after.titles[href] ?? Number.NaN) - top }))
    .filter((t) => !(Math.abs(t.by) < 1));
  // The answer grows a whole sentence at a time: every text seen ends a sentence and starts the
  // final one; each AI note is only ever seen whole.
  const final = watched.answers.at(-1) ?? "";
  const broken = watched.answers.filter((a) => !final.startsWith(a) || !/[.!?。！？]$/.test(a));
  const rewritten = Object.entries(watched.notes).filter(([, seen]) => seen.length > 1);
  check(
    "search: the answer appears a whole sentence at a time, the AI notes whole",
    settled && watched.answers.length >= 2 && broken.length === 0 && rewritten.length === 0,
    { answers: watched.answers.length, broken, rewritten },
  );
  const { text: textAt, answer: answerAt, ratings: ratingsAt, settled: settledAt } = watched.at;
  check(
    "search: the first sentences come before the answer part is complete, then the ratings, then the rest",
    textAt !== undefined && answerAt !== undefined && ratingsAt !== undefined && settledAt !== undefined && textAt < answerAt && answerAt < ratingsAt && ratingsAt <= settledAt,
    watched.at,
  );
  check(
    "search: nothing in the sources moves while the answer, ratings and notes arrive; every row has one height",
    settled && watched.shift < 0.001 && moved.length === 0 && after.heights.length === 1 && before.heights.join() === after.heights.join(),
    { shift: watched.shift, shifts: watched.shifts, moved, heights: [before.heights, after.heights] },
  );
  const filled = (await wc.executeJavaScript(`({
    notes: [...document.querySelectorAll(".sources .source-ai-text")].filter((el) => el.textContent.trim()).length,
    first: document.querySelector(".source")?.dataset.rank,
  })`)) as { notes: number; first?: string };
  check("search: AI notes fill in, results keep the order they were shown in", filled.notes === 8 && filled.first === "1", filled);
  await capture("search-settled", wc);

  // Pointing at a citation lights its source, and pointing at a source lights its citations.
  const linked = (await wc.executeJavaScript(`(async () => {
    const cite = document.querySelector(".turn.active .answer-text .cite:not(.dead)");
    const n = Number(cite?.textContent);
    cite?.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 120));
    const source = document.querySelector(".source.lit")?.dataset.rank;
    cite?.dispatchEvent(new MouseEvent("mouseout", { bubbles: true }));
    const row = document.querySelector('.source[data-rank="3"]');
    row?.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 120));
    const cites = [...document.querySelectorAll(".turn.active .cite.lit")].map((c) => c.textContent);
    row?.dispatchEvent(new MouseEvent("mouseout", { bubbles: true }));
    return { n, source, cites };
  })()`)) as { n: number; source?: string; cites: string[] };
  check("search: a citation and its source light each other up", String(linked.n) === linked.source && linked.cites.length > 0 && linked.cites.every((c) => c === "3"), linked);

  // Only the person's own clicks reorder: the AI order is one click away.
  await wc.executeJavaScript("document.querySelector('.sort-toggle button[data-sort=ai]').click()");
  await new Promise((r) => setTimeout(r, 400));
  const sorted = await wc.executeJavaScript("document.querySelector('.source')?.dataset.rank");
  check("search: Sort AI relevance re-ranks on click", sorted === "3", sorted);

  // A suggested question is asked in the conversation, in the context of the first.
  prompts.length = 0;
  await wc.executeJavaScript("document.querySelector('.next button')?.click()");
  const followed = await waitFor(wc, "document.querySelectorAll('.turn').length === 2 && document.querySelector('.turn:last-of-type.settled')", 20_000);
  const conversation = (await wc.executeJavaScript(`({
    turns: document.querySelectorAll(".turn").length,
    active: document.querySelector(".turn.active") === document.querySelector(".turn:last-of-type"),
    sources: document.querySelectorAll(".sources .source").length,
  })`)) as { turns: number; active: boolean; sources: number };
  check(
    "search: a follow-up is answered below the first, in its context, with its own sources",
    followed && conversation.turns === 2 && conversation.active && conversation.sources === 8 && prompts.some((p) => p.includes("<conversation>")),
    { ...conversation, withContext: prompts.filter((p) => p.includes("<conversation>")).length },
  );
  await capture("search-follow-up", wc);
  ctx.search.setTestDeps({ engine: { retrievers: [fakeRetriever()], provider: fakeProvider() }, favicon: async (domain) => favicon(domain) });
}

export async function runSearchSmoke(ctx: AppContext, h: Helpers): Promise<void> {
  const { win, check, capture } = h;
  const themeBefore = nativeTheme.themeSource;
  ctx.search.setTestDeps({
    engine: { retrievers: [fakeRetriever()], provider: fakeProvider() },
    favicon: async (domain) => favicon(domain),
  });
  const tab = win.createTab(pageUrl("general"));
  const wc = tab.view.webContents;
  try {
    for (const theme of ["light", "dark"] as const) {
      nativeTheme.themeSource = theme;
      for (const category of ["general", "news", "images", "videos"] as const) {
        win.loadUrl(tab.id, pageUrl(category));
        await new Promise((r) => setTimeout(r, 400));
        const name = category === "general" ? "all" : category;
        const ready =
          category === "general"
            ? "document.querySelector('.turn.settled') && document.querySelectorAll('.source-rail[data-score]').length === 8 && document.querySelector('.turn-entity') && document.querySelectorAll('.next button').length === 3 && document.querySelector('.turn-usage')"
            : category === "images"
              ? "document.querySelectorAll('.image-tile > img').length >= 12"
              : `document.querySelectorAll('.${category === "news" ? "news-item" : "video-card"}').length >= 5`;
        const ok = await waitFor(wc, ready);
        check(`search ${name} tab (${theme})`, ok, ok ? undefined : await wc.executeJavaScript("document.body.innerText.slice(0, 400)"));
        await waitFor(wc, "[...document.images].every((i) => i.complete)", 3000);
        await new Promise((r) => setTimeout(r, 450));
        await capture(`search-${name}-${theme}`, wc);
        if (category === "images") {
          // The caption's favicon arrives after the photos and must stay small, never cover the photo.
          const tiles = (await wc.executeJavaScript(`(() => {
            const tiles = [...document.querySelectorAll('.image-tile')].filter((t) => t.getBoundingClientRect().bottom < innerHeight);
            const favs = [...document.querySelectorAll('.image-cap .fav')].map((f) => Math.round(f.getBoundingClientRect().width));
            const covered = tiles.filter((t) => {
              const r = t.getBoundingClientRect();
              const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 3);
              return hit !== t.querySelector(':scope > img');
            }).length;
            return { tiles: tiles.length, favs: favs.length, widest: Math.max(0, ...favs), covered };
          })()`)) as { tiles: number; favs: number; widest: number; covered: number };
          check(`search images: favicons stay small, photos stay visible (${theme})`, tiles.favs > 0 && tiles.widest <= 16 && tiles.tiles > 0 && tiles.covered === 0, tiles);
        }
      }
    }

    nativeTheme.themeSource = "light";
    win.loadUrl(tab.id, pageUrl("general"));
    await new Promise((r) => setTimeout(r, 400));
    await waitFor(wc, "document.querySelector('.turn.settled') && document.querySelectorAll('.source-rail[data-score]').length === 8");
    const firstAi = await wc.executeJavaScript("document.querySelector('.source')?.dataset.rank");
    // A cached search replays at once, so it opens in the saved (AI) order.
    check("search: a cached search opens in AI order", firstAi === "3", firstAi);
    const structure = await wc.executeJavaScript(`({
      points: document.querySelectorAll('.key-points li').length,
      chips: document.querySelectorAll('.turn .answer-text .cite').length,
      tags: document.querySelectorAll('.source .tag').length,
      notes: document.querySelectorAll('.source .source-ai-text').length,
      confidence: document.querySelector('.turn .confidence')?.textContent ?? '',
      disagree: Boolean(document.querySelector('.turn .disagree')),
      facts: document.querySelectorAll('.turn-entity dt').length,
      steps: [...document.querySelectorAll('.steps .step.done')].length,
      live: document.querySelector('.turn-answer')?.getAttribute('aria-live'),
    })`);
    check(
      "search structured sections",
      structure.points === 4 && structure.chips >= 3 && structure.tags >= 8 && structure.notes === 8 && /high/i.test(structure.confidence) && structure.disagree && structure.facts === 5 && structure.steps === 3 && structure.live === "polite",
      structure,
    );
    await wc.executeJavaScript("document.querySelector('.sort-toggle button[data-sort=original]').click()");
    await new Promise((r) => setTimeout(r, 300));
    const firstOriginal = await wc.executeJavaScript("document.querySelector('.source')?.dataset.rank");
    check("search sort toggle: original order", firstOriginal === "1", firstOriginal);
    await wc.executeJavaScript("document.querySelector('.sort-toggle button[data-sort=ai]').click()");

    wc.focus();
    await wc.executeJavaScript("document.activeElement?.blur()");
    for (const key of ["j", "j"]) {
      wc.sendInputEvent({ type: "keyDown", keyCode: key });
      wc.sendInputEvent({ type: "char", keyCode: key });
      wc.sendInputEvent({ type: "keyUp", keyCode: key });
      await new Promise((r) => setTimeout(r, 100));
    }
    const focused = await wc.executeJavaScript("document.activeElement?.closest('.source')?.dataset.rank ?? document.activeElement?.tagName");
    check("search keyboard j/k navigation", focused === "1", focused);
    wc.sendInputEvent({ type: "keyDown", keyCode: "/" });
    wc.sendInputEvent({ type: "char", keyCode: "/" });
    wc.sendInputEvent({ type: "keyUp", keyCode: "/" });
    await new Promise((r) => setTimeout(r, 100));
    const inputFocused = await wc.executeJavaScript("document.activeElement?.id === 'search-input' && document.activeElement.value === " + JSON.stringify(QUERY));
    check("search / focuses the search box", inputFocused === true, inputFocused);

    await checkStableWhileLoading(ctx, { win, check, capture }, tab.id, wc);

    win.loadUrl(tab.id, "corvus://search/?q=common%20raven&narrow=1");
    tab.view.setBounds({ ...tab.view.getBounds(), width: 560 });
    await waitFor(wc, "document.querySelector('.turn.settled') && document.querySelector('.turn-entity')");
    await new Promise((r) => setTimeout(r, 400));
    // Too narrow for two panes: one at a time, switched with Answer / Sources.
    const narrow = (await wc.executeJavaScript(`(async () => {
      const visible = (sel) => Boolean(document.querySelector(sel)?.getClientRects().length);
      const answerFirst = { chat: visible(".chat"), sources: visible(".sources-pane") };
      document.querySelectorAll(".pane-switch button")[1]?.click();
      await new Promise((r) => setTimeout(r, 150));
      const sourcesAfter = { chat: visible(".chat"), sources: visible(".sources-pane") };
      return { answerFirst, sourcesAfter, wide: document.documentElement.scrollWidth <= innerWidth };
    })()`)) as { answerFirst: { chat: boolean; sources: boolean }; sourcesAfter: { chat: boolean; sources: boolean }; wide: boolean };
    check(
      "search: a narrow window shows one pane at a time, without sideways scrolling",
      narrow.answerFirst.chat && !narrow.answerFirst.sources && narrow.sourcesAfter.sources && !narrow.sourcesAfter.chat && narrow.wide,
      narrow,
    );
    await capture("search-all-narrow", wc);
  } finally {
    nativeTheme.themeSource = themeBefore;
    ctx.search.setTestDeps(null);
    win.closeTab(tab.id);
  }
}
