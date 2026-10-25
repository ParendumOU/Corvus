import { useCallback, useEffect, useState } from "react";
import {
  DEFAULT_INTERVAL_MINUTES,
  type ScheduleKind,
  type ScheduleRunRecord,
  describeSchedule,
  isValidCron,
} from "../../shared/schedule";
import type { ScheduleInput, ScheduleView } from "../../shared/schedule-ipc";
import { errorMessage, internalApi } from "../common/api";
import { IconClock, IconPause, IconPlay, IconPlus, IconReload, IconTrash } from "../common/icons";
import "./schedules.css";
import { PageShell, mount } from "./shell";

import { t } from "../common/i18n";
type Api = ReturnType<typeof internalApi>;

const INTERVALS: Array<[number, string]> = [
  [60, t("Every hour")],
  [180, t("Every 3 hours")],
  [360, t("Every 6 hours")],
  [720, t("Every 12 hours")],
  [1440, t("Every day")],
  [4320, t("Every 3 days")],
  [10080, t("Every week")],
];

const CRON_PRESETS: Array<[string, string]> = [
  ["0 9 * * *", t("Every day at 9am")],
  ["0 * * * *", t("Every hour")],
  ["0 9 * * 1-5", t("Weekdays at 9am")],
  ["0 8 * * 1", t("Mondays at 8am")],
  ["30 18 * * *", t("Every day at 6:30pm")],
];

interface Draft {
  name: string;
  task: string;
  kind: ScheduleKind;
  cron: string;
  intervalMinutes: number;
  maxSteps: number;
}

function blankDraft(): Draft {
  return { name: "", task: "", kind: "cron", cron: "0 9 * * *", intervalMinutes: DEFAULT_INTERVAL_MINUTES, maxSteps: 12 };
}

function draftFrom(s: ScheduleView): Draft {
  return { name: s.name, task: s.task, kind: s.kind, cron: s.cron, intervalMinutes: s.intervalMinutes, maxSteps: s.maxSteps };
}

function toInput(d: Draft): ScheduleInput {
  return { name: d.name.trim(), task: d.task.trim(), kind: d.kind, cron: d.cron.trim(), intervalMinutes: d.intervalMinutes, maxSteps: d.maxSteps };
}

function when(ms: number | null): string {
  if (ms === null) return "—";
  return new Date(ms).toLocaleString();
}

function ago(ms: number | null): string {
  if (ms === null) return "never";
  const diff = Date.now() - ms;
  if (diff < 60_000) return t("just now");
  const mins = Math.round(diff / 60_000);
  if (mins < 60) return t("{mins} min ago", { mins });
  const hours = Math.round(mins / 60);
  if (hours < 24) return t("{hours} h ago", { hours });
  return t("{hours} d ago", { hours: Math.round(hours / 24) });
}

function statusPill(s: ScheduleView): { text: string; cls: string } {
  if (s.approval) return { text: t("Needs approval"), cls: "approval" };
  if (s.running) return { text: t("Running…"), cls: "running" };
  if (s.paused) return { text: t("Paused"), cls: "paused" };
  const last = s.lastRun;
  if (!last) return { text: t("Scheduled"), cls: "pending" };
  if (last.status === "error") return { text: t("Last run failed"), cls: "error" };
  if (last.status === "cancelled" || last.status === "stopped") return { text: t("Last run stopped"), cls: "paused" };
  return { text: t("Last run ok"), cls: "ok" };
}

