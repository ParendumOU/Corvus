import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { AgentRunRecord, StoredRunStatus } from "../../shared/agent-run";
import type { AgentRunStep } from "../../shared/command-bar-ipc";
import { answerAsText } from "../../shared/assist-artifacts";
import { modelLabel } from "../../shared/model-label";
import { errorMessage, internalApi } from "../common/api";
import { IconAgent, IconCopy, IconReload, IconTrash } from "../common/icons";
import { RichMarkdown } from "../common/rich-text";
import "./agent-runs.css";
import { PageShell, mount } from "./shell";

import { t } from "../common/i18n";
type Api = ReturnType<typeof internalApi>;

const STATUS_LABEL: Record<StoredRunStatus, string> = {
  running: t("Running"),
  paused: t("Paused"),
  "awaiting-approval": t("Needs approval"),
  done: t("Done"),
  error: t("Failed"),
  stopped: t("Stopped"),
  interrupted: t("Interrupted"),
};

const live = (status: StoredRunStatus): boolean => status === "running" || status === "paused" || status === "awaiting-approval";

function statusTone(status: StoredRunStatus): string {
  if (status === "done") return "ok";
  if (status === "error") return "error";
  if (live(status)) return "live";
  return "idle";
}

function ago(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 60_000) return t("just now");
  const mins = Math.round(diff / 60_000);
  if (mins < 60) return t("{mins} min ago", { mins });
  const hours = Math.round(mins / 60);
  if (hours < 24) return t("{hours} h ago", { hours });
  return new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

/** "Today", "Yesterday" or the date, to group runs by the day they started. */
function dayOf(ms: number): string {
  const start = new Date(ms);
  start.setHours(0, 0, 0, 0);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const days = Math.round((today.getTime() - start.getTime()) / 86_400_000);
  if (days === 0) return t("Today");
  if (days === 1) return t("Yesterday");
  return start.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" });
}

const compactNumber = (n: number): string => new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(n);

function prettyTool(tool: string): string {
  return tool.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

const SOURCE_LABEL = (r: AgentRunRecord): string => (r.source === "scheduled" ? t("Scheduled") : r.source === "assist" ? t("Assist") : t("Command Bar"));

function AgentRunsPage() {
  const api = internalApi();
  const [list, setList] = useState<AgentRunRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [zoom, setZoom] = useState<string | null>(null);

  const load = useCallback(() => {
    void api.call("agentRuns.list").then(setList);
  }, [api]);
  useEffect(() => {
    load();
    return api.onEvent((e) => {
      if (e.type === "agent-runs-changed") load();
    });
  }, [api, load]);
  useEffect(() => {
    if (!zoom) return;
    const close = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setZoom(null);
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [zoom]);

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
      if (!res.ok) setError(res.reason ?? t("This run can't be resumed."));
    });
  };

  const groups = useMemo(() => {
    const out: Array<{ day: string; runs: AgentRunRecord[] }> = [];
    for (const r of list ?? []) {
      const day = dayOf(r.startedAt);
      const last = out[out.length - 1];
      if (last?.day === day) last.runs.push(r);
      else out.push({ day, runs: [r] });
    }
    return out;
  }, [list]);

  return (
    <PageShell
      title={t("Agent runs")}
      active="agent-runs"
      toolbar={
        <>
          {(list?.length ?? 0) > 0 && (
            <button className="btn small ghost danger" onClick={() => run(api.call("agentRuns.clear"))}>
              {t("Clear history")}
            </button>
          )}
          <a className="btn small ghost" href="corvus://schedules/">
            {t("Scheduled agents")}
          </a>
        </>
      }
    >
      {error && <div className="notice error">{error}</div>}

      {list && list.length === 0 ? (
        <div className="ar-empty">
          <IconAgent size={26} />
          <p>{t("No agent runs yet. Ask Corvus to do a task from the Command Bar (Ctrl/Cmd+K, then Tab) and it will show up here, so you can review or resume it later.")}</p>
        </div>
      ) : (
        groups.map((g) => (
          <section key={g.day} className="ar-day">
            <h2 className="ar-day-head">{g.day}</h2>
            {g.runs.map((r) => (
              <RunCard key={r.id} r={r} api={api} run={run} onResume={() => resume(r.id)} onSaveWorkflow={() => saveWorkflow(r.id)} onZoom={setZoom} />
            ))}
          </section>
        ))
      )}

      {zoom && (
        <button className="ar-zoom" title={t("Close")} onClick={() => setZoom(null)}>
          <img src={zoom} alt={t("The page after this step")} />
        </button>
      )}
    </PageShell>
  );
}

