import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import type { SearchCategory } from "@corvus/shared";
import type { EngineInfo } from "../../shared/ipc";
import { classifyOmnibox, intentToUrl, searchUrl } from "../../shared/omnibox";
import {
  aiSettled,
  displayOrder,
  initialSearchView,
  listReady,
  openingSort,
  parseCategory,
  reduceSearchView,
  type SearchViewState,
  type SortMode,
} from "../../shared/search-view";
import { errorMessage, internalApi } from "../common/api";
import { CorvusMark, IconSearch } from "../common/icons";
import {
  AnswerBlock,
  EntityPanel,
  ErrorNote,
  type FaviconMap,
  FooterStat,
  ImageGrid,
  NewsList,
  RelatedQuestions,
  ResultList,
  ResultSkeleton,
  VideoGrid,
} from "./search-parts";
import { mount } from "./shell";
import "./search.css";

import { t as tx } from "../common/i18n";
type Depth = "quick" | "deep";

const TABS: Array<{ id: SearchCategory; label: string }> = [
  { id: "general", label: tx("All") },
  { id: "news", label: tx("News") },
  { id: "images", label: tx("Images") },
  { id: "videos", label: tx("Videos") },
];

const RETRIEVER_LABEL: Record<string, string> = { searxng: "SearXNG", brave: "Brave", duckduckgo: "DuckDuckGo" };
const SORT_KEY = "corvus.search.sort";
const NO_RATINGS: SearchViewState["ratings"] = {};
const NO_CITES = new Set<number>();

function readParams(): { query: string; depth: Depth; category: SearchCategory } {
  const params = new URLSearchParams(location.search);
  return {
    query: params.get("q") ?? "",
    depth: params.get("depth") === "deep" ? "deep" : "quick",
    category: parseCategory(params.get("cat")),
  };
}

function hrefFor(query: string, depth: Depth, category: SearchCategory): string {
  return searchUrl(query) + (depth === "deep" ? "&depth=deep" : "") + (category === "general" ? "" : `&cat=${category}`);
}

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return Boolean(el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable));
}

/** j/k move through result links, / focuses the search box, Escape leaves it. */
function useKeyboardNav(input: React.RefObject<HTMLInputElement | null>): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (isTyping(e.target)) {
        if (e.key === "Escape") (e.target as HTMLElement).blur();
        return;
      }
      if (e.key === "/") {
        e.preventDefault();
        input.current?.focus();
        input.current?.select();
        return;
      }
      if (e.key !== "j" && e.key !== "k") return;
      const items = [...document.querySelectorAll<HTMLElement>("[data-nav]")];
      if (!items.length) return;
      e.preventDefault();
      const current = items.findIndex((el) => el === document.activeElement);
      const next = current < 0 ? (e.key === "j" ? 0 : items.length - 1) : Math.min(items.length - 1, Math.max(0, current + (e.key === "j" ? 1 : -1)));
      const target = items[next]!;
      target.focus();
      target.closest("li, .image-tile")?.scrollIntoView({ block: "nearest", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [input]);
}

function useSearch(query: string, depth: Depth, category: SearchCategory): SearchViewState {
  const [state, setState] = useState<SearchViewState>(initialSearchView);
  const searchId = useRef<string | null>(null);
  useEffect(() => {
    if (!query.trim()) return;
    const api = internalApi();
    const off = api.onEvent((message) => {
      if (message.type !== "search") return;
      // Events can arrive before the start() reply; a page runs one search, so accept them.
      if (searchId.current !== null && message.message.searchId !== searchId.current) return;
      if ("done" in message.message) {
        setState((s) => ({ ...s, finished: true, structuredDone: true }));
        return;
      }
      const event = message.message.event;
      setState((s) => reduceSearchView(s, event));
    });
    void api
      .call("search.start", query, { depth, category })
      .then((id) => {
        searchId.current = id;
      })
      .catch((err: unknown) => setState((s) => ({ ...s, errors: [...s.errors, { message: errorMessage(err), recoverable: false }], finished: true })));
    const cancel = (): void => {
      if (searchId.current) void api.call("search.cancel", searchId.current);
    };
    window.addEventListener("pagehide", cancel);
    return () => {
      off();
      cancel();
      window.removeEventListener("pagehide", cancel);
    };
  }, [query, depth, category]);
  return state;
}

