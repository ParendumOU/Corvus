import { useLayoutEffect, useRef, type ReactNode } from "react";
import type { Confidence, EntityCard, KeyPoint, ResultRating, ResultTag, SearchResult } from "@corvus/shared";
import { IconPlay, IconSearch, IconSparkle, IconWarning } from "../common/icons";
import { LetterIcon } from "../common/ui";
import { renderAnswer } from "./answer";

export type FaviconMap = Record<string, string | null>;

export function Fav({ domain, icons, size = 16 }: { domain: string; icons: FaviconMap; size?: number }) {
  const src = icons[domain.toLowerCase()];
  return src ? <img className="fav" src={src} width={size} height={size} alt="" draggable={false} /> : <LetterIcon text={domain} size={size} />;
}

const TAG_LABEL: Record<ResultTag, string> = {
  official: "Official",
  docs: "Docs",
  reference: "Reference",
  news: "News",
  forum: "Forum",
  video: "Video",
  academic: "Academic",
  opinion: "Opinion",
  shopping: "Shopping",
  outdated: "Outdated",
  paywall: "Paywall",
};
const TAG_TONE: Partial<Record<ResultTag, string>> = { official: "good", docs: "good", academic: "good", outdated: "warn", paywall: "warn" };

function pathOf(url: string): string {
  try {
    const u = new URL(url);
    const path = decodeURIComponent(u.pathname).replace(/\/$/, "");
    return path.length > 48 ? `${path.slice(0, 47)}…` : path;
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------- answer

export function CiteChip({ n, result, rating, icons }: { n: number; result?: SearchResult; rating?: ResultRating; icons: FaviconMap }) {
  if (!result) return <span className="cite dead">{n}</span>;
  return (
    <span className="cite-wrap">
      <a className="cite" href={result.url} aria-label={`Source ${n}: ${result.title}`}>
        {n}
      </a>
      <span className="cite-pop" role="tooltip">
        <span className="cite-pop-source">
          <Fav domain={result.source} icons={icons} size={14} />
          {result.source}
        </span>
        <span className="cite-pop-title">{result.title}</span>
        {(rating?.summary || result.snippet) && <span className="cite-pop-text">{rating?.summary || result.snippet}</span>}
      </span>
    </span>
  );
}

const CONFIDENCE_LABEL: Record<Confidence, string> = { high: "High confidence", medium: "Medium confidence", low: "Low confidence" };
const CONFIDENCE_DOTS: Record<Confidence, number> = { high: 3, medium: 2, low: 1 };

export function ConfidenceBadge({ level }: { level: Confidence }) {
  return (
    <span className={`confidence ${level}`} title="How well the sources support this answer">
      <span className="dots" aria-hidden="true">
        {[1, 2, 3].map((i) => (
          <i key={i} className={i <= CONFIDENCE_DOTS[level] ? "on" : ""} />
        ))}
      </span>
      {CONFIDENCE_LABEL[level]}
    </span>
  );
}

export interface AnswerProps {
  answer: string;
  done: boolean;
  structuredDone: boolean;
  keyPoints: KeyPoint[];
  confidence: Confidence | null;
  disagreement: string | null;
  citations: number[];
  results: SearchResult[];
  ratings: Record<number, ResultRating>;
  icons: FaviconMap;
  deep: boolean;
  failed: boolean;
}

export function AnswerBlock(p: AnswerProps) {
  const chip = (n: number, key: string) => <CiteChip key={key} n={n} result={p.results[n - 1]} rating={p.ratings[n - 1]} icons={p.icons} />;
  const cited = p.citations.filter((i) => p.results[i]);
  const waitingForPoints = p.done && !p.structuredDone && p.keyPoints.length === 0 && !p.failed;
  return (
    <section className={`answer ${p.done ? "done" : "streaming"}`} aria-labelledby="answer-title">
      <header className="answer-head">
        <IconSparkle size={15} />
        <h2 id="answer-title">Answer</h2>
        {p.deep && <span className="pill">Deep</span>}
        {p.confidence && <ConfidenceBadge level={p.confidence} />}
      </header>
      <div className="answer-text" aria-live="polite" aria-busy={!p.done}>
        {p.answer ? (
          <>
            {renderAnswer(p.answer, chip)}
            {!p.done && !p.failed && <span className="caret" aria-hidden="true" />}
          </>
        ) : (
          <div className="skeleton-lines" aria-label="Writing the answer">
            <span />
            <span />
            <span />
          </div>
        )}
      </div>
      {p.disagreement !== null && (
        <p className="disagree">
          <IconWarning size={15} />
          <span>
            <strong>Sources disagree.</strong> {p.disagreement}
          </span>
        </p>
      )}
      {p.keyPoints.length > 0 && (
        <ul className="key-points" aria-label="Key points">
          {p.keyPoints.map((point, i) => (
            <li key={i}>{renderAnswer(point.text, (n, key) => chip(n, `${i}-${key}`))}</li>
          ))}
        </ul>
      )}
      {waitingForPoints && (
        <div className="skeleton-lines points" aria-hidden="true">
          <span />
          <span />
        </div>
      )}
      {cited.length > 0 && p.done && (
        <div className="answer-sources" aria-label="Cited sources">
          {cited.map((i) => {
            const r = p.results[i]!;
            return (
              <a key={i} className="source-chip" href={r.url} title={r.title}>
                <Fav domain={r.source} icons={p.icons} size={14} />
                <span>{r.source}</span>
                <b>{i + 1}</b>
              </a>
            );
          })}
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------- results

export function Meter({ rating, pending }: { rating?: ResultRating; pending: boolean }) {
  if (!rating) {
    return (
      <div className={`meter empty ${pending ? "pending" : ""}`} aria-hidden={!pending} aria-label={pending ? "Rating" : undefined}>
        <b>{pending ? "" : "–"}</b>
        <span className="meter-track" />
      </div>
    );
  }
  const tone = rating.score >= 8 ? "hi" : rating.score >= 5 ? "mid" : "lo";
  return (
    <div className={`meter ${tone}`} data-score={rating.score} title={`AI relevance ${rating.score}/10`} aria-label={`AI relevance ${rating.score} out of 10`}>
      <b>{rating.score}</b>
      <span className="meter-track">
        <span className="meter-fill" style={{ height: `${rating.score * 10}%` }} />
      </span>
    </div>
  );
}

export function ResultList({
  results,
  order,
  ratings,
  cited,
  icons,
  ratingsPending,
}: {
  results: SearchResult[];
  order: number[];
  ratings: Record<number, ResultRating>;
  cited: Set<number>;
  icons: FaviconMap;
  ratingsPending: boolean;
}) {
  const nodes = useRef(new Map<string, HTMLElement>());
  const tops = useRef(new Map<string, number>());
  const lastOrder = useRef("");
  const orderKey = order.join(",");

  // FLIP: when the order changes, slide each card from its old position to the new one.
  useLayoutEffect(() => {
    const next = new Map<string, number>();
    nodes.current.forEach((el, key) => next.set(key, el.getBoundingClientRect().top));
    const reordered = lastOrder.current !== "" && lastOrder.current !== orderKey;
    if (reordered && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
      next.forEach((top, key) => {
        const before = tops.current.get(key);
        const el = nodes.current.get(key);
        if (before === undefined || !el || Math.abs(before - top) < 1) return;
        el.animate([{ transform: `translateY(${before - top}px)` }, { transform: "none" }], { duration: 420, easing: "cubic-bezier(.2,.8,.2,1)" });
      });
    }
    tops.current = next;
    lastOrder.current = orderKey;
  });

  return (
    <ol className="results" aria-label="Results">
      {order.map((i) => {
        const r = results[i]!;
        const rating = ratings[i];
        const key = `${i}:${r.url}`;
        return (
          <li
            key={key}
            ref={(el) => {
              if (el) nodes.current.set(key, el);
              else nodes.current.delete(key);
            }}
            className={`result ${cited.has(i) ? "cited" : ""}`}
            data-rank={r.rank || i + 1}
          >
            <Meter rating={rating} pending={ratingsPending} />
            <div className="result-body">
              <div className="result-source">
                <Fav domain={r.source} icons={icons} />
                <span className="domain">{r.source}</span>
                <span className="path">{pathOf(r.url)}</span>
                <span className="n" title={cited.has(i) ? "Cited in the answer" : "Source number"}>
                  {i + 1}
                </span>
              </div>
              <h3>
                <a className="result-title" href={r.url} data-nav>
                  {r.title}
                </a>
              </h3>
              {rating?.summary ? (
                <p className="ai-summary">
                  <IconSparkle size={12} />
                  <span>{rating.summary}</span>
                </p>
              ) : (
                ratingsPending && <p className="ai-summary placeholder" aria-hidden="true" />
              )}
              {r.snippet && <p className="result-snippet">{r.snippet}</p>}
              {rating && rating.tags.length > 0 && (
                <div className="tags">
                  {rating.tags.map((t) => (
                    <span key={t} className={`tag ${TAG_TONE[t] ?? ""}`}>
                      {TAG_LABEL[t] ?? t}
                    </span>
                  ))}
                </div>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

export function ResultSkeleton({ count = 4 }: { count?: number }) {
  return (
    <div className="results" aria-hidden="true">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="result skeleton">
          <div className="meter empty pending">
            <b />
            <span className="meter-track" />
          </div>
          <div className="skeleton-lines">
            <span />
            <span />
            <span />
          </div>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------- verticals

function when(r: SearchResult): string | undefined {
  if (r.age) return r.age;
  if (!r.publishedAt) return undefined;
  const d = new Date(r.publishedAt);
  return Number.isNaN(d.getTime()) ? undefined : d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export function NewsList({ results, icons }: { results: SearchResult[]; icons: FaviconMap }) {
  return (
    <ol className="news" aria-label="News">
      {results.map((r, i) => (
        <li key={`${r.url}-${i}`} className="news-item">
          <div className="news-body">
            <div className="news-meta">
              <Fav domain={r.source} icons={icons} size={14} />
              <span className="publisher">{r.publisher ?? r.source}</span>
              {when(r) && <time dateTime={r.publishedAt}>{when(r)}</time>}
            </div>
            <h3>
              <a href={r.url} data-nav>
                {r.title}
              </a>
            </h3>
            {r.snippet && <p>{r.snippet}</p>}
          </div>
          {r.thumbnail && <img className="news-thumb" src={r.thumbnail} alt="" loading="lazy" />}
        </li>
      ))}
    </ol>
  );
}

const ROW_HEIGHT = 180;

export function ImageGrid({ results, icons }: { results: SearchResult[]; icons: FaviconMap }) {
  return (
    <div className="image-grid" aria-label="Images">
      {results.map((r, i) => {
        const w = r.image?.width ?? 4;
        const h = r.image?.height ?? 3;
        const ratio = Math.min(2.4, Math.max(0.5, w / h));
        return (
          <a
            key={`${r.image?.src ?? r.url}-${i}`}
            className="image-tile"
            href={r.url}
            data-nav
            style={{ flexGrow: ratio, flexBasis: `${Math.round(ratio * ROW_HEIGHT)}px` }}
            title={r.title}
          >
            <img src={r.thumbnail ?? r.image?.src} alt={r.title} loading="lazy" />
            <span className="image-cap">
              <Fav domain={r.source} icons={icons} size={14} />
              <span className="image-site">{r.publisher ?? r.source}</span>
              {r.image?.width && r.image.height ? (
                <span className="image-size">
                  {r.image.width}×{r.image.height}
                </span>
              ) : null}
            </span>
          </a>
        );
      })}
      <span className="image-filler" aria-hidden="true" />
    </div>
  );
}

export function VideoGrid({ results, icons }: { results: SearchResult[]; icons: FaviconMap }) {
  return (
    <ol className="videos" aria-label="Videos">
      {results.map((r, i) => (
        <li key={`${r.url}-${i}`} className="video-card">
          <a href={r.url} data-nav className="video-thumb" aria-label={r.title}>
            {r.thumbnail ? <img src={r.thumbnail} alt="" loading="lazy" /> : <span className="video-blank" />}
            <span className="video-play" aria-hidden="true">
              <IconPlay size={18} />
            </span>
            {r.duration && <span className="video-duration">{r.duration}</span>}
          </a>
          <h3>
            <a href={r.url}>{r.title}</a>
          </h3>
          <div className="video-meta">
            <Fav domain={r.source} icons={icons} size={14} />
            <span>{r.publisher ?? r.source}</span>
            {when(r) && <time dateTime={r.publishedAt}>{when(r)}</time>}
          </div>
        </li>
      ))}
    </ol>
  );
}

// ---------------------------------------------------------------------------- aside

export function EntityPanel({ entity, source, icons }: { entity: EntityCard; source?: SearchResult; icons: FaviconMap }) {
  return (
    <section className="entity-card" aria-labelledby="entity-title">
      <h2 id="entity-title">{entity.title}</h2>
      {entity.description && <p>{entity.description}</p>}
      {entity.facts.length > 0 && (
        <dl>
          {entity.facts.map((f, i) => (
            <div key={i}>
              <dt>{f.label}</dt>
              <dd>{f.value}</dd>
            </div>
          ))}
        </dl>
      )}
      {source && (
        <a className="entity-source" href={source.url}>
          <Fav domain={source.source} icons={icons} size={14} />
          {source.source}
        </a>
      )}
    </section>
  );
}

export function RelatedQuestions({ questions, onPick }: { questions: string[]; onPick: (q: string) => void }) {
  return (
    <section className="related" aria-labelledby="related-title">
      <h2 id="related-title">Related searches</h2>
      <ul>
        {questions.map((q) => (
          <li key={q}>
            <button type="button" onClick={() => onPick(q)}>
              <IconSearch size={14} />
              <span>{q}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function FooterStat({ label, children }: { label: string; children: ReactNode }) {
  return (
    <span className="stat">
      <span className="stat-label">{label}</span>
      <span className="stat-value">{children}</span>
    </span>
  );
}
