import { useEffect, useState } from "react";
import { liveSourceName, type LiveHistoryPatch, type LiveHistorySource, type LiveHistoryView } from "../../shared/live-history";
import { errorMessage, internalApi } from "../common/api";
import { t } from "../common/i18n";
import { SourceBadge, Toggle, formatTime } from "../common/ui";
import "./settings-live-history.css";
import { Row, Section } from "./shell";

function statusLine(source: LiveHistorySource): string {
  const s = source.status;
  if (!s) return "";
  if (s.error) return t("Could not read it at {time}: {error}", { time: formatTime(s.readAt), error: s.error });
  if (s.added === 0) return t("Read at {time}: nothing new.", { time: formatTime(s.readAt) });
  return s.added === 1 ? t("Read at {time}: 1 new page.", { time: formatTime(s.readAt) }) : t("Read at {time}: {n} new pages.", { time: formatTime(s.readAt), n: s.added.toLocaleString() });
}

/**
 * Live history from other browsers: pages opened in the chosen browser profiles come into this
 * profile's history and address bar suggestions, on this computer only.
 */
export function LiveHistorySection() {
  const api = internalApi();
  const [view, setView] = useState<LiveHistoryView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api
      .call("liveHistory.view")
      .then(setView)
      .catch((e: unknown) => setError(errorMessage(e)));
  }, [api]);

  const run = (p: Promise<LiveHistoryView>): void => {
    setBusy(true);
    setError(null);
    p.then(setView)
      .catch((e: unknown) => setError(errorMessage(e)))
      .finally(() => setBusy(false));
  };
  const set = (patch: LiveHistoryPatch): void => run(api.call("liveHistory.set", patch));
  const followed = view ? view.sources.filter((s) => s.followed).map((s) => s.key) : [];
  // Turned on with nothing chosen yet: each browser's default profile.
  const turn = (on: boolean): void => {
    if (!view) return;
    const defaults = view.sources.filter((s) => s.isDefault || !view.sources.some((o) => o.browser === s.browser && o.isDefault)).map((s) => s.key);
    set(on && followed.length === 0 ? { enabled: true, sources: defaults } : { enabled: on });
  };
  const choose = (key: string, on: boolean): void => set({ sources: on ? [...followed, key] : followed.filter((k) => k !== key) });
  const marks = view ? Object.keys(view.counts).filter((m) => (view.counts[m] ?? 0) > 0) : [];

  return (
    <Section
      id="live-history"
      title={t("Live history from other browsers")}
      description={t("See the pages you open in Chrome, Edge, Brave, Opera, Vivaldi or Firefox in Corvus's history and address bar suggestions as soon as you switch to Corvus, without importing again.")}
    >
      <div data-live-history>
        <Row
          label={t("Follow other browsers' history")}
          hint={t("Those browsers save their history to disk every few seconds, so a page you just opened can take a few seconds to show up. Their files are only read, from a copy, and only when they changed.")}
        >
          <Toggle checked={view?.enabled === true} disabled={!view || busy} onChange={turn} label={t("Follow other browsers' history")} />
        </Row>
        {view && view.sources.length === 0 && (
          <Row label={t("No other browsers found for this user.")} />
        )}
        {view && view.sources.length > 0 && (
          <div className="live-sources">
            {view.sources.map((s) => (
              <label key={s.key} className={`live-source ${view.enabled ? "" : "off"}`} data-live-source={s.key}>
                <input type="checkbox" checked={s.followed} disabled={!view.enabled || busy} onChange={(e) => choose(s.key, e.target.checked)} />
                <SourceBadge source={s.mark} size={16} />
                <span className="grow">
                  <span className="live-source-name">
                    {s.profileName === s.browserName ? s.browserName : `${s.browserName} · ${s.profileName}`}
                    {s.isDefault && s.profileName !== s.browserName && <span className="pill">{t("default")}</span>}
                  </span>
                  {view.enabled && s.followed && s.status && <span className={`muted small live-status ${s.status.error ? "bad" : ""}`}>{statusLine(s)}</span>}
                </span>
              </label>
            ))}
          </div>
        )}
        {marks.map((mark) => (
          <Row
            key={mark}
            label={
              <span className="live-count" data-live-count={mark}>
                <SourceBadge source={mark} size={16} />
                {view!.counts[mark] === 1 ? t("1 page from {browser} in your history", { browser: liveSourceName(mark) }) : t("{n} pages from {browser} in your history", { n: (view!.counts[mark] ?? 0).toLocaleString(), browser: liveSourceName(mark) })}
              </span>
            }
            hint={t("Pages you also opened in Corvus are Corvus's own and stay.")}
          >
            <button className="btn small danger" disabled={busy} data-live-forget={mark} onClick={() => run(api.call("liveHistory.forget", mark))}>
              {t("Forget visits from {browser}", { browser: liveSourceName(mark) })}
            </button>
          </Row>
        ))}
        <p className="muted small live-privacy">
          {t("These pages stay on this computer: they are not synced to your other devices. Private and incognito windows of the other browsers save no history, so nothing of them comes in.")}
        </p>
        {error && <div className="notice error">{error}</div>}
      </div>
    </Section>
  );
}
