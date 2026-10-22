import type { SearchResult } from "@corvus/shared";
import { parseHTML } from "linkedom";
import { fetchWithTimeout, USER_AGENT } from "../http.js";
import {
  baseLang,
  DEFAULT_RETRIEVER_TIMEOUT_MS,
  type RawHit,
  type RetrieveOptions,
  type Retriever,
  RetrieverError,
  type RetrieverHttpOptions,
  toResults,
} from "./types.js";

const ENDPOINT = "https://html.duckduckgo.com/html/";

const REGIONS: Record<string, string> = {
  en: "us-en",
  "en-gb": "uk-en",
  es: "es-es",
  "es-mx": "mx-es",
  fr: "fr-fr",
  de: "de-de",
  it: "it-it",
  pt: "pt-pt",
  "pt-br": "br-pt",
  nl: "nl-nl",
  pl: "pl-pl",
  ru: "ru-ru",
  uk: "ua-uk",
  ja: "jp-jp",
  ko: "kr-kr",
  zh: "cn-zh",
  "zh-tw": "tw-tzh",
  sv: "se-sv",
  da: "dk-da",
  nb: "no-no",
  fi: "fi-fi",
  tr: "tr-tr",
  ar: "xa-ar",
  he: "il-he",
  cs: "cz-cs",
  el: "gr-el",
  hu: "hu-hu",
  ro: "ro-ro",
  ca: "ct-ca",
  vi: "vn-vi",
  th: "th-th",
  id: "id-id",
  hi: "in-en",
};

/** DuckDuckGo "kl" region code for a BCP-47 language; "wt-wt" (no region) when unknown. */
export function duckduckgoRegion(lang: string): string {
  const lower = lang.toLowerCase();
  return REGIONS[lower] ?? REGIONS[baseLang(lang)] ?? "wt-wt";
}

/** Unwraps DDG's //duckduckgo.com/l/?uddg=<target> redirect links. Returns undefined for ads. */
export function unwrapDuckDuckGoHref(href: string | null): string | undefined {
  if (!href) return undefined;
  let url: URL;
  try {
    url = new URL(href, "https://duckduckgo.com");
  } catch {
    return undefined;
  }
  const target = url.hostname.endsWith("duckduckgo.com") ? url.searchParams.get("uddg") : href;
  if (!target) return undefined;
  try {
    const t = new URL(target);
    if (t.hostname.endsWith("duckduckgo.com") || t.hostname.endsWith("bing.com")) return undefined;
    return t.toString();
  } catch {
    return undefined;
  }
}

export function isDuckDuckGoChallenge(html: string): boolean {
  return html.includes("anomaly-modal") || html.includes("challenge-form");
}

export function parseDuckDuckGoHtml(html: string, maxResults: number): SearchResult[] {
  if (isDuckDuckGoChallenge(html)) throw new RetrieverError("duckduckgo", "bot challenge page returned");
  const { document } = parseHTML(html);
  const hits: RawHit[] = [];
  for (const node of document.querySelectorAll("div.result")) {
    if (node.classList.contains("result--ad")) continue;
    const link = node.querySelector("a.result__a");
    if (!link) continue;
    hits.push({
      url: unwrapDuckDuckGoHref(link.getAttribute("href")),
      title: link.textContent,
      snippet: node.querySelector(".result__snippet")?.textContent,
    });
  }
  return toResults(hits, maxResults);
}

export function createDuckDuckGoRetriever(http: RetrieverHttpOptions = {}): Retriever {
  const fetchImpl = http.fetch ?? fetch;
  const timeoutMs = http.timeoutMs ?? DEFAULT_RETRIEVER_TIMEOUT_MS;
  return {
    kind: "duckduckgo",
    async search(query: string, opts: RetrieveOptions) {
      const url = new URL(ENDPOINT);
      url.searchParams.set("q", query);
      url.searchParams.set("kl", duckduckgoRegion(opts.lang));
      // GET is answered with results; POST from non-browser clients tends to get the bot challenge.
      const res = await fetchWithTimeout(
        fetchImpl,
        url.toString(),
        {
          headers: {
            "User-Agent": USER_AGENT,
            Accept: "text/html",
            "Accept-Language": `${opts.lang},en;q=0.5`,
          },
        },
        timeoutMs,
        opts.signal,
      );
      if (!res.ok) throw new RetrieverError("duckduckgo", `HTTP ${res.status}`);
      return parseDuckDuckGoHtml(await res.text(), opts.maxResults);
    },
  };
}