function useFavicons(domains: string[]): FaviconMap {
  const [icons, setIcons] = useState<FaviconMap>({});
  const key = domains.join(" ");
  useEffect(() => {
    if (!domains.length) return;
    let live = true;
    void internalApi()
      .call("search.favicons", domains)
      .then((map) => live && setIcons((prev) => ({ ...prev, ...map })))
      .catch(() => undefined);
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return icons;
}

function SearchPage() {
  const { query, depth, category } = useMemo(readParams, []);
  const [input, setInput] = useState(query);
  const [engine, setEngine] = useState<EngineInfo | null>(null);
  // Whether AI output follows the results (null until the engine says): its space is kept from the start.
  const [answers, setAnswers] = useState<boolean | null>(null);
  const savedSort = useMemo<SortMode>(() => (localStorage.getItem(SORT_KEY) === "original" ? "original" : "ai"), []);
  const [pickedSort, setPickedSort] = useState<SortMode | null>(null);
  const opening = useRef<SortMode | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const state = useSearch(query, depth, category);
  const domains = useMemo(() => [...new Set((state.results ?? []).map((r) => r.source.toLowerCase()))], [state.results]);
  const icons = useFavicons(domains);
  useKeyboardNav(inputRef);

  useEffect(() => {
    document.title = query ? tx("{query} - Corvus Search", { query }) : tx("Corvus Search");
    void internalApi()
      .call("search.engineInfo")
      .then((info) => {
        setEngine(info);
        setAnswers(info.answers);
      })
      .catch(() => setAnswers(false));
  }, [query]);

  const setSort = (mode: SortMode): void => {
    setPickedSort(mode);
    localStorage.setItem(SORT_KEY, mode);
  };

  const submit = (e: FormEvent): void => {
    e.preventDefault();
    const intent = classifyOmnibox(input);
    if (intent.kind === "url") location.href = intentToUrl(intent);
    else if (intent.query) location.href = hrefFor(intent.query, depth, category);
  };

  const results = state.results ?? [];
  const fatal = state.errors.find((e) => !e.recoverable);
  const general = category === "general";
  // AI output (answer, ratings, summaries, side panel) follows the results on this page.
  const ai = general && answers === true;
  const aiOff = general && answers === false && !fatal;
  const ready = listReady(state, answers);
  const settled = aiSettled(state);
  if (ready && opening.current === null) opening.current = openingSort(state, savedSort);
  const sort = pickedSort ?? opening.current ?? "original";
  const showAnswer = ai && Boolean(query) && (state.results === null || results.length > 0) && (!fatal || state.answer.length > 0);
  const answerNotes = showAnswer ? state.errors.filter((e) => e.recoverable) : [];
  const pageErrors = state.errors.filter((e) => !answerNotes.includes(e));
  const order = displayOrder(state, sort);
  const cited = settled ? new Set(state.citations) : NO_CITES;
  const ratings = settled ? state.ratings : NO_RATINGS;
  const hasRatings = Object.keys(ratings).length > 0;

  return (
    <div className={`search-page cat-${category}`}>
      <header className="search-header">
        <a className="search-brand" href="corvus://newtab/" title={tx("New tab")} aria-label={tx("Corvus new tab")}>
          <CorvusMark size={28} />
        </a>
        <form className="search-box" role="search" onSubmit={submit}>
          <IconSearch size={18} />
          <input
            id="search-input"
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={tx("Search or ask anything")}
            aria-label={tx("Search")}
            spellCheck={false}
            autoFocus={!query}
          />
          <kbd className="slash-hint" aria-hidden="true">
            /
          </kbd>
        </form>
        {general && (
          <div className="segmented depth" role="group" aria-label={tx("Answer depth")}>
            <a className={depth === "quick" ? "on" : ""} aria-current={depth === "quick" ? "true" : undefined} href={hrefFor(query, "quick", category)} title={tx("Answer from search snippets (fastest, fewest tokens)")}>{tx("Quick")}</a>
            <a className={depth === "deep" ? "on" : ""} aria-current={depth === "deep" ? "true" : undefined} href={hrefFor(query, "deep", category)} title={tx("Also read the top three pages")}>{tx("Deep")}</a>
          </div>
        )}
        {query && (
          <nav className="search-tabs" aria-label={tx("Search type")}>
            {TABS.map((t) => (
              <a key={t.id} href={hrefFor(query, depth, t.id)} className={t.id === category ? "on" : ""} aria-current={t.id === category ? "page" : undefined}>
                {t.label}
              </a>
            ))}
            {ai && (
              // Kept in place (hidden) until the ratings are in, so the header never changes height.
              <div className={`sort-toggle ${hasRatings ? "" : "waiting"}`} role="group" aria-label={tx("Sort results")} aria-hidden={!hasRatings || undefined}>
                <span className="sort-label">{tx("Sort")}</span>
                <button type="button" data-sort="ai" className={sort === "ai" ? "on" : ""} aria-pressed={sort === "ai"} onClick={() => setSort("ai")}>{tx("AI relevance")}</button>
                <button type="button" data-sort="original" className={sort === "original" ? "on" : ""} aria-pressed={sort === "original"} onClick={() => setSort("original")}>{tx("Original")}</button>
              </div>
            )}
          </nav>
        )}
      </header>

      {!query ? (
        <div className="search-empty">
          <CorvusMark size={56} />
          <p>{tx("Search the web. Corvus answers with citations and rates every result.")}</p>
          <p className="muted small">{tx("Press")}{" "}<kbd>/</kbd>{" "}{tx("to type,")}{" "}<kbd>j</kbd>{" "}{tx("and")}{" "}<kbd>k</kbd>{" "}{tx("to move through results.")}</p>
        </div>
      ) : (
        <div className={`serp ${ai ? "with-aside" : ""}`}>
          <main className="serp-main">
            {showAnswer && (
              <AnswerBlock
                answer={state.answer}
                ready={settled}
                keyPoints={state.keyPoints}
                confidence={state.confidence}
                disagreement={state.disagreement}
                citations={state.citations}
                results={results}
                ratings={state.ratings}
                icons={icons}
                deep={depth === "deep"}
                notes={answerNotes.map((e) => e.message)}
              />
            )}
            {aiOff && (
              <section className="answer off">
                <p>
                  <strong>{tx("AI answers are off.")}</strong>{" "}{tx("Add an Anthropic API key, or choose Claude Code, in")}{" "}
                  <a href="corvus://settings/">{tx("Settings")}</a>{" "}{tx("to get a cited answer and a rating for every result.")}</p>
              </section>
            )}

            {pageErrors.map((e, i) => (
              <ErrorNote key={i} message={e.message} recoverable={e.recoverable}>
                {!e.recoverable && engine && !engine.available && (
                  <div className="muted small">{tx("Configure the search engine in")}{" "}<a href="corvus://settings/">{tx("Settings")}</a>.
                  </div>
                )}
              </ErrorNote>
            ))}

            {!ready && !fatal ? (
              category === "images" ? (
                <div className="image-grid skeleton" aria-hidden="true">
                  {Array.from({ length: 12 }, (_, i) => (
                    <span key={i} className="image-tile" style={{ flexGrow: 1 + (i % 3) * 0.4, flexBasis: `${180 * (1 + (i % 3) * 0.4)}px` }} />
                  ))}
                </div>
              ) : (
                <ResultSkeleton />
              )
            ) : category === "news" ? (
              <NewsList results={results} icons={icons} />
            ) : category === "images" ? (
              <ImageGrid results={results} icons={icons} />
            ) : category === "videos" ? (
              <VideoGrid results={results} icons={icons} />
            ) : (
              <ResultList results={results} order={order} ratings={ratings} cited={cited} icons={icons} ai={ai} pending={ai && !settled} />
            )}

            {ready && results.length === 0 && <div className="no-results">{tx("No results for this search.")}</div>}
            {(fatal || state.results?.length === 0) && (
              <div className="fallback">{tx("Try this search on")}{" "}
                <a href={`https://duckduckgo.com/?q=${encodeURIComponent(query)}`}>{tx("DuckDuckGo")}</a>{" "}{tx("or")}{" "}
                <a href={`https://www.startpage.com/do/search?q=${encodeURIComponent(query)}`}>{tx("Startpage")}</a>.
              </div>
            )}

            {ready && (
              <footer className="search-footer">
                {state.usage && (
                  <>
                    <FooterStat label={tx("Model")}>{state.usage.model}</FooterStat>
                    <FooterStat label={tx("Tokens")}>{tx("{v} in, {v2} out", { v: state.usage.inputTokens.toLocaleString(), v2: state.usage.outputTokens.toLocaleString() })}</FooterStat>
                  </>
                )}
                {!general && <FooterStat label={tx("Tokens")}>{tx("0, results only")}</FooterStat>}
                {state.retriever && <FooterStat label={tx("Results from")}>{RETRIEVER_LABEL[state.retriever] ?? state.retriever}</FooterStat>}
                {state.cached && <FooterStat label={tx("Cache")}>{tx("Served from cache")}</FooterStat>}
              </footer>
            )}
          </main>

          {ai && (
            // The column is kept from the start so the result column never narrows when it fills.
            <aside className="serp-aside">
              {settled && state.entity && <EntityPanel entity={state.entity} source={results[state.order?.[0] ?? 0]} icons={icons} />}
              {settled && state.followUps.length > 0 && (
                <RelatedQuestions questions={state.followUps} onPick={(q) => (location.href = hrefFor(q, depth, "general"))} />
              )}
            </aside>
          )}
        </div>
      )}
    </div>
  );
}

mount(<SearchPage />);