function RunCard({
  r,
  api,
  run,
  onResume,
  onSaveWorkflow,
  onZoom,
}: {
  r: AgentRunRecord;
  api: Api;
  run: (p: Promise<AgentRunRecord[]>) => void;
  onResume: () => void;
  onSaveWorkflow: () => void;
  onZoom: (shot: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [shots, setShots] = useState<Record<string, string>>({});
  const [copied, setCopied] = useState(false);
  const isLive = live(r.status);
  const shotCount = r.steps.filter((s) => s.shot).length;
  useEffect(() => {
    if (open && shotCount > 0) void api.call("agentRuns.shots", r.id).then(setShots);
  }, [open, shotCount, r.id, api]);
  const savable = !isLive && r.steps.some((s) => s.action !== undefined && s.status === "ok");
  const usedWorkflow = r.steps.some((s) => s.kind === "run_workflow");
  const result = useMemo(() => (r.finalText ? answerAsText(r.finalText, document.documentElement.lang || "en") : ""), [r.finalText]);
  // The last step repeats the answer: the result shows it once.
  const steps = r.steps.filter((s) => s.kind !== "message");
  const tokens = r.inputTokens + r.outputTokens;

  const copy = (): void => {
    void api.call("clipboard.write", result).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <article className={`ar-run ${statusTone(r.status)}`}>
      <header className="ar-head">
        <span className="ar-dot" title={STATUS_LABEL[r.status]} aria-hidden />
        <div className="ar-head-text">
          <h3 className="ar-task">{r.task || t("Untitled task")}</h3>
          <div className="ar-meta">
            <span className={`ar-state ${statusTone(r.status)}`}>{STATUS_LABEL[r.status]}</span>
            <span>{SOURCE_LABEL(r)}</span>
            <span>{ago(r.startedAt)}</span>
            {tokens > 0 && <span>{t("{v} tokens", { v: compactNumber(tokens) })}</span>}
            {r.model && <span>{modelLabel(r.model)}</span>}
            {usedWorkflow && <span>{t("Used a workflow")}</span>}
          </div>
        </div>
        <div className="ar-actions">
          {!isLive && r.resumable && (
            <button className="btn small primary" title={t("Continue this run")} onClick={onResume}>
              <IconReload size={14} /> {t("Resume")}
            </button>
          )}
          {result && (
            <button className="icon-btn" title={copied ? t("Copied") : t("Copy the result")} onClick={copy}>
              <IconCopy size={15} />
            </button>
          )}
          {savable && (
            <button className="btn small ghost ar-save-wf" title={t("Review these steps and save them as a reusable workflow")} onClick={onSaveWorkflow}>
              {t("Save as workflow")}
            </button>
          )}
          <button className="icon-btn" title={t("Delete")} disabled={isLive} onClick={() => run(api.call("agentRuns.remove", r.id))}>
            <IconTrash size={15} />
          </button>
        </div>
      </header>

      {r.error ? <p className="ar-error">{r.error}</p> : result ? <Result text={result} /> : null}

      {steps.length > 0 && (
        <button className="ar-steps-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
          <span className={`ar-caret ${open ? "open" : ""}`} aria-hidden>
            ›
          </span>
          {t("{n} steps", { n: steps.length })}
          {r.maxSteps ? <span className="ar-muted"> / {r.maxSteps}</span> : null}
          {shotCount > 0 && !open ? <span className="ar-muted"> · {t("with captures")}</span> : null}
        </button>
      )}
      {open && (
        <ol className="ar-steps">
          {steps.map((s) => (
            <StepRow key={s.id} step={s} shot={shots[s.id]} onZoom={onZoom} />
          ))}
        </ol>
      )}
    </article>
  );
}

/** The run's answer as formatted text, folded when long. */
function Result({ text }: { text: string }) {
  const box = useRef<HTMLDivElement>(null);
  const [long, setLong] = useState(false);
  const [expanded, setExpanded] = useState(false);
  useLayoutEffect(() => {
    const el = box.current;
    if (el) setLong(el.scrollHeight > el.clientHeight + 4);
  }, [text]);
  return (
    <div className="ar-result-wrap">
      <div ref={box} className={`ar-result ${expanded ? "" : "folded"} ${long && !expanded ? "faded" : ""}`}>
        <RichMarkdown
          text={text}
          sectionCount={0}
          renderCite={() => null}
          openUrl={(url) => window.open(url, "_blank", "noopener")}
          copy={(value) => internalApi().call("clipboard.write", value)}
        />
      </div>
      {(long || expanded) && (
        <button className="ar-more" onClick={() => setExpanded(!expanded)}>
          {expanded ? t("Show less") : t("Show more")}
        </button>
      )}
    </div>
  );
}

function StepRow({ step, shot, onZoom }: { step: AgentRunStep; shot?: string | undefined; onZoom: (shot: string) => void }) {
  const name = step.label ?? prettyTool(step.kind);
  const detail = step.label ? step.detail : [step.summary, step.detail].filter(Boolean).join(" · ");
  return (
    <li className={`ar-step ${step.status}`}>
      <span className="ar-step-dot" aria-hidden />
      <div className="ar-step-text">
        <span className="ar-step-name">{name}</span>
        {step.status === "skipped" && <span className="ar-step-tag">{t("skipped")}</span>}
        {detail ? (
          <span className="ar-step-detail" title={detail}>
            {detail}
          </span>
        ) : null}
      </div>
      {shot && (
        <button className="ar-thumb" title={t("Larger")} onClick={() => onZoom(shot)}>
          <img src={shot} alt={t("The page after this step")} />
        </button>
      )}
    </li>
  );
}

mount(<AgentRunsPage />);