function SchedulesPage() {
  const api = internalApi();
  const [list, setList] = useState<ScheduleView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editor, setEditor] = useState<{ id: string | null; draft: Draft } | null>(null);

  const load = useCallback(() => {
    void api.call("schedule.list").then(setList);
  }, [api]);
  useEffect(() => {
    load();
    return api.onEvent((e) => {
      if (e.type === "schedules-changed") load();
    });
  }, [api, load]);

  const run = (p: Promise<ScheduleView[]>): void => {
    setError(null);
    p.then(setList).catch((e: unknown) => setError(errorMessage(e)));
  };

  const save = (): void => {
    if (!editor) return;
    const input = toInput(editor.draft);
    if (!input.task) {
      setError(t("Describe the task the agent should run."));
      return;
    }
    if (input.kind === "cron" && !isValidCron(input.cron ?? "")) {
      setError(t("That cron expression is not valid. Use 5 fields: minute hour day month weekday."));
      return;
    }
    const call = editor.id ? api.call("schedule.update", editor.id, input) : api.call("schedule.add", input);
    run(call.then((l) => (setEditor(null), l)));
  };

  const schedules = list ?? [];

  return (
    <PageShell
      title={t("Scheduled agents")}
      active="schedules"
      toolbar={
        <>
          <button className="btn small primary" onClick={() => setEditor({ id: null, draft: blankDraft() })}>
            <IconPlus size={14} />{" "}{t("New schedule")}</button>
          <a className="btn small ghost" href="corvus://settings/#scheduled-agents">{t("Settings")}</a>
        </>
      }
    >
      {error && <div className="notice error">{error}</div>}

      {!editor && (
        <div className="card">
          <div className="card-head">
            <h2>{t("Run an AI agent on a schedule")}</h2>
            <p className="muted">{t("Corvus runs the task in a background tab on your cadence, using the same tools as the Command Bar agent, then notifies you with a short summary. Risky actions (sign-in, payments, submitting forms) always pause and wait for your approval — they are never done unattended.")}</p>
          </div>
        </div>
      )}

      {editor && <Editor draft={editor.draft} isEdit={editor.id !== null} onChange={(draft) => setEditor({ ...editor, draft })} onSave={save} onCancel={() => (setError(null), setEditor(null))} />}

      {list && schedules.length === 0 && !editor ? (
        <div className="card">
          <div className="empty">
            <IconClock size={26} />
            <p>{t("No scheduled agents yet. Create one to have Corvus run a task for you automatically.")}</p>
          </div>
        </div>
      ) : (
        <div className="card">
          <div className="list">
            {schedules.map((s) => (
              <ScheduleRow key={s.id} s={s} api={api} run={run} onEdit={() => setEditor({ id: s.id, draft: draftFrom(s) })} />
            ))}
          </div>
        </div>
      )}
    </PageShell>
  );
}

