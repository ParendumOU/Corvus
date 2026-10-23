import { useCallback, useEffect, useState } from "react";
import type { AgentRunRecord, StoredRunStatus } from "../../shared/agent-run";
import type { AgentRunStep } from "../../shared/command-bar-ipc";
import { errorMessage, internalApi } from "../common/api";
import { IconActivity, IconAgent, IconReload, IconTrash } from "../common/icons";
import "./agent-runs.css";
import { PageShell, mount } from "./shell";

type Api = ReturnType<typeof internalApi>;

const STATUS_LABEL: Record<StoredRunStatus, string> = {
  running: "Running",
  paused: "Paused",
  "awaiting-approval": "Needs approval",
  done: "Done",
  error: "Failed",
  stopped: "Stopped",
  interrupted: "Interrupted",
};

function statusClass(status: StoredRunStatus): string {
  if (status === "done") return "ok";
  if (status === "error") return "error";
  if (status === "running" || status === "paused" || status === "awaiting-approval") return "running";
  return "paused";
}

function when(ms: number | null): string {
  if (ms === null) return "—";
  return new Date(ms).toLocaleString();
}

function ago(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 60_000) return "just now";
  const mins = Math.round(diff / 60_000);
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

function prettyTool(tool: string): string {
  return tool.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function AgentRunsPage() {
  const api = internalApi();
  const [list, setList] = useState<AgentRunRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const load = useCallback(() => {
    void api.call("agentRuns.list").then(setList);
  }, [api]);
  useEffect(() => {
    load();
    return api.onEvent((e) => {
      if (e.type === "agent-runs-changed") load();
    });
  }, [api, load]);

  const run = (p: Promise<AgentRunRecord[]>): void => {
    setError(null);
    p.then(setList).catch((e: unknown) => setError(errorMessage(e)));
  };

  /** Propose the run as a workflow and open the review in corvus://flows (nothing is saved yet). */
  const saveWorkflow = (id: string): void => {
    setError(null);
    api
      .call("flow.draftFromRun", id)
      .then(() => {
        window.location.href = "corvus://flows/";
      })
      .catch((e: unknown) => setError(errorMessage(e)));
  };

  const resume = (id: string): void => {
    setError(null);
    void api.call("agentRuns.resume", id).then((res) => {
      if (!res.ok) setError(res.reason ?? "This run can't be resumed.");
    });
  };

  const toggle = (id: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const runs = list ?? [];

  return (
    <PageShell
      title="Agent runs"
      active="agent-runs"
      toolbar={
        <>
          {runs.length > 0 && (
            <button className="btn small ghost danger" onClick={() => run(api.call("agentRuns.clear"))}>
              Clear history
            </button>
          )}
          <a className="btn small ghost" href="corvus://schedules/">
            Scheduled agents
          </a>
        </>
      }
    >
      {error && <div className="notice error">{error}</div>}

      {list && runs.length === 0 ? (
        <div className="card">
          <div className="empty">
            <IconAgent size={26} />
            <p>No agent runs yet. Ask Corvus to do a task from the Command Bar (Ctrl/Cmd+K, then Tab) and it will show up here, so you can review or resume it later.</p>
          </div>
        </div>
      ) : (
        <div className="card">
          <div className="list">
            {runs.map((r) => (
              <RunRow key={r.id} r={r} api={api} run={run} open={expanded.has(r.id)} onToggle={() => toggle(r.id)} onResume={() => resume(r.id)} onSaveWorkflow={() => saveWorkflow(r.id)} />
            ))}
          </div>
        </div>
      )}
    </PageShell>
  );
}

function RunRow({
  r,
  api,
  run,
  open,
  onToggle,
  onResume,
  onSaveWorkflow,
}: {
  r: AgentRunRecord;
  api: Api;
  run: (p: Promise<AgentRunRecord[]>) => void;
  open: boolean;
  onToggle: () => void;
  onResume: () => void;
  onSaveWorkflow: () => void;
}) {
  const live = r.status === "running" || r.status === "paused" || r.status === "awaiting-approval";
  const savable = !live && r.steps.some((s) => s.action !== undefined && s.status === "ok");
  const usedWorkflow = r.steps.some((s) => s.kind === "run_workflow");
  return (
    <div className="list-row ar-row">
      <div className="grow ar-main">
        <div className="ar-title-row">
          <button className="link-button ar-title" onClick={onToggle} title={open ? "Hide steps" : "Show steps"}>
            {r.task || "Untitled task"}
          </button>
          <span className={`pill ar-status ${statusClass(r.status)}`}>{STATUS_LABEL[r.status]}</span>
          {usedWorkflow && <span className="pill ar-wf">Used a workflow</span>}
        </div>
        <div className="sub muted">
          {r.source === "scheduled" ? "Scheduled" : r.source === "assist" ? "Assist" : "Command Bar"} · {ago(r.startedAt)} · {r.stepCount}
          {r.maxSteps ? `/${r.maxSteps}` : ""} steps · {(r.inputTokens + r.outputTokens).toLocaleString()} tok
          {r.model ? ` · ${r.model}` : ""}
          {r.siteHints?.hints ? ` · ${r.siteHints.hints} site hints` : ""}
        </div>

        {(r.finalText || r.error) && (
          <div className="ar-summary">
            <span className="ar-summary-label">{r.error ? "Error" : "Result"}</span>
            {r.error ? r.error : r.finalText}
          </div>
        )}

        {r.steps.length > 0 && (
          <button className="link-button small ar-steps-toggle" onClick={onToggle}>
            {open ? "Hide steps" : `Steps (${r.steps.length})`}
          </button>
        )}
        {open && (
          <div className="ar-steps">
            {r.steps.map((s) => (
              <StepRow key={s.id} step={s} />
            ))}
            <div className="ar-when muted small">started {when(r.startedAt)}{r.endedAt ? ` · ended ${when(r.endedAt)}` : ""}</div>
          </div>
        )}
      </div>

      <div className="ar-actions">
        {live ? (
          <span className="pill ar-status running">
            <IconActivity size={13} /> live
          </span>
        ) : (
          r.resumable && (
            <button className="btn small primary" title="Continue this run" onClick={onResume}>
              <IconReload size={14} /> Resume
            </button>
          )
        )}
        {savable && (
          <button className="btn small ar-save-wf" title="Review these steps and save them as a reusable workflow" onClick={onSaveWorkflow}>
            Save as workflow
          </button>
        )}
        <button className="icon-btn" title="Delete" disabled={live} onClick={() => run(api.call("agentRuns.remove", r.id))}>
          <IconTrash size={15} />
        </button>
      </div>
    </div>
  );
}

function StepRow({ step }: { step: AgentRunStep }) {
  const isMessage = step.kind === "message";
  return (
    <div className={`ar-step ${step.status} ${isMessage ? "msg" : ""}`}>
      <span className="ar-step-dot" aria-hidden />
      <div className="ar-step-body">
        <div className="ar-step-line">
          <span className="ar-step-name">{isMessage ? "Corvus" : prettyTool(step.kind)}</span>
          {step.summary && <span className="ar-step-args">{step.summary}</span>}
          {step.status === "skipped" && <span className="ar-step-tag">skipped</span>}
        </div>
        {step.detail && <div className="ar-step-detail">{step.detail}</div>}
      </div>
    </div>
  );
}

mount(<AgentRunsPage />);
