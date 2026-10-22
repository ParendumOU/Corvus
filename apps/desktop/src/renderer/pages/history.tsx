import { useCallback, useEffect, useState } from "react";
import type { HistoryRecord } from "../../shared/history-ops";
import { internalApi } from "../common/api";
import { IconTrash } from "../common/icons";
import { Favicon, dayLabel, formatTime, hostOf } from "../common/ui";
import { RemoteTabs } from "./remote-tabs";
import { PageShell, mount } from "./shell";

const PAGE_SIZE = 100;

function HistoryPage() {
  const api = internalApi();
  const [query, setQuery] = useState("");
  const [entries, setEntries] = useState<HistoryRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());

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

  const groups: Array<{ day: string; items: HistoryRecord[] }> = [];
  for (const e of entries) {
    const day = dayLabel(e.visitedAt);
    const last = groups[groups.length - 1];
    if (last?.day === day) last.items.push(e);
    else groups.push({ day, items: [e] });
  }

  return (
    <PageShell
      title="History"
      active="history"
      toolbar={
        <>
          <input className="input" placeholder="Search history" value={query} onChange={(e) => setQuery(e.target.value)} />
          {selected.size > 0 && (
            <button className="btn small danger" onClick={() => remove([...selected])}>
              Delete {selected.size}
            </button>
          )}
          <button
            className="btn small"
            onClick={() => {
              if (confirm("Clear all browsing history for this profile?")) void api.call("history.clear").then(() => load("", 0));
            }}
          >
            Clear history
          </button>
        </>
      }
    >
      {!query && <RemoteTabs />}
      {entries.length === 0 ? (
        <div className="card">
          <div className="empty">{query ? "No history matches your search." : "Pages you visit will appear here."}</div>
        </div>
      ) : (
        groups.map((g) => (
          <div key={g.day} className="card">
            <div className="day-head">{g.day}</div>
            <div className="list">
              {g.items.map((e) => (
                <div key={e.id} className="list-row">
                  <input
                    type="checkbox"
                    checked={selected.has(e.id)}
                    onChange={(ev) =>
                      setSelected((s) => {
                        const next = new Set(s);
                        if (ev.target.checked) next.add(e.id);
                        else next.delete(e.id);
                        return next;
                      })
                    }
                  />
                  <span className="mono muted" style={{ width: 48 }}>
                    {formatTime(e.visitedAt)}
                  </span>
                  <Favicon url={e.url} src={e.faviconUrl} />
                  <div className="grow">
                    <a className="title" href={e.url} title={e.url}>
                      {e.title || e.url}
                    </a>
                    <div className="sub">
                      {hostOf(e.url)}
                      {e.visitCount > 1 ? ` · ${e.visitCount} visits` : ""}
                    </div>
                  </div>
                  <div className="actions">
                    <button className="icon-btn" title="Remove from history" onClick={() => remove([e.id])}>
                      <IconTrash size={15} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))
      )}
      {entries.length < total && (
        <button className="btn" style={{ alignSelf: "center" }} onClick={() => load(query, entries.length)}>
          Show more
        </button>
      )}
    </PageShell>
  );
}

mount(<HistoryPage />);