function Editor({ draft, isEdit, onChange, onSave, onCancel }: { draft: Draft; isEdit: boolean; onChange: (d: Draft) => void; onSave: () => void; onCancel: () => void }) {
  const set = <K extends keyof Draft>(key: K, value: Draft[K]): void => onChange({ ...draft, [key]: value });
  const cronOk = draft.kind !== "cron" || isValidCron(draft.cron.trim());
  return (
    <div className="card">
      <div className="card-head">
        <h2>{isEdit ? t("Edit schedule") : t("New schedule")}</h2>
      </div>
      <div className="card-body sched-form">
        <label className="field">
          <span>{t("Name")}</span>
          <input className="input" placeholder={t("Morning news check")} value={draft.name} onChange={(e) => set("name", e.target.value)} />
        </label>
        <label className="field">
          <span>{t("Task")}</span>
          <textarea
            className="input sched-task"
            rows={3}
            placeholder={t("Open example.com, check the status page and summarise any incidents.")}
            value={draft.task}
            onChange={(e) => set("task", e.target.value)}
          />
        </label>
        <div className="field">
          <span>{t("When")}</span>
          <div className="segmented">
            <button className={draft.kind === "cron" ? "on" : ""} onClick={() => set("kind", "cron")}>{t("Cron")}</button>
            <button className={draft.kind === "interval" ? "on" : ""} onClick={() => set("kind", "interval")}>{t("Interval")}</button>
          </div>
        </div>
        {draft.kind === "cron" ? (
          <label className="field">
            <span>{t("Cron")}</span>
            <div className="sched-cron">
              <input className={`input mono ${cronOk ? "" : "bad"}`} value={draft.cron} spellCheck={false} onChange={(e) => set("cron", e.target.value)} />
              <span className="muted small">{cronOk ? describeSchedule({ kind: "cron", cron: draft.cron, intervalMinutes: 0 }) : t("Invalid cron")}</span>
              <div className="sched-presets">
                {CRON_PRESETS.map(([expr, label]) => (
                  <button key={expr} className="btn small ghost" onClick={() => set("cron", expr)} title={expr}>
                    {label}
                  </button>
                ))}
              </div>
            </div>
          </label>
        ) : (
          <label className="field">
            <span>{t("Interval")}</span>
            <select className="input" value={draft.intervalMinutes} onChange={(e) => set("intervalMinutes", Number(e.target.value))}>
              {INTERVALS.map(([m, label]) => (
                <option key={m} value={m}>
                  {label}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="field">
          <span>{t("Max steps")}</span>
          <input className="input" type="number" style={{ width: 120 }} value={draft.maxSteps} onChange={(e) => set("maxSteps", Number(e.target.value) || 12)} />
        </label>
        <div className="sched-form-actions">
          <button className="btn small primary" disabled={!draft.task.trim() || !cronOk} onClick={onSave}>
            {isEdit ? t("Save changes") : t("Create schedule")}
          </button>
          <button className="btn small ghost" onClick={onCancel}>{t("Cancel")}</button>
        </div>
      </div>
    </div>
  );
}

function ScheduleRow({ s, api, run, onEdit }: { s: ScheduleView; api: Api; run: (p: Promise<ScheduleView[]>) => void; onEdit: () => void }) {
  const [showHistory, setShowHistory] = useState(false);
  const status = statusPill(s);
  return (
    <div className={`list-row sched-row ${s.approval ? "needs-approval" : ""}`}>
      <div className="grow sched-main">
        <div className="sched-title-row">
          <button className="link-button sched-title" onClick={onEdit} title={t("Edit")}>
            {s.name}
          </button>
          <span className={`pill sched-status ${status.cls}`}>{status.text}</span>
        </div>
        <div className="sub muted">{t("{describeSchedule} · next", { describeSchedule: describeSchedule(s) })}{" "}{s.paused ? "paused" : when(s.nextRunAt)}
          {s.lastRun ? t(" · last run {startedAt}", { startedAt: ago(s.lastRun.startedAt) }) : ""}
        </div>
        <div className="sched-task-preview muted">{s.task}</div>

        {s.approval && <ApprovalBanner s={s} api={api} run={run} />}

        {s.lastRun && !s.approval && (
          <div className="sched-summary">
            <span className="sched-summary-label">{s.running ? t("Running") : t("Result")}</span>
            {s.lastRun.summary || (s.lastRun.error ? t("Error: {error}", { error: s.lastRun.error }) : "—")}
          </div>
        )}

        {s.history.length > 0 && (
          <button className="link-button small sched-history-toggle" onClick={() => setShowHistory((v) => !v)}>
            {showHistory ? t("Hide history") : t("History ({length})", { length: s.history.length })}
          </button>
        )}
        {showHistory && (
          <div className="sched-history">
            {s.history.map((r) => (
              <HistoryItem key={r.id} r={r} />
            ))}
          </div>
        )}
      </div>

      <div className="sched-actions">
        {s.running ? (
          <button className="btn small ghost danger" onClick={() => run(api.call("schedule.cancel", s.id))}>{t("Cancel run")}</button>
        ) : (
          <button className="icon-btn" title={t("Run now")} onClick={() => run(api.call("schedule.runNow", s.id))}>
            <IconReload size={15} />
          </button>
        )}
        <button className="icon-btn" title={s.paused ? t("Resume") : t("Pause")} onClick={() => run(api.call("schedule.pause", s.id, !s.paused))}>
          {s.paused ? <IconPlay size={15} /> : <IconPause size={15} />}
        </button>
        <button className="icon-btn" title={t("Delete")} onClick={() => run(api.call("schedule.remove", s.id))}>
          <IconTrash size={15} />
        </button>
      </div>
    </div>
  );
}

function ApprovalBanner({ s, api, run }: { s: ScheduleView; api: Api; run: (p: Promise<ScheduleView[]>) => void }) {
  const a = s.approval!;
  return (
    <div className="notice warn sched-approval">
      <div className="sched-approval-text">
        <strong>{t("Approval needed")}</strong>
        <div>{a.reason || t("The agent wants to run “{tool}”.", { tool: a.tool })}</div>
        {a.summary && <div className="muted small mono">{a.summary}</div>}
        {a.handoff && <div className="muted small">{t("This needs a secret — handle it in the tab, then approve.")}</div>}
      </div>
      <div className="sched-approval-actions">
        <button className="btn small primary" onClick={() => run(api.call("schedule.approve", s.id, "approve"))}>{t("Approve")}</button>
        <button className="btn small" onClick={() => run(api.call("schedule.approve", s.id, "skip"))}>{t("Skip")}</button>
        <button className="btn small ghost danger" onClick={() => run(api.call("schedule.approve", s.id, "stop"))}>{t("Stop run")}</button>
      </div>
    </div>
  );
}

function HistoryItem({ r }: { r: ScheduleRunRecord }) {
  const cls = r.status === "error" ? "error" : r.status === "done" ? "ok" : "paused";
  return (
    <div className="sched-history-item">
      <span className={`pill sched-status ${cls}`}>{r.status}</span>
      <span className="muted small">{when(r.startedAt)}{" "}{t("· {steps} steps ·", { steps: r.steps })}{" "}{r.inputTokens + r.outputTokens}{" "}{t("tok")}</span>
      <div className="sched-history-summary">{r.summary || (r.error ? t("Error: {error}", { error: r.error }) : "—")}</div>
    </div>
  );
}

mount(<SchedulesPage />);
