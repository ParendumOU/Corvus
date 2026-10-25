import { useCallback, useEffect, useRef, useState } from "react";
import type { SemanticHit, SemanticSearchStatus } from "../../shared/semantic-search-ipc";
import { internalApi } from "../common/api";
import { IconBook, IconHistory, IconSearch, IconStar } from "../common/icons";
import { Favicon, hostOf } from "../common/ui";
import { PageShell, mount } from "./shell";

import { t } from "../common/i18n";
const KIND_LABEL: Record<SemanticHit["kind"], string> = { history: t("History"), bookmark: t("Bookmark"), reading: t("Reading list") };

function KindIcon({ kind }: { kind: SemanticHit["kind"] }) {
  if (kind === "bookmark") return <IconStar size={13} filled />;
  if (kind === "reading") return <IconBook size={13} />;
  return <IconHistory size={13} />;
}

function FindPage() {
  const api = internalApi();
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SemanticHit[]>([]);
  const [status, setStatus] = useState<SemanticSearchStatus | null>(null);
  const [searched, setSearched] = useState(false);
  const [usedEmbeddings, setUsedEmbeddings] = useState(false);
  const [embeddingError, setEmbeddingError] = useState<string | undefined>(undefined);
  const request = useRef(0);

  useEffect(() => {
    void api.call("localSearch.status").then(setStatus);
  }, [api]);

  const run = useCallback(
    (q: string) => {
      const id = ++request.current;
      if (!q.trim()) {
        setHits([]);
        setSearched(false);
        return;
      }
      void api.call("localSearch.query", q, 25).then((res) => {
        if (id !== request.current) return;
        setHits(res.hits);
        setUsedEmbeddings(res.usedEmbeddings);
        setEmbeddingError(res.embeddingError);
        setSearched(true);
        setStatus((s) => (s ? { ...s, indexed: res.indexed } : s));
      });
    },
    [api],
  );

  useEffect(() => {
    const timer = setTimeout(() => run(query), 150);
    return () => clearTimeout(timer);
  }, [query, run]);

  return (
    <PageShell
      title={t("Find in my pages")}
      active="find"
      toolbar={
        <input
          className="input"
          autoFocus
          placeholder={t("Find a page you've seen, saved or bookmarked…")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      }
    >
      <div className="card">
        <div className="muted small" style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <IconSearch size={14} />
          <span>
            {status ? t("{count} pages indexed", { count: status.indexed.toLocaleString() }) : t("Loading index…")}
            {query.trim() && searched ? (usedEmbeddings ? t(" · semantic + keyword ranking") : t(" · keyword ranking")) : ""}
            {status && !status.embeddingsEnabled ? t(" · enable semantic ranking in Settings") : ""}
          </span>
        </div>
        {embeddingError && query.trim() && (
          <div className="muted small" style={{ marginTop: 6 }}>{t("Semantic re-rank unavailable ({embeddingError}); showing keyword results.", { embeddingError })}</div>
        )}
      </div>

      {query.trim() && searched && hits.length === 0 ? (
        <div className="card">
          <div className="empty">{t("No matches yet. Try different words — pages are added as you browse, bookmark and save.")}</div>
        </div>
      ) : (
        hits.length > 0 && (
          <div className="card">
            <div className="list">
              {hits.map((hit) => (
                <div key={hit.id} className="list-row" style={{ alignItems: "flex-start" }}>
                  <Favicon url={hit.url} />
                  <div className="grow">
                    <a className="title" href={hit.url} title={hit.url}>
                      {hit.title || hit.url}
                    </a>
                    <div className="sub" style={{ display: "flex", gap: 6, alignItems: "center" }}>
                      <KindIcon kind={hit.kind} />
                      <span>{KIND_LABEL[hit.kind]}</span>
                      <span>· {hostOf(hit.url)}</span>
                    </div>
                    {hit.snippet && (
                      <div className="sub" style={{ marginTop: 4 }}>
                        {hit.snippet}
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )
      )}

      {!query.trim() && (
        <div className="card">
          <div className="empty">{t("Search your own browsing — history, bookmarks and saved articles — by meaning, not just exact words.")}</div>
        </div>
      )}
    </PageShell>
  );
}

mount(<FindPage />);
