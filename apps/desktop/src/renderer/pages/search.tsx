import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import type { SearchCategory, SearchEvent } from "@corvus/shared";
import type { EngineInfo } from "../../shared/ipc";
import { classifyOmnibox, intentToUrl, searchUrl } from "../../shared/omnibox";
import {
  answerReady,
  contextFor,
  displayOrder,
  initialSearchView,
  listReady,
  openingSort,
  parseCategory,
  ratingsReady,
  reduceSearchView,
  type SearchViewState,
  type SortMode,
  type Turn,
} from "../../shared/search-view";
import { errorMessage, internalApi } from "../common/api";
import { t as tx } from "../common/i18n";
import { CorvusMark, IconSearch } from "../common/icons";
import { ErrorNote, type FaviconMap, ImageGrid, NewsList, VideoGrid } from "./search-parts";
import { AskBox, type Pointing, SourceList, SourceSkeleton, TurnView } from "./search-viewer";
import { mount } from "./shell";
import "./search.css";

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

type Item = SearchEvent | "done";

/**
 * The searches of this page: the one in the address and the follow-ups asked under it, each a turn
 * with its own state. Events are routed by search id; those that come before search.start replies
 * with the id wait for it.
 */
function useConversation(first: string, depth: Depth, category: SearchCategory) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [resultsMs, setResultsMs] = useState<Record<string, number>>({});
  const turnsRef = useRef(turns);
  turnsRef.current = turns;
  const keys = useRef(new Map<string, string>());
  const early = useRef(new Map<string, Item[]>());
  const running = useRef(new Set<string>());
  const asked = useRef(new Map<string, number>());

  const apply = useCallback((key: string, item: Item) => {
    if (item !== "done" && item.type === "results") {
      const at = asked.current.get(key);
      if (at !== undefined) setResultsMs((m) => ({ ...m, [key]: performance.now() - at }));
    }
    setTurns((all) =>
      all.map((t) =>
        t.key !== key ? t : { ...t, state: item === "done" ? { ...t.state, finished: true, structuredDone: true } : reduceSearchView(t.state, item) },
      ),
    );
  }, []);

  useEffect(() => {
    const api = internalApi();
    const off = api.onEvent((message) => {
      if (message.type !== "search") return;
      const { searchId } = message.message;
      const item: Item = "done" in message.message ? "done" : message.message.event;
      if (item === "done") running.current.delete(searchId);
      const key = keys.current.get(searchId);
      if (key) apply(key, item);
      else early.current.set(searchId, [...(early.current.get(searchId) ?? []), item]);
    });
    const cancel = (): void => {
      for (const id of running.current) void api.call("search.cancel", id);
    };
    window.addEventListener("pagehide", cancel);
    return () => {
      off();
      cancel();
      window.removeEventListener("pagehide", cancel);
    };
  }, [apply]);

  const ask = useCallback(
    (query: string) => {
      const context = contextFor(turnsRef.current);
      const key = `t${turnsRef.current.length}-${Date.now()}`;
      asked.current.set(key, performance.now());
      setTurns((all) => [...all, { key, query, state: initialSearchView }]);
      internalApi()
        .call("search.start", query, { depth, category, ...(context.length ? { context } : {}) })
        .then((id) => {
          keys.current.set(id, key);
          running.current.add(id);
          for (const item of early.current.get(id) ?? []) {
            if (item === "done") running.current.delete(id);
            apply(key, item);
          }
          early.current.delete(id);
        })
        .catch((err: unknown) => apply(key, { type: "error", message: errorMessage(err), recoverable: false }));
    },
    [depth, category, apply],
  );

  const started = useRef(false);
  useEffect(() => {
    if (started.current || !first.trim()) return;
    started.current = true;
    ask(first);
  }, [first, ask]);

  return { turns, ask, resultsMs };
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
  // Whether AI output follows the results (null until the engine says): the layout is chosen with it.
  const [answers, setAnswers] = useState<boolean | null>(null);
  const savedSort = useMemo<SortMode>(() => (localStorage.getItem(SORT_KEY) === "original" ? "original" : "ai"), []);
  const [pickedSort, setPickedSort] = useState<SortMode | null>(null);
  const openings = useRef(new Map<string, SortMode>());
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [lit, setLit] = useState<number | null>(null);
  const [narrowPane, setNarrowPane] = useState<"answer" | "sources">("answer");
  const inputRef = useRef<HTMLInputElement>(null);
  const chatScroll = useRef<HTMLDivElement>(null);
  const { turns, ask, resultsMs } = useConversation(query, depth, category);
  useKeyboardNav(inputRef);

  const active = turns.find((t) => t.key === activeKey) ?? turns.at(-1);
  const state = active?.state ?? initialSearchView;
  const domains = useMemo(() => [...new Set(turns.flatMap((t) => (t.state.results ?? []).map((r) => r.source.toLowerCase())))], [turns]);
  const icons = useFavicons(domains);

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

  const askNext = (question: string): void => {
    setActiveKey(null);
    setNarrowPane("answer");
    ask(question);
  };

  // A new question scrolls to the top of the conversation, with room below for its answer.
  const turnCount = turns.length;
  useEffect(() => {
    if (turnCount < 2) return;
    const last = chatScroll.current?.querySelector<HTMLElement>(".turn:last-of-type");
    last?.scrollIntoView({ block: "start", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  }, [turnCount]);

  const results = state.results ?? [];
  const fatal = state.errors.find((e) => !e.recoverable);
  const general = category === "general";
  const ai = general && answers === true;
  const ready = listReady(state, answers);
  const rated = ratingsReady(state);
  if (active && ready && !openings.current.has(active.key)) openings.current.set(active.key, openingSort(state, savedSort));
  const sort = pickedSort ?? (active && openings.current.get(active.key)) ?? "original";
  const order = displayOrder(state, sort);
  const cited = rated ? new Set(state.citations) : NO_CITES;
  const ratings = rated ? state.ratings : NO_RATINGS;
  const hasRatings = Object.keys(ratings).length > 0;
  const pointing: Pointing = { lit, point: setLit };
  const last = turns.at(-1);
  const retriever = state.retriever ? (RETRIEVER_LABEL[state.retriever] ?? state.retriever) : "";

  const fallback = (fatal || state.results?.length === 0) && (
    <div className="fallback">
      {tx("Try this search on")} <a href={`https://duckduckgo.com/?q=${encodeURIComponent(active?.query ?? query)}`}>{tx("DuckDuckGo")}</a> {tx("or")}{" "}
      <a href={`https://www.startpage.com/do/search?q=${encodeURIComponent(active?.query ?? query)}`}>{tx("Startpage")}</a>.
    </div>
  );

  return (
    <div className={`search-page cat-${category} ${general && query ? "viewing" : ""}`}>
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
              <div className="segmented pane-switch" role="group" aria-label={tx("Show")}>
                <button type="button" className={narrowPane === "answer" ? "on" : ""} aria-pressed={narrowPane === "answer"} onClick={() => setNarrowPane("answer")}>
                  {tx("Answer")}
                </button>
                <button type="button" className={narrowPane === "sources" ? "on" : ""} aria-pressed={narrowPane === "sources"} onClick={() => setNarrowPane("sources")}>
                  {tx("Sources")}
                </button>
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
      ) : general ? (
        // Until the page knows whether an AI answer comes (a few ms), it draws nothing: the layout
        // depends on it, and nothing drawn before may move.
        answers === null ? null : (
          <div className={`viewer ${ai ? "with-chat" : "plain"} show-${narrowPane}`}>
            <section className="pane sources-pane" aria-label={tx("Sources")}>
              <div className="pane-head">
                <span className="pane-title">{tx("Sources")}</span>
                <span className="pane-meta">
                  {ready && results.length > 0
                    ? state.cached
                      ? tx("{n} results from the cache", { n: results.length })
                      : tx("{n} results from {engine}", { n: results.length, engine: retriever })
                    : ""}
                </span>
                {ai && (
                  // Kept in place (hidden) until the ratings are in, so the head never changes.
                  <div className={`sort-toggle ${hasRatings ? "" : "waiting"}`} role="group" aria-label={tx("Sort results")} aria-hidden={!hasRatings || undefined}>
                    <button type="button" data-sort="ai" className={sort === "ai" ? "on" : ""} aria-pressed={sort === "ai"} onClick={() => setSort("ai")}>{tx("AI relevance")}</button>
                    <button type="button" data-sort="original" className={sort === "original" ? "on" : ""} aria-pressed={sort === "original"} onClick={() => setSort("original")}>{tx("Original")}</button>
                  </div>
                )}
              </div>
              {!ai && !fatal && (
                <section className="ai-off">
                  <strong>{tx("AI answers are off.")}</strong>{" "}{tx("Add an Anthropic API key, or choose Claude Code, in")}{" "}
                  <a href="corvus://settings/">{tx("Settings")}</a>{" "}{tx("to get a cited answer and a rating for every result.")}
                </section>
              )}
              {!ai && state.errors.map((e, i) => (
                <ErrorNote key={i} message={e.message} recoverable={e.recoverable}>
                  {!e.recoverable && engine && !engine.available && (
                    <div className="muted small">{tx("Configure the search engine in")}{" "}<a href="corvus://settings/">{tx("Settings")}</a>.</div>
                  )}
                </ErrorNote>
              ))}
              {!ready && !fatal ? (
                <SourceSkeleton />
              ) : (
                <SourceList results={results} order={order} ratings={ratings} cited={cited} icons={icons} ai={ai} pending={ai && !rated && !fatal} pointing={pointing} />
              )}
              {ready && results.length === 0 && <div className="no-results">{tx("No results for this search.")}</div>}
              {fallback}
            </section>
            {ai && (
              <section className="pane chat" aria-label={tx("Conversation")}>
                <div className="chat-scroll" ref={chatScroll}>
                  {turns.map((t) => (
                    <TurnView
                      key={t.key}
                      turn={t}
                      active={t === active}
                      ai={ai}
                      icons={icons}
                      pointing={pointing}
                      onSelect={() => setActiveKey(t.key)}
                      onAsk={askNext}
                      resultsMs={resultsMs[t.key] ?? null}
                    />
                  ))}
                </div>
                <AskBox onAsk={askNext} ready={Boolean(last && answerReady(last.state))} />
              </section>
            )}
          </div>
        )
      ) : (
        <main className="serp">
          {state.errors.map((e, i) => (
            <ErrorNote key={i} message={e.message} recoverable={e.recoverable}>
              {!e.recoverable && engine && !engine.available && (
                <div className="muted small">{tx("Configure the search engine in")}{" "}<a href="corvus://settings/">{tx("Settings")}</a>.</div>
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
              <SourceSkeleton count={5} />
            )
          ) : category === "news" ? (
            <NewsList results={results} icons={icons} />
          ) : category === "images" ? (
            <ImageGrid results={results} icons={icons} />
          ) : (
            <VideoGrid results={results} icons={icons} />
          )}
          {ready && results.length === 0 && <div className="no-results">{tx("No results for this search.")}</div>}
          {fallback}
          {ready && (
            <footer className="search-footer">
              <span>{tx("0 tokens, results only")}</span>
              {retriever && <span>{tx("Results from {engine}", { engine: retriever })}</span>}
              {state.cached && <span>{tx("Served from cache")}</span>}
            </footer>
          )}
        </main>
      )}
    </div>
  );
}

mount(<SearchPage />);
