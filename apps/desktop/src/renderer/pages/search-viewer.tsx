import { useEffect, useRef, useState, type CSSProperties, type FormEvent, type ReactNode } from "react";
import type { ResultRating, ResultTag, SearchResult } from "@corvus/shared";
import { aiSettled, answerReady, ratingsReady, type Turn, visibleAnswer } from "../../shared/search-view";
import { t as tx } from "../common/i18n";
import { IconCheck, IconChevronUp, IconSparkle } from "../common/icons";
import { renderAnswer } from "./answer";
import { ConfidenceBadge, ErrorNote, Fav, type FaviconMap } from "./search-parts";

/*
 * The All tab of corvus://search: the sources on the left, the conversation with the AI on the
 * right. Each pane scrolls on its own and keeps its rows and lines in place: results come first and
 * never move; the AI fills space kept for it (a line under each source) or writes on below in its
 * own pane, a sentence at a time.
 */

const TAG_LABEL: Record<ResultTag, string> = {
  official: tx("Official"),
  docs: tx("Docs"),
  reference: tx("Reference"),
  news: tx("News"),
  forum: tx("Forum"),
  video: tx("Video"),
  academic: tx("Academic"),
  opinion: tx("Opinion"),
  shopping: tx("Shopping"),
  outdated: tx("Outdated"),
  paywall: tx("Paywall"),
};
const TAG_TONE: Partial<Record<ResultTag, string>> = { official: "good", docs: "good", academic: "good", outdated: "warn", paywall: "warn" };

/** Which source the person points at, from either pane (its 0-based index), to light it up in both. */
export interface Pointing {
  lit: number | null;
  point: (index: number | null) => void;
}

// ---------------------------------------------------------------------------- sources

export interface SourceListProps {
  results: SearchResult[];
  order: number[];
  ratings: Record<number, ResultRating>;
  cited: Set<number>;
  icons: FaviconMap;
  /** AI output follows: each row keeps a line for its AI note and the rail shows the reading. */
  ai: boolean;
  /** The ratings are still being written. */
  pending: boolean;
  pointing: Pointing;
}

/**
 * Fixed-height rows: number, site, title (one line), snippet (two lines) and, with AI on, a line
 * kept for the AI note and tags. The rail on the left shows the AI reading while it rates, then each
 * source's relevance as the strength of its colour.
 */
export function SourceList({ results, order, ratings, cited, icons, ai, pending, pointing }: SourceListProps) {
  const rows = useRef(new Map<number, HTMLLIElement>());
  useEffect(() => {
    if (pointing.lit !== null) rows.current.get(pointing.lit)?.scrollIntoView({ block: "nearest" });
  }, [pointing.lit]);
  return (
    <ol className={`sources ${ai ? "rated" : ""} ${pending ? "reading" : ""}`} aria-label={tx("Sources")}>
      {order.map((i, position) => {
        const r = results[i]!;
        const rating = ratings[i];
        return (
          <li
            key={`${i}:${r.url}`}
            ref={(el) => {
              if (el) rows.current.set(i, el);
              else rows.current.delete(i);
            }}
            className={`source ${cited.has(i) ? "cited" : ""} ${pointing.lit === i ? "lit" : ""}`}
            data-rank={r.rank || i + 1}
            style={{ "--i": position, "--score": rating?.score ?? 0 } as CSSProperties}
            onMouseEnter={() => pointing.point(i)}
            onMouseLeave={() => pointing.point(null)}
          >
            <span
              className="source-rail"
              data-score={rating?.score}
              title={rating ? tx("AI relevance {score}/10", { score: rating.score }) : undefined}
              aria-label={rating ? tx("AI relevance {score} out of 10", { score: rating.score }) : undefined}
            />
            <div className="source-site">
              <span className="source-n" title={cited.has(i) ? tx("Cited in the answer") : tx("Source number")}>
                {i + 1}
              </span>
              <Fav domain={r.source} icons={icons} size={14} />
              <span className="source-domain">{r.source}</span>
            </div>
            <a className="source-title" href={r.url} data-nav title={r.title}>
              {r.title}
            </a>
            <p className="source-snippet">{r.snippet}</p>
            {ai && (
              <p className="source-ai" title={rating?.summary || undefined}>
                {rating && (
                  <>
                    {rating.summary && (
                      <>
                        <IconSparkle size={11} />
                        <span className="source-ai-text">{rating.summary}</span>
                      </>
                    )}
                    {rating.tags.slice(0, 2).map((tag) => (
                      <span key={tag} className={`tag ${TAG_TONE[tag] ?? ""}`}>
                        {TAG_LABEL[tag] ?? tag}
                      </span>
                    ))}
                  </>
                )}
              </p>
            )}
          </li>
        );
      })}
    </ol>
  );
}

