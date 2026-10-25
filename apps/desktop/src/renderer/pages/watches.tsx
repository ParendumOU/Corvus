import { useCallback, useEffect, useState } from "react";
import { MIN_INTERVAL_MINUTES } from "../../shared/page-watch";
import type { WatchView } from "../../shared/watch-ipc";
import { errorMessage, internalApi } from "../common/api";
import { IconBell, IconPause, IconPlay, IconReload, IconTrash } from "../common/icons";
import { Favicon, formatTime, hostOf } from "../common/ui";
import "./watches.css";
import { PageShell, mount } from "./shell";

import { t } from "../common/i18n";
const INTERVALS: Array<[number, string]> = [
  [MIN_INTERVAL_MINUTES, t("Every 5 minutes")],
  [15, t("Every 15 minutes")],
  [30, t("Every 30 minutes")],
  [60, t("Hourly")],
  [180, t("Every 3 hours")],
  [360, t("Every 6 hours")],
  [720, t("Every 12 hours")],
  [1440, t("Daily")],
];

function ago(ms: number | null): string {
  if (ms === null) return t("not yet");
  const diff = Date.now() - ms;
  if (diff < 60_000) return t("just now");
  const mins = Math.round(diff / 60_000);
  if (mins < 60) return t("{mins} min ago", { mins });
  const hours = Math.round(mins / 60);
  if (hours < 24) return t("{hours} h ago", { hours });
  return t("{hours} d ago", { hours: Math.round(hours / 24) });
}

function statusLabel(w: WatchView): { text: string; cls: string } {
  if (w.checking) return { text: t("Checking…"), cls: "checking" };
  if (w.paused) return { text: t("Paused"), cls: "paused" };
  if (w.lastResult === "error") return { text: w.lastError ? t("Error: {lastError}", { lastError: w.lastError }) : t("Error"), cls: "error" };
  if (w.lastResult === "changed") return { text: t("Changed"), cls: "changed" };
  if (w.lastResult === "ok") return { text: t("No change"), cls: "ok" };
  return { text: t("Waiting for first check…"), cls: "pending" };
}

function WatchesPage() {
  const api = internalApi();
  const [list, setList] = useState<WatchView[] | null>(null);
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    void api.call("watch.list").then(setList);
  }, [api]);
  useEffect(() => {
    load();
    return api.onEvent((e) => {
      if (e.type === "watches-changed") load();
    });
  }, [api, load]);

  const run = (p: Promise<WatchView[]>): void => {
    setError(null);
    p.then(setList).catch((e: unknown) => setError(errorMessage(e)));
  };

  const add = (): void => {
    const trimmed = url.trim();
    if (!trimmed) return;
    const target = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    run(api.call("watch.add", target).then((l) => (setUrl(""), l)));
  };

  const watches = list ?? [];
  const unseen = watches.filter((w) => w.unseen).length;

  return (
    <PageShell
      title={t("Watched pages")}
      active="watches"
      toolbar={
        <>
          {unseen > 0 && (
            <button className="btn small" onClick={() => run(api.call("watch.acknowledge"))}>{t("Mark all seen ({unseen})", { unseen })}</button>
          )}
          <a className="btn small ghost" href="corvus://settings/#monitoring">{t("Settings")}</a>
        </>
      }
    >
      {error && <div className="notice error">{error}</div>}
      <div className="card">
        <div className="card-head">
          <h2>{t("Watch a page for changes")}</h2>
          <p className="muted">{t("Corvus re-fetches the page on a schedule, detects meaningful changes to its main text and writes a short AI summary of what changed. Give a watch a condition (“Notify me when the price is under 150 €”) and it tells you only when that comes true. Only public http(s) pages, read-only.")}</p>
        </div>
        <div className="card-body">
          <div className="watch-add">
            <input
              className="input grow"
              placeholder={t("https://example.com/product")}
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && add()}
            />
            <button className="btn small primary" disabled={!url.trim()} onClick={add}>{t("Watch page")}</button>
          </div>
        </div>
      </div>

      {list && watches.length === 0 ? (
        <div className="card">
          <div className="empty">
            <IconBell size={26} />
            <p>{t("Nothing is being watched yet. Add a URL above, or use “Watch this page for changes” from a tab or page menu.")}</p>
          </div>
        </div>
      ) : (
        <div className="card">
          <div className="list">
            {watches.map((w) => (
              <WatchRow key={w.id} w={w} api={api} run={run} />
            ))}
          </div>
        </div>
      )}
    </PageShell>
  );
}

