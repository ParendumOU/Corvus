import { useCallback, useEffect, useState } from "react";
import type { HistoryFilter, HistoryRecord } from "../../shared/history-ops";
import { internalApi } from "../common/api";
import { IconTrash } from "../common/icons";
import { Modal } from "../common/modal";
import { Favicon, dayLabel, formatTime, hostOf } from "../common/ui";
import { RemoteTabs } from "./remote-tabs";
import { PageShell, mount } from "./shell";

import { t } from "../common/i18n";
const PAGE_SIZE = 100;
const HOUR = 60 * 60 * 1000;

type Range = "hour" | "day" | "week" | "month" | "all";
const RANGES = (): Array<[Range, string, number]> => [
  ["hour", t("Last hour"), HOUR],
  ["day", t("Last 24 hours"), 24 * HOUR],
  ["week", t("Last 7 days"), 7 * 24 * HOUR],
  ["month", t("Last 4 weeks"), 28 * 24 * HOUR],
  ["all", t("All time"), 0],
];

/** "Clear history…": a time range, and optionally only what the search shows or one site. */
function ClearHistory({ query, onClose, onCleared }: { query: string; onClose: () => void; onCleared: () => void }) {
  const api = internalApi();
  const [range, setRange] = useState<Range>("hour");
  const [onlySearch, setOnlySearch] = useState(query.trim() !== "");
  const [site, setSite] = useState("");
  const [count, setCount] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  const filter = useCallback((): HistoryFilter => {
    const ms = RANGES().find(([r]) => r === range)?.[2] ?? 0;
    return {
      ...(ms > 0 ? { since: Date.now() - ms } : {}),
      ...(onlySearch && query.trim() ? { query } : {}),
      ...(site.trim() ? { site } : {}),
    };
  }, [range, onlySearch, query, site]);

  useEffect(() => {
    const timer = setTimeout(() => void api.call("history.countMatching", filter()).then(setCount), 120);
    return () => clearTimeout(timer);
  }, [api, filter]);

  const clear = (): void => {
    setBusy(true);
    void api
      .call("history.removeMatching", filter())
      .then(onCleared)
      .finally(() => setBusy(false));
  };

  return (
    <Modal
      title={t("Clear browsing history")}
      onClose={onClose}
      footer={
        <>
          <span className="grow muted small">
            {count === null ? "" : count === 1 ? t("1 page will be removed.") : t("{n} pages will be removed.", { n: count.toLocaleString() })}
          </span>
          <button className="btn" onClick={onClose}>
            {t("Cancel")}
          </button>
          <button className="btn danger-solid" disabled={busy || count === 0} onClick={clear}>
            {t("Clear history")}
          </button>
        </>
      }
    >
      <div className="modal-field">
        <span>{t("Time range")}</span>
        <div className="segmented history-ranges">
          {RANGES().map(([r, label]) => (
            <button key={r} className={r === range ? "on" : ""} onClick={() => setRange(r)}>
              {label}
            </button>
          ))}
        </div>
      </div>
      {query.trim() && (
        <label className="modal-check">
          <input type="checkbox" checked={onlySearch} onChange={(e) => setOnlySearch(e.target.checked)} />
          <span>{t("Only pages matching “{query}”", { query: query.trim() })}</span>
        </label>
      )}
      <label className="modal-field">
        <span>{t("Only this site (optional)")}</span>
        <input className="input" placeholder="example.com" value={site} onChange={(e) => setSite(e.target.value)} spellCheck={false} />
      </label>
      <p className="muted small" style={{ margin: 0 }}>
        {t("With sync on, the pages are removed from your other devices too.")}
      </p>
    </Modal>
  );
}

