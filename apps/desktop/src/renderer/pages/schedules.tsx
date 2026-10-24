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

type Api = ReturnType<typeof internalApi>;

const INTERVALS: Array<[number, string]> = [
  [60, "Every hour"],
  [180, "Every 3 hours"],
  [360, "Every 6 hours"],
  [720, "Every 12 hours"],
  [1440, "Every day"],
  [4320, "Every 3 days"],
  [10080, "Every week"],
];

const CRON_PRESETS: Array<[string, string]> = [
  ["0 9 * * *", "Every day at 9am"],
  ["0 * * * *", "Every hour"],
  ["0 9 * * 1-5", "Weekdays at 9am"],
  ["0 8 * * 1", "Mondays at 8am"],
  ["30 18 * * *", "Every day at 6:30pm"],
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
  if (diff < 60_000) return "just now";
  const mins = Math.round(diff / 60_000);
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

function statusPill(s: ScheduleView): { text: string; cls: string } {
  if (s.approval) return { text: "Needs approval", cls: "approval" };
  if (s.running) return { text: "Running…", cls: "running" };
  if (s.paused) return { text: "Paused", cls: "paused" };
  const last = s.lastRun;
  if (!last) return { text: "Scheduled", cls: "pending" };
  if (last.status === "error") return { text: "Last run failed", cls: "error" };
  if (last.status === "cancelled" || last.status === "stopped") return { text: "Last run stopped", cls: "paused" };
  return { text: "Last run ok", cls: "ok" };
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
      setError("Describe the task the agent should run.");
      return;
    }
    if (input.kind === "cron" && !isValidCron(input.cron ?? "")) {
      setError("That cron expression is not valid. Use 5 fields: minute hour day month weekday.");
      return;
    }
    const call = editor.id ? api.call("schedule.update", editor.id, input) : api.call("schedule.add", input);
    run(call.then((l) => (setEditor(null), l)));
  };

  const schedules = list ?? [];

  return (
    <PageShell
      title="Scheduled agents"
      active="schedules"
      toolbar={
        <>
          <button className="btn small primary" onClick={() => setEditor({ id: null, draft: blankDraft() })}>
            <IconPlus size={14} /> New schedule
          </button>
          <a className="btn small ghost" href="corvus://settings/#scheduled-agents">
            Settings
          </a>
        </>
      }
    >
      {error && <div className="notice error">{error}</div>}

      {!editor && (
        <div className="card">
          <div className="card-head">
            <h2>Run an AI agent on a schedule</h2>
            <p className="muted">
              Corvus runs the task in a background tab on your cadence, using the same tools as the Command Bar agent, then notifies you with a short summary.
              Risky actions (sign-in, payments, submitting forms) always pause and wait for your approval — they are never done unattended.
            </p>
          </div>
        </div>
      )}

      {editor && <Editor draft={editor.draft} isEdit={editor.id !== null} onChange={(draft) => setEditor({ ...editor, draft })} onSave={save} onCancel={() => (setError(null), setEditor(null))} />}

      {list && schedules.length === 0 && !editor ? (
        <div className="card">
          <div className="empty">
            <IconClock size={26} />
            <p>No scheduled agents yet. Create one to have Corvus run a task for you automatically.</p>
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
        <h2>{isEdit ? "Edit schedule" : "New schedule"}</h2>
      </div>
      <div className="card-body sched-form">
        <label className="field">
          <span>Name</span>
          <input className="input" placeholder="Morning news check" value={draft.name} onChange={(e) => set("name", e.target.value)} />
        </label>
        <label className="field">
          <span>Task</span>
          <textarea
            className="input sched-task"
            rows={3}
            placeholder="Open example.com, check the status page and summarise any incidents."
            value={draft.task}
            onChange={(e) => set("task", e.target.value)}
          />
        </label>
        <div className="field">
          <span>When</span>
          <div className="segmented">
            <button className={draft.kind === "cron" ? "on" : ""} onClick={() => set("kind", "cron")}>
              Cron
            </button>
            <button className={draft.kind === "interval" ? "on" : ""} onClick={() => set("kind", "interval")}>
              Interval
            </button>
          </div>
        </div>
        {draft.kind === "cron" ? (
          <label className="field">
            <span>Cron</span>
            <div className="sched-cron">
              <input className={`input mono ${cronOk ? "" : "bad"}`} value={draft.cron} spellCheck={false} onChange={(e) => set("cron", e.target.value)} />
              <span className="muted small">{cronOk ? describeSchedule({ kind: "cron", cron: draft.cron, intervalMinutes: 0 }) : "Invalid cron"}</span>
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
            <span>Interval</span>
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
          <span>Max steps</span>
          <input className="input" type="number" style={{ width: 120 }} value={draft.maxSteps} onChange={(e) => set("maxSteps", Number(e.target.value) || 12)} />
        </label>
        <div className="sched-form-actions">
          <button className="btn small primary" disabled={!draft.task.trim() || !cronOk} onClick={onSave}>
            {isEdit ? "Save changes" : "Create schedule"}
          </button>
          <button className="btn small ghost" onClick={onCancel}>
            Cancel
          </button>
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
          <button className="link-button sched-title" onClick={onEdit} title="Edit">
            {s.name}
          </button>
          <span className={`pill sched-status ${status.cls}`}>{status.text}</span>
        </div>
        <div className="sub muted">
          {describeSchedule(s)} · next {s.paused ? "paused" : when(s.nextRunAt)}
          {s.lastRun ? ` · last run ${ago(s.lastRun.startedAt)}` : ""}
        </div>
        <div className="sched-task-preview muted">{s.task}</div>

        {s.approval && <ApprovalBanner s={s} api={api} run={run} />}

        {s.lastRun && !s.approval && (
          <div className="sched-summary">
            <span className="sched-summary-label">{s.running ? "Running" : "Result"}</span>
            {s.lastRun.summary || (s.lastRun.error ? `Error: ${s.lastRun.error}` : "—")}
          </div>
        )}

        {s.history.length > 0 && (
          <button className="link-button small sched-history-toggle" onClick={() => setShowHistory((v) => !v)}>
            {showHistory ? "Hide history" : `History (${s.history.length})`}
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
          <button className="btn small ghost danger" onClick={() => run(api.call("schedule.cancel", s.id))}>
            Cancel run
          </button>
        ) : (
          <button className="icon-btn" title="Run now" onClick={() => run(api.call("schedule.runNow", s.id))}>
            <IconReload size={15} />
          </button>
        )}
        <button className="icon-btn" title={s.paused ? "Resume" : "Pause"} onClick={() => run(api.call("schedule.pause", s.id, !s.paused))}>
          {s.paused ? <IconPlay size={15} /> : <IconPause size={15} />}
        </button>
        <button className="icon-btn" title="Delete" onClick={() => run(api.call("schedule.remove", s.id))}>
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
        <strong>Approval needed</strong>
        <div>{a.reason || `The agent wants to run “${a.tool}”.`}</div>
        {a.summary && <div className="muted small mono">{a.summary}</div>}
        {a.handoff && <div className="muted small">This needs a secret — handle it in the tab, then approve.</div>}
      </div>
      <div className="sched-approval-actions">
        <button className="btn small primary" onClick={() => run(api.call("schedule.approve", s.id, "approve"))}>
          Approve
        </button>
        <button className="btn small" onClick={() => run(api.call("schedule.approve", s.id, "skip"))}>
          Skip
        </button>
        <button className="btn small ghost danger" onClick={() => run(api.call("schedule.approve", s.id, "stop"))}>
          Stop run
        </button>
      </div>
    </div>
  );
}

function HistoryItem({ r }: { r: ScheduleRunRecord }) {
  const cls = r.status === "error" ? "error" : r.status === "done" ? "ok" : "paused";
  return (
    <div className="sched-history-item">
      <span className={`pill sched-status ${cls}`}>{r.status}</span>
      <span className="muted small">{when(r.startedAt)} · {r.steps} steps · {r.inputTokens + r.outputTokens} tok</span>
      <div className="sched-history-summary">{r.summary || (r.error ? `Error: ${r.error}` : "—")}</div>
    </div>
  );
}

mount(<SchedulesPage />);