function WatchRow({ w, api, run }: { w: WatchView; api: ReturnType<typeof internalApi>; run: (p: Promise<WatchView[]>) => void }) {
  const status = statusLabel(w);
  return (
    <div className={`list-row watch-row ${w.unseen ? "unseen" : ""}`}>
      <span className="watch-fav">
        <Favicon url={w.url} src={w.faviconUrl} size={18} />
      </span>
      <div className="grow watch-main">
        <div className="watch-title-row">
          <button className="link-button watch-title" title={w.url} onClick={() => void api.call("watch.open", w.id, "new-tab")}>
            {w.title || hostOf(w.url)}
          </button>
          <span className={`pill watch-status ${status.cls}`}>{status.text}</span>
          {w.unseen && <span className="pill watch-new">{t("New")}</span>}
        </div>
        <div className="sub muted">{t("{hostOf} · checked {ago}", { hostOf: hostOf(w.url), ago: ago(w.lastCheckedAt) })}{w.lastChangedAt ? t(" · changed {lastChangedAt}", { lastChangedAt: ago(w.lastChangedAt) }) : ""}
        </div>
        {w.changeSummary && w.lastResult === "changed" && (
          <div className="watch-summary">
            <span className="watch-summary-label">{w.condition ? t("Now true") : t("What changed")}</span>
            {w.changeSummary}
          </div>
        )}
        <ConditionField w={w} api={api} run={run} />
      </div>
      <div className="watch-actions">
        <select
          className="input small"
          value={w.intervalMinutes}
          title={t("Check interval")}
          onChange={(e) => run(api.call("watch.setInterval", w.id, Number(e.target.value)))}
        >
          {INTERVALS.map(([m, label]) => (
            <option key={m} value={m}>
              {label}
            </option>
          ))}
        </select>
        <button className="icon-btn" title={t("Check now")} disabled={w.checking} onClick={() => run(api.call("watch.checkNow", w.id))}>
          <IconReload size={15} />
        </button>
        <button className="icon-btn" title={w.paused ? t("Resume") : t("Pause")} onClick={() => run(api.call("watch.pause", w.id, !w.paused))}>
          {w.paused ? <IconPlay size={15} /> : <IconPause size={15} />}
        </button>
        <button className="icon-btn" title={t("Stop watching")} onClick={() => run(api.call("watch.remove", w.id))}>
          <IconTrash size={15} />
        </button>
      </div>
    </div>
  );
}

/** "Notify me when…": a condition in the user's words, and where it stands. */
function ConditionField({ w, api, run }: { w: WatchView; api: ReturnType<typeof internalApi>; run: (p: Promise<WatchView[]>) => void }) {
  const [value, setValue] = useState(w.condition ?? "");
  useEffect(() => setValue(w.condition ?? ""), [w.condition]);
  const save = (): void => {
    if (value.trim() !== (w.condition ?? "")) run(api.call("watch.setCondition", w.id, value.trim()));
  };
  const state = w.condition === undefined ? null : w.conditionMet === true ? "met" : w.conditionMet === false ? "not-met" : "unknown";
  return (
    <div className="watch-condition">
      <label className="watch-condition-row">
        <span className="watch-summary-label">{t("Notify me when")}</span>
        <input
          className="input small grow"
          placeholder={t("Any change (or e.g. the price is under 150 €, it is back in stock)")}
          value={value}
          maxLength={300}
          onChange={(e) => setValue(e.target.value)}
          onBlur={save}
          onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
        />
      </label>
      {state && (
        <div className={`watch-condition-state ${state}`}>
          {state === "met" ? t("True now") : state === "not-met" ? t("Not yet") : t("Checking…")}
          {w.conditionDetail ? `: ${w.conditionDetail}` : ""}
        </div>
      )}
    </div>
  );
}

mount(<WatchesPage />);