function HistoryPage() {
  const api = internalApi();
  const [query, setQuery] = useState("");
  const [entries, setEntries] = useState<HistoryRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [clearing, setClearing] = useState(false);

  const load = useCallback(
    (q: string, offset: number) => {
      void api.call("history.query", q, offset, PAGE_SIZE).then((res) => {
        setEntries((prev) => (offset === 0 ? res.entries : [...prev, ...res.entries]));
        setTotal(res.total);
      });
    },
    [api],
  );

  useEffect(() => {
    const timer = setTimeout(() => load(query, 0), 120);
    return () => clearTimeout(timer);
  }, [query, load]);

  const remove = (ids: string[]): void => {
    void api.call("history.remove", ids).then(() => {
      setSelected(new Set());
      load(query, 0);
    });
  };

  const toggle = (ids: string[], on: boolean): void =>
    setSelected((s) => {
      const next = new Set(s);
      for (const id of ids) {
        if (on) next.add(id);
        else next.delete(id);
      }
      return next;
    });

  const groups: Array<{ day: string; items: HistoryRecord[] }> = [];
  for (const e of entries) {
    const day = dayLabel(e.visitedAt);
    const last = groups[groups.length - 1];
    if (last?.day === day) last.items.push(e);
    else groups.push({ day, items: [e] });
  }
  const allShown = entries.length > 0 && entries.every((e) => selected.has(e.id));

  return (
    <PageShell
      title={t("History")}
      active="history"
      toolbar={
        <>
          <input className="input" placeholder={t("Search history")} value={query} onChange={(e) => setQuery(e.target.value)} />
          <button className="btn small" onClick={() => setClearing(true)}>
            {t("Clear history…")}
          </button>
        </>
      }
    >
      {!query && <RemoteTabs />}
      {entries.length > 0 && (
        <div className="history-selectbar">
          <label className="modal-check">
            <input type="checkbox" checked={allShown} onChange={(e) => toggle(entries.map((x) => x.id), e.target.checked)} />
            <span>{selected.size > 0 ? t("{size} selected", { size: selected.size }) : t("Select all shown")}</span>
          </label>
          {selected.size > 0 && (
            <>
              <button className="btn small danger" onClick={() => remove([...selected])}>
                {t("Delete {size}", { size: selected.size })}
              </button>
              <button className="btn small ghost" onClick={() => setSelected(new Set())}>
                {t("Clear selection")}
              </button>
            </>
          )}
          <span className="grow" />
          <span className="muted small">{query ? t("{n} results", { n: total.toLocaleString() }) : t("{n} pages", { n: total.toLocaleString() })}</span>
        </div>
      )}
      {entries.length === 0 ? (
        <div className="card">
          <div className="empty">{query ? t("No history matches your search.") : t("Pages you visit will appear here.")}</div>
        </div>
      ) : (
        groups.map((g) => {
          const dayIds = g.items.map((e) => e.id);
          const dayAll = dayIds.every((id) => selected.has(id));
          return (
            <div key={g.day} className="card">
              <label className="day-head history-day">
                <input type="checkbox" checked={dayAll} onChange={(e) => toggle(dayIds, e.target.checked)} title={t("Select this day")} />
                <span>{g.day}</span>
              </label>
              <div className="list">
                {g.items.map((e) => (
                  <div key={e.id} className={`list-row ${selected.has(e.id) ? "selected" : ""}`}>
                    <input type="checkbox" checked={selected.has(e.id)} onChange={(ev) => toggle([e.id], ev.target.checked)} />
                    <span className="mono muted" style={{ minWidth: 48, whiteSpace: "nowrap" }}>
                      {formatTime(e.visitedAt)}
                    </span>
                    <Favicon url={e.url} src={e.faviconUrl} />
                    <div className="grow">
                      <a className="title" href={e.url} title={e.url}>
                        {e.title || e.url}
                      </a>
                      <div className="sub">
                        {hostOf(e.url)}
                        {e.visitCount > 1 ? t(" · {visitCount} visits", { visitCount: e.visitCount }) : ""}
                      </div>
                    </div>
                    <div className="actions">
                      <button className="icon-btn" title={t("Remove from history")} onClick={() => remove([e.id])}>
                        <IconTrash size={15} />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          );
        })
      )}
      {entries.length < total && (
        <button className="btn" style={{ alignSelf: "center" }} onClick={() => load(query, entries.length)}>
          {t("Show more")}
        </button>
      )}
      {clearing && (
        <ClearHistory
          query={query}
          onClose={() => setClearing(false)}
          onCleared={() => {
            setClearing(false);
            setSelected(new Set());
            load(query, 0);
          }}
        />
      )}
    </PageShell>
  );
}

mount(<HistoryPage />);