/** Placeholder rows while the search engine answers: the same size as the rows that replace them. */
export function SourceSkeleton({ count = 6 }: { count?: number }) {
  return (
    <div className="sources skeleton" aria-hidden="true">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="source">
          <span className="source-rail" />
          <span className="bar short" />
          <span className="bar" />
          <span className="bar wide" />
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------- conversation

type StepState = "wait" | "run" | "done";

function Step({ state, children }: { state: StepState; children: ReactNode }) {
  return (
    <li className={`step ${state}`}>
      <span className="step-mark" aria-hidden="true">
        {state === "done" ? <IconCheck size={12} /> : null}
      </span>
      {children}
    </li>
  );
}

export interface TurnViewProps {
  turn: Turn;
  active: boolean;
  /** The engine writes an AI answer (a provider is set up). */
  ai: boolean;
  icons: FaviconMap;
  pointing: Pointing;
  onSelect: () => void;
  onAsk: (question: string) => void;
  /** Time from asking to the results, in ms. */
  resultsMs: number | null;
}

/**
 * One question and its answer. Three status lines say what the AI is doing (searching, reading the
 * sources, rating them); the answer appears below a sentence at a time, then its key points,
 * confidence, facts and the questions to ask next. Lines are only ever added below.
 */
export function TurnView({ turn, active, ai, icons, pointing, onSelect, onAsk, resultsMs }: TurnViewProps) {
  const s = turn.state;
  const results = s.results ?? [];
  const found = s.results !== null;
  const read = answerReady(s);
  const rated = ratingsReady(s);
  const settled = aiSettled(s);
  const fatal = s.errors.find((e) => !e.recoverable);
  const text = visibleAnswer(s.answer, read);
  const cited = new Set(read ? s.citations : []);
  const cite = (n: number, key: string) => {
    const r = results[n - 1];
    if (!r) return <span key={key} className="cite dead">{n}</span>;
    return (
      <a
        key={key}
        className={`cite ${pointing.lit === n - 1 && active ? "lit" : ""}`}
        href={r.url}
        aria-label={tx("Source {n}: {title}", { n, title: r.title })}
        title={r.title}
        onMouseEnter={() => active && pointing.point(n - 1)}
        onMouseLeave={() => active && pointing.point(null)}
        onFocus={() => active && pointing.point(n - 1)}
        onBlur={() => active && pointing.point(null)}
      >
        {n}
      </a>
    );
  };
  return (
    <article className={`turn ${active ? "active" : ""} ${read ? "read" : ""} ${rated ? "rated" : ""} ${settled ? "settled" : ""}`} aria-busy={!settled}>
      <h2 className="turn-question">
        <button type="button" className="turn-select" onClick={onSelect} aria-pressed={active} title={tx("Show its sources")}>
          {turn.query}
        </button>
      </h2>
      {ai && (
        <ol className="steps" aria-label={tx("Progress")}>
          <Step state={found ? "done" : "run"}>
            {found
              ? s.cached
                ? tx("{n} results from the cache", { n: results.length })
                : resultsMs !== null
                  ? tx("Found {n} results in {s} s", { n: results.length, s: (resultsMs / 1000).toFixed(1) })
                  : tx("Found {n} results", { n: results.length })
              : tx("Searching the web")}
          </Step>
          <Step state={read ? "done" : found && !fatal ? "run" : "wait"}>
            {/* The sources being read, in front of the words, so a change of words never moves them. */}
            <span className="step-sources" aria-hidden="true">
              {results.slice(0, 8).map((r, i) => (
                <span key={i} className={`step-source ${read && !cited.has(i) ? "unused" : ""}`}>
                  <Fav domain={r.source} icons={icons} size={14} />
                </span>
              ))}
            </span>
            <span>{read ? tx("Read {n} sources", { n: results.length }) : tx("Reading {n} sources", { n: found ? results.length : "…" })}</span>
          </Step>
          <Step state={rated ? "done" : found && !fatal ? "run" : "wait"}>{rated ? tx("Rated the results") : tx("Rating the results")}</Step>
        </ol>
      )}
      <div className="turn-answer" aria-live="polite">
        {s.errors.map((e, i) => (
          <ErrorNote key={i} message={e.message} recoverable={e.recoverable} />
        ))}
        {text && <div className="answer-text">{renderAnswer(text, cite)}</div>}
        {read && s.disagreement !== null && (
          <p className="disagree">
            <strong>{tx("Sources disagree.")}</strong> {s.disagreement}
          </p>
        )}
        {read && s.keyPoints.length > 0 && (
          <ul className="key-points" aria-label={tx("Key points")}>
            {s.keyPoints.map((point, i) => (
              <li key={i}>{renderAnswer(point.text, (n, key) => cite(n, `${i}-${key}`))}</li>
            ))}
          </ul>
        )}
        {read && s.confidence && <ConfidenceBadge level={s.confidence} />}
        {settled && s.entity && (
          <section className="turn-entity" aria-label={s.entity.title}>
            <h3>{s.entity.title}</h3>
            {s.entity.description && <p>{s.entity.description}</p>}
            {s.entity.facts.length > 0 && (
              <dl>
                {s.entity.facts.map((f, i) => (
                  <div key={i}>
                    <dt>{f.label}</dt>
                    <dd>{f.value}</dd>
                  </div>
                ))}
              </dl>
            )}
          </section>
        )}
        {settled && s.followUps.length > 0 && (
          <div className="next" role="group" aria-label={tx("Questions to ask next")}>
            {s.followUps.map((q) => (
              <button key={q} type="button" onClick={() => onAsk(q)}>
                {q}
              </button>
            ))}
          </div>
        )}
        {s.usage && (
          <p className="turn-usage">
            <span>{s.usage.model}</span>
            <span>{tx("{v} in, {v2} out", { v: s.usage.inputTokens.toLocaleString(), v2: s.usage.outputTokens.toLocaleString() })}</span>
          </p>
        )}
      </div>
    </article>
  );
}

/** The box under the conversation that asks the next question, in the context of the earlier ones. */
export function AskBox({ onAsk, ready }: { onAsk: (question: string) => void; ready: boolean }) {
  const [value, setValue] = useState("");
  const submit = (e: FormEvent): void => {
    e.preventDefault();
    const question = value.trim();
    if (!question || !ready) return;
    onAsk(question);
    setValue("");
  };
  return (
    <form className="ask" onSubmit={submit}>
      <input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={tx("Ask a follow-up")}
        aria-label={tx("Follow-up question")}
        spellCheck={false}
        maxLength={2000}
      />
      <button type="submit" disabled={!ready || !value.trim()} aria-label={tx("Ask")} title={tx("Ask")}>
        <IconChevronUp size={16} />
      </button>
    </form>
  );
}
