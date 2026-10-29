import { useCallback, useEffect, useState } from "react";
import type { McpActivityEntry, McpActivityView } from "../../shared/ipc";
import type { McpRateLimit, SettingsPatch, SettingsView } from "../../shared/settings";
import { errorMessage, internalApi } from "../common/api";
import { t } from "../common/i18n";
import { Pager, Toggle, formatTime } from "../common/ui";
import "./settings-agent-log.css";
import { Row } from "./shell";

type Props = { view: SettingsView; update: (p: SettingsPatch) => void };

const REFRESH_MS = 3000;
/** Recent calls shown at a time; the pager goes through the rest of the log. */
const CALLS_PAGE = 5;

function rateLimitOptions(): Array<{ value: McpRateLimit; label: string }> {
  return [
    { value: "strict", label: t("Strict: 1 call a second, bursts of 10") },
    { value: "standard", label: t("Standard: 5 calls a second, bursts of 30") },
    { value: "relaxed", label: t("Relaxed: 20 calls a second, bursts of 100") },
  ];
}

function OutcomePill({ entry }: { entry: McpActivityEntry }) {
  if (entry.outcome === "ok") return <span className="pill ok">{t("OK")}</span>;
  if (entry.outcome === "rate-limited") return <span className="pill warn">{t("Over the limit")}</span>;
  return <span className="pill bad">{t("Error")}</span>;
}

/**
 * Settings > AI agents: the per-session rate limit and the local log of agents' tool calls (per tool
 * over the last day, then the latest calls a page at a time), with CSV export.
 */
export function AgentActivityLog({ view, update }: Props) {
  const api = internalApi();
  const mcp = view.settings.mcp;
  const [log, setLog] = useState<McpActivityView | null>(null);
  const [client, setClient] = useState("");
  const [problemsOnly, setProblemsOnly] = useState(false);
  const [page, setPage] = useState(0);
  const [notice, setNotice] = useState("");

  const refresh = useCallback(
    () => api.call("mcp.activity", { limit: CALLS_PAGE, offset: page * CALLS_PAGE, ...(client ? { client } : {}), ...(problemsOnly ? { problemsOnly } : {}) }),
    [api, client, problemsOnly, page],
  );

  useEffect(() => {
    let alive = true;
    const load = (): void => void refresh().then((v) => alive && setLog(v));
    load();
    const timer = setInterval(load, REFRESH_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [refresh, view]);

  // A log that shrank (Clear, old calls dropped) keeps showing a page that exists.
  useEffect(() => {
    if (log && page > 0 && page * CALLS_PAGE >= log.total) setPage(Math.max(0, Math.ceil(log.total / CALLS_PAGE) - 1));
  }, [log, page]);

  const overLimit = log?.summary.reduce((n, s) => n + s.rateLimited, 0) ?? 0;

  return (
    <>
      <Row label={t("Rate limit")} hint={t("How many tool calls each connected agent may make. A call over the limit fails, and the agent is told when to retry.")}>
        <select className="input" aria-label={t("Rate limit")} value={mcp.rateLimit} onChange={(e) => update({ mcp: { rateLimit: e.target.value as McpRateLimit } })}>
          {rateLimitOptions().map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </Row>
      {overLimit > 0 && <div className="notice warn">{t("{n} calls went over the limit in the last 24 hours.", { n: overLimit })}</div>}
      <Row
        label={t("Activity log")}
        hint={t("Keeps which tool each agent called, on which site and how it ended, for 30 days on this device. Never what it typed or what the pages said.")}
      >
        <Toggle label={t("Keep an activity log")} checked={mcp.activityLog} onChange={(v) => update({ mcp: { activityLog: v } })} />
        <button
          className="btn small"
          onClick={() =>
            void api
              .call("mcp.activityExport")
              .then((saved) => setNotice(saved ? t("Saved") : ""))
              .catch((err: unknown) => setNotice(errorMessage(err)))
          }
        >
          {t("Export CSV")}
        </button>
        <button
          className="btn small ghost"
          onClick={() => {
            if (confirm(t("Clear the activity log?"))) void api.call("mcp.activityClear").then(() => void refresh().then(setLog));
          }}
        >
          {t("Clear")}
        </button>
      </Row>
      {notice && <div className="notice">{notice}</div>}
      {log && log.summary.length > 0 && (
        <div className="agent-log">
          <div className="agent-log-title">{t("Last 24 hours")}</div>
          <table className="agent-log-table">
            <thead>
              <tr>
                <th>{t("Tool")}</th>
                <th>{t("Calls")}</th>
                <th>{t("Errors")}</th>
                <th>{t("Over the limit")}</th>
                <th>{t("Average time")}</th>
              </tr>
            </thead>
            <tbody>
              {log.summary.map((s) => (
                <tr key={s.tool}>
                  <td className="mono">{s.tool}</td>
                  <td>{s.calls}</td>
                  <td className={s.errors ? "bad" : "muted"}>{s.errors}</td>
                  <td className={s.rateLimited ? "warn" : "muted"}>{s.rateLimited}</td>
                  <td className="muted">{t("{ms} ms", { ms: s.avgMs })}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {log && (
        <div className="agent-log">
          <div className="agent-log-title agent-log-filters">
            <span className="grow">{t("Recent calls")}</span>
            <select className="input" aria-label={t("Agent")} value={client} onChange={(e) => {
                setClient(e.target.value);
                setPage(0);
              }}>
              <option value="">{t("All agents")}</option>
              {log.clients.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
            <label className="agent-log-switch">
              <span>{t("Only problems")}</span>
              <Toggle
                label={t("Only problems")}
                checked={problemsOnly}
                onChange={(v) => {
                  setProblemsOnly(v);
                  setPage(0);
                }}
              />
            </label>
          </div>
          {log.entries.length === 0 ? (
            <div className="muted agent-log-empty">{log.enabled ? t("No calls recorded yet.") : t("The activity log is off.")}</div>
          ) : (
            <div className="list agent-calls">
              {log.entries.map((e, i) => (
                <div key={`${e.at}-${i}`} className="list-row agent-log-row">
                  <span className="mono muted">{formatTime(e.at)}</span>
                  <span className="grow">
                    <strong>{e.client}</strong> <span className="mono">{e.tool}</span>
                    {e.host && <span className="muted"> · {e.host}</span>}
                    {e.error && <div className="muted small agent-log-error">{e.error}</div>}
                    {e.certificateError && (
                      <div className="small agent-log-cert">{t("Continued past an invalid certificate for {host} ({code})", { host: e.host, code: e.certificateError })}</div>
                    )}
                  </span>
                  <span className="muted small">{t("{ms} ms", { ms: e.durationMs })}</span>
                  <OutcomePill entry={e} />
                </div>
              ))}
            </div>
          )}
          <Pager page={page} size={CALLS_PAGE} total={log.total} onPage={setPage} />
        </div>
      )}
    </>
  );
}
