import { useCallback, useEffect, useState, type ReactNode } from "react";
import {
  downloadActions,
  downloadProgress,
  downloadStatus,
  type DownloadAction,
  type DownloadRecord,
} from "../../shared/downloads";
import { errorMessage, internalApi } from "../common/api";
import { IconAgent, IconClose, IconFile, IconFolder, IconPause, IconPlay, IconReload, IconTrash, IconWarning } from "../common/icons";
import { dayLabel, formatTime, hostOf } from "../common/ui";
import { GrabberView } from "./downloads-grabber";
import { QueueSection } from "./downloads-queue";
import "./downloads.css";
import { PageShell, mount } from "./shell";

import { t } from "../common/i18n";
const ICON_ACTIONS: Partial<Record<DownloadAction, { title: string; icon: ReactNode }>> = {
  pause: { title: t("Pause"), icon: <IconPause size={15} /> },
  resume: { title: t("Resume"), icon: <IconPlay size={15} /> },
  cancel: { title: t("Cancel"), icon: <IconClose size={15} /> },
  retry: { title: t("Retry"), icon: <IconReload size={15} /> },
  show: { title: t("Show in folder"), icon: <IconFolder size={15} /> },
  remove: { title: t("Remove from list"), icon: <IconTrash size={15} /> },
};

type View = "downloads" | "grabber";

function DownloadsPage() {
  const [view, setView] = useState<View>(location.hash === "#grabber" ? "grabber" : "downloads");
  useEffect(() => {
    const onHash = (): void => setView(location.hash === "#grabber" ? "grabber" : "downloads");
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  const tabs = (
    <div className="segmented" role="tablist">
      {(["downloads", "grabber"] as const).map((v) => (
        <button
          key={v}
          role="tab"
          aria-selected={view === v}
          className={view === v ? "on" : ""}
          data-view={v}
          onClick={() => {
            history.replaceState(null, "", v === "grabber" ? "#grabber" : "#");
            setView(v);
          }}
        >
          {v === "grabber" ? t("Link grabber") : t("Downloads")}
        </button>
      ))}
    </div>
  );
  if (view === "grabber") {
    return (
      <PageShell title={t("Downloads")} active="downloads" toolbar={tabs}>
        <GrabberView />
      </PageShell>
    );
  }
  return <DownloadsList tabs={tabs} />;
}

function DownloadsList({ tabs }: { tabs: ReactNode }) {
  const api = internalApi();
  const [list, setList] = useState<DownloadRecord[] | null>(null);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    void api.call("downloads.list").then(setList);
  }, [api]);
  useEffect(() => {
    load();
    return api.onEvent((e) => {
      if (e.type === "downloads-changed") load();
    });
  }, [api, load]);

  const act = (id: string, action: DownloadAction): void => {
    setError(null);
    api
      .call("downloads.act", id, action)
      .then(load)
      .catch((e: unknown) => setError(errorMessage(e)));
  };

  const q = query.trim().toLowerCase();
  const shown = (list ?? []).filter((d) => !q || d.filename.toLowerCase().includes(q) || d.url.toLowerCase().includes(q));
  const groups: Array<{ day: string; items: DownloadRecord[] }> = [];
  for (const d of shown) {
    const day = dayLabel(d.startedAt);
    const last = groups[groups.length - 1];
    if (last?.day === day) last.items.push(d);
    else groups.push({ day, items: [d] });
  }

  return (
    <PageShell
      title={t("Downloads")}
      active="downloads"
      toolbar={
        <>
          {tabs}
          <input className="input" placeholder={t("Search downloads")} value={query} onChange={(e) => setQuery(e.target.value)} />
          <button className="btn small" disabled={!list || list.length === 0} onClick={() => void api.call("downloads.clear").then(load)}>{t("Clear all")}</button>
        </>
      }
    >
      {error && <div className="notice error">{error}</div>}
      <QueueSection />
      {list && shown.length === 0 ? (
        <div className="card">
          <div className="empty">{q ? t("No downloads match your search.") : t("Files you download will appear here.")}</div>
        </div>
      ) : (
        groups.map((g) => (
          <div key={g.day} className="card">
            <div className="day-head">{g.day}</div>
            <div className="list">
              {g.items.map((d) => (
                <DownloadItemRow key={d.id} d={d} act={act} />
              ))}
            </div>
          </div>
        ))
      )}
    </PageShell>
  );
}

function DownloadItemRow({ d, act }: { d: DownloadRecord; act: (id: string, action: DownloadAction) => void }) {
  const progress = downloadProgress(d);
  const running = d.state === "progressing" || d.state === "paused";
  return (
    <div className={`list-row download-row ${d.state}`}>
      <span className="mono muted" style={{ width: 64 }}>
        {formatTime(d.startedAt)}
      </span>
      <span className="download-icon">{d.state === "blocked" ? <IconWarning size={22} /> : <IconFile size={22} />}</span>
      <div className="grow">
        {d.state === "completed" ? (
          <button className="link-button title" title={d.savePath} onClick={() => act(d.id, "open")}>
            {d.filename}
          </button>
        ) : (
          <span className="title">{d.filename}</span>
        )}
        <div className="sub">
          <a href={d.url} title={d.url}>
            {hostOf(d.url) || d.url.slice(0, 80)}
          </a>
          {" · "}
          {downloadStatus(d)}
          {d.agent && (
            <span className="pill agent-pill" title={t("Started from a tab driven by an AI agent")}>
              <IconAgent size={11} />{" "}{t("AI agent")}</span>
          )}
        </div>
        {running && (
          <div className="download-bar">
            <span style={{ width: progress === null ? "35%" : `${Math.round(progress * 100)}%` }} />
          </div>
        )}
        {d.state === "blocked" && (
          <div className="inline" style={{ marginTop: 8 }}>
            <span className="muted small">{t("This file can run code on your computer. Keep it only if you trust the site.")}</span>
            <button className="btn small danger" onClick={() => act(d.id, "discard")}>{t("Discard")}</button>
            <button className="btn small" onClick={() => act(d.id, "keep")}>{t("Keep anyway")}</button>
          </div>
        )}
      </div>
      <div className="actions download-actions">
        {downloadActions(d).map((a) => {
          const ui = ICON_ACTIONS[a];
          return ui ? (
            <button key={a} className="icon-btn" title={ui.title} onClick={() => act(d.id, a)}>
              {ui.icon}
            </button>
          ) : null;
        })}
      </div>
    </div>
  );
}

mount(<DownloadsPage />);
