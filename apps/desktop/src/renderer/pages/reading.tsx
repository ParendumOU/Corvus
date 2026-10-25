import { useCallback, useEffect, useState } from "react";
import type { ReadingSummary } from "../../shared/reading";
import { internalApi } from "../common/api";
import { IconBook, IconDownload, IconTrash } from "../common/icons";
import { Favicon, dayLabel, hostOf } from "../common/ui";
import { PageShell, mount } from "./shell";

import { t } from "../common/i18n";
function ReadingPage() {
  const api = internalApi();
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<ReadingSummary[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const load = useCallback((q: string) => void api.call("reading.list", q).then(setItems), [api]);

  useEffect(() => {
    const timer = setTimeout(() => load(query), 120);
    return () => clearTimeout(timer);
  }, [query, load]);

  const remove = (id: string): void => void api.call("reading.remove", id).then(() => load(query));

  const groups: Array<{ day: string; items: ReadingSummary[] }> = [];
  for (const item of items) {
    const day = dayLabel(item.savedAt);
    const last = groups[groups.length - 1];
    if (last?.day === day) last.items.push(item);
    else groups.push({ day, items: [item] });
  }

  return (
    <PageShell
      title={t("Reading list")}
      active="reading"
      toolbar={<input className="input" placeholder={t("Search saved articles")} value={query} onChange={(e) => setQuery(e.target.value)} />}
    >
      {items.length === 0 ? (
        <div className="card">
          <div className="empty">
            {query ? t("No saved articles match your search.") : t("Open a page in reader mode and choose Save to keep it here for later.")}
          </div>
        </div>
      ) : (
        groups.map((g) => (
          <div key={g.day} className="card">
            <div className="day-head">{g.day}</div>
            <div className="list">
              {g.items.map((item) => {
                const open = expanded.has(item.id);
                const read = item.readAt !== undefined;
                const linkOnly = item.wordCount === 0 && !item.excerpt;
                return (
                  <div key={item.id} className="list-row" style={{ alignItems: "flex-start", opacity: read ? 0.65 : 1 }} data-reading-url={item.url}>
                    <Favicon url={item.url} />
                    <div className="grow">
                      <a className="title" href={item.url} title={item.url}>
                        {item.title || item.url}
                      </a>
                      <div className="sub">
                        {item.siteName || hostOf(item.url)}
                        {item.byline ? ` · ${item.byline}` : ""}
                        {linkOnly ? t(" · link only (Corvus fetches the article when it can)") : t(" · {readingMinutes} min read", { readingMinutes: item.readingMinutes })}
                        {read ? t(" · read") : ""}
                      </div>
                      {item.excerpt && <div className="sub" style={{ marginTop: 4 }}>{item.excerpt}</div>}
                      {item.keyPoints.length > 0 && (
                        <>
                          <button className="btn small ghost" style={{ marginTop: 6 }} onClick={() => setExpanded((s) => {
                            const next = new Set(s);
                            if (next.has(item.id)) next.delete(item.id);
                            else next.add(item.id);
                            return next;
                          })}>
                            <IconBook size={13} /> {open ? t("Hide") : t("Show")}{" "}{t("key points ({length})", { length: item.keyPoints.length })}</button>
                          {open && (
                            <ul style={{ margin: "8px 0 0", paddingLeft: 18 }}>
                              {item.keyPoints.map((p, i) => (
                                <li key={i} style={{ marginBottom: 4 }}>
                                  {p}
                                </li>
                              ))}
                            </ul>
                          )}
                        </>
                      )}
                    </div>
                    <div className="actions">
                      <button className="btn small ghost" data-reading-toggle onClick={() => void api.call("reading.setRead", item.id, !read).then(() => load(query))}>
                        {read ? t("Mark unread") : t("Mark read")}
                      </button>
                      <button className="icon-btn" title={t("Export as Markdown")} onClick={() => void api.call("reading.export", item.id)}>
                        <IconDownload size={15} />
                      </button>
                      <button className="icon-btn" title={t("Remove from reading list")} onClick={() => remove(item.id)}>
                        <IconTrash size={15} />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ))
      )}
    </PageShell>
  );
}

mount(<ReadingPage />);
