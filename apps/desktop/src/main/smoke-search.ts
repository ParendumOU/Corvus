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
  "C: high",
  "D: One older blog claims ravens and crows are the same species; field guides disagree",
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

function fakeProvider() {
  return {
    kind: "anthropic-api" as const,
    model: "claude-haiku-5-5",
    async *answer(req: { prompt: { system: string; user: string }; signal?: AbortSignal }) {
      for (let i = 0; i < STRUCTURED_REPLY.length; i += 14) {
        if (req.signal?.aborted) return;
        await new Promise((r) => setTimeout(r, 6));
        yield { type: "delta" as const, text: STRUCTURED_REPLY.slice(i, i + 14) };
      }
      const input = Math.ceil((req.prompt.system.length + req.prompt.user.length) / 3);
      yield { type: "usage" as const, inputTokens: input, outputTokens: Math.ceil(STRUCTURED_REPLY.length / 3.4), model: "claude-haiku-5-5" };
    },
  };
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
            ? "document.querySelector('.answer.done') && document.querySelectorAll('.result .meter[data-score]').length === 8 && document.querySelector('.entity-card') && document.querySelectorAll('.related button').length === 3 && document.querySelector('.search-footer')"
            : category === "images"
              ? "document.querySelectorAll('.image-tile img').length >= 12"
              : `document.querySelectorAll('.${category === "news" ? "news-item" : "video-card"}').length >= 5`;
        const ok = await waitFor(wc, ready);
        check(`search ${name} tab (${theme})`, ok, ok ? undefined : await wc.executeJavaScript("document.body.innerText.slice(0, 400)"));
        await waitFor(wc, "[...document.images].every((i) => i.complete)", 3000);
        await new Promise((r) => setTimeout(r, 450));
        await capture(`search-${name}-${theme}`, wc);
        if (category === "general") {
          // The rated result list sits below the answer.
          await wc.executeJavaScript("document.querySelector('.results')?.scrollIntoView({ block: 'start' }); window.scrollBy(0, -130)");
          await new Promise((r) => setTimeout(r, 250));
          await capture(`search-results-${theme}`, wc);
          await wc.executeJavaScript("window.scrollTo(0, 0)");
        }
      }
    }

    nativeTheme.themeSource = "light";
    win.loadUrl(tab.id, pageUrl("general"));
    await new Promise((r) => setTimeout(r, 400));
    await waitFor(wc, "document.querySelector('.answer.done') && document.querySelectorAll('.result .meter[data-score]').length === 8");
    const firstAi = await wc.executeJavaScript("document.querySelector('.result')?.dataset.rank");
    check("search re-ranks by AI score", firstAi === "3", firstAi);
    // The meter stays a circle while it rates too (a shared page style once stretched it into an oval).
    const meters = (await wc.executeJavaScript(`(() => {
      const result = document.querySelector('.results .result');
      if (!result) return null;
      const pending = document.createElement('div');
      pending.className = 'meter unscored pending';
      result.prepend(pending);
      const size = (m) => (m ? [m.offsetWidth, m.offsetHeight] : null);
      const out = { pending: size(pending), rated: size(document.querySelector('.result .meter[data-score]')) };
      pending.remove();
      return out;
    })()`)) as { pending: [number, number] | null; rated: [number, number] | null } | null;
    check(
      "search: the rating meter is round while rating and once rated",
      meters?.pending?.[0] === 40 && meters.pending[1] === 40 && meters.rated?.[0] === 40 && meters.rated[1] === 40,
      meters,
    );
    const structure = await wc.executeJavaScript(`({
      points: document.querySelectorAll('.key-points li').length,
      chips: document.querySelectorAll('.answer .cite').length,
      tags: document.querySelectorAll('.result .tag').length,
      summaries: document.querySelectorAll('.result .ai-summary').length,
      confidence: document.querySelector('.confidence')?.textContent ?? '',
      disagree: Boolean(document.querySelector('.disagree')),
      facts: document.querySelectorAll('.entity-card dt').length,
      live: document.querySelector('[aria-live]')?.getAttribute('aria-live'),
    })`);
    check(
      "search structured sections",
      structure.points === 4 && structure.chips >= 3 && structure.tags >= 8 && structure.summaries === 8 && /high/i.test(structure.confidence) && structure.disagree && structure.facts === 5 && structure.live === "polite",
      structure,
    );
    await wc.executeJavaScript("document.querySelector('.sort-toggle button[data-sort=original]').click()");
    await new Promise((r) => setTimeout(r, 300));
    const firstOriginal = await wc.executeJavaScript("document.querySelector('.result')?.dataset.rank");
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
    const focused = await wc.executeJavaScript("document.activeElement?.closest('.result')?.dataset.rank ?? document.activeElement?.tagName");
    check("search keyboard j/k navigation", focused === "1", focused);
    wc.sendInputEvent({ type: "keyDown", keyCode: "/" });
    wc.sendInputEvent({ type: "char", keyCode: "/" });
    wc.sendInputEvent({ type: "keyUp", keyCode: "/" });
    await new Promise((r) => setTimeout(r, 100));
    const inputFocused = await wc.executeJavaScript("document.activeElement?.id === 'search-input' && document.activeElement.value === " + JSON.stringify(QUERY));
    check("search / focuses the search box", inputFocused === true, inputFocused);

    win.loadUrl(tab.id, "corvus://search/?q=common%20raven&narrow=1");
    tab.view.setBounds({ ...tab.view.getBounds(), width: 560 });
    await waitFor(wc, "document.querySelector('.answer.done') && document.querySelector('.entity-card')");
    await new Promise((r) => setTimeout(r, 400));
    await capture("search-all-narrow", wc);
  } finally {
    nativeTheme.themeSource = themeBefore;
    ctx.search.setTestDeps(null);
    win.closeTab(tab.id);
  }
}
