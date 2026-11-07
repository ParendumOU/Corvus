import type { ReactNode } from "react";
import type { Confidence, SearchResult } from "@corvus/shared";
import { t as tx } from "../common/i18n";
import { IconPlay, IconWarning } from "../common/icons";
import { LetterIcon } from "../common/ui";

export type FaviconMap = Record<string, string | null>;

export function Fav({ domain, icons, size = 16 }: { domain: string; icons: FaviconMap; size?: number }) {
  const src = icons[domain.toLowerCase()];
  return src ? <img className="fav" src={src} width={size} height={size} alt="" draggable={false} /> : <LetterIcon text={domain} size={size} />;
}

const CONFIDENCE_LABEL: Record<Confidence, string> = { high: tx("High confidence"), medium: tx("Medium confidence"), low: tx("Low confidence") };
const CONFIDENCE_DOTS: Record<Confidence, number> = { high: 3, medium: 2, low: 1 };

export function ConfidenceBadge({ level }: { level: Confidence }) {
  return (
    <span className={`confidence ${level}`} title={tx("How well the sources support this answer")}>
      <span className="dots" aria-hidden="true">
        {[1, 2, 3].map((i) => (
          <i key={i} className={i <= CONFIDENCE_DOTS[level] ? "on" : ""} />
        ))}
      </span>
      {CONFIDENCE_LABEL[level]}
    </span>
  );
}

export function ErrorNote({ message, recoverable, children }: { message: string; recoverable: boolean; children?: ReactNode }) {
  return (
    <div className={`search-error ${recoverable ? "soft" : ""}`} role="alert">
      <IconWarning size={16} />
      <div>
        <strong>{recoverable ? tx("The AI answer stopped early.") : tx("Search failed.")}</strong> {message}
        {children}
      </div>
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
    <ol className="news" aria-label={tx("News")}>
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
    <div className="image-grid" aria-label={tx("Images")}>
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
    <ol className="videos" aria-label={tx("Videos")}>
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
