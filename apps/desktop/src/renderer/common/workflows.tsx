/**
 * Workflow UI shared by the Workflows side panel (corvus://assist) and the corvus://flows manager:
 * the step list, the run form (parameters), the usage line and the editor (rename, describe, sites,
 * reorder/delete steps, turn typed values into parameters and edit them). Pure React over the shared
 * helpers in shared/workflow.ts; the caller decides what Save and Run do.
 */
import { useEffect, useState } from "react";
import { labelForStep, type FlowParam, type FlowStep, type FlowUsage } from "../../shared/flow";
import type { FlowReplayView, FlowStepStatus } from "../../shared/flow-ipc";
import {
  isStale,
  moveStep,
  normalizeParamName,
  paramNamesIn,
  parameterizeStep,
  removeStep,
  renameParam,
  suggestParams,
  unparameterizeStep,
  type WorkflowEdit,
} from "../../shared/workflow";
import { IconChevronDown, IconChevronUp, IconTrash } from "./icons";
import "./workflows.css";

import { t } from "./i18n";
function glyph(kind: FlowStep["kind"]): string {
  if (kind === "navigate") return "→";
  if (kind === "type") return "⌨";
  return "•";
}

export function ago(ms: number | null, now = Date.now()): string {
  if (!ms) return "never";
  const diff = Math.max(0, now - ms);
  if (diff < 60_000) return t("just now");
  const mins = Math.round(diff / 60_000);
  if (mins < 60) return t("{mins} min ago", { mins });
  const hours = Math.round(mins / 60);
  if (hours < 24) return t("{hours} h ago", { hours });
  return t("{hours} d ago", { hours: Math.round(hours / 24) });
}

/** "Ran 3 times, last ok 2 min ago" / "Broke at step 4 last time" / "Never run". */
export function UsageLine({ usage }: { usage: FlowUsage }) {
  if (usage.runs === 0) return <span className="wf-usage">{t("Never run")}</span>;
  const times = usage.runs === 1 ? t("1 run") : t("{runs} runs", { runs: usage.runs });
  if (isStale(usage)) {
    const where = usage.lastBrokenStep !== null ? t(" at step {lastBrokenStep}", { lastBrokenStep: usage.lastBrokenStep + 1 }) : "";
    return (
      <span className="wf-usage stale" title={usage.lastError ?? undefined}>{t("Last run broke{where}, {ago} · {times}", { where, ago: ago(usage.lastRunAt), times })}</span>
    );
  }
  const by = usage.lastRunBy === "agent" ? t(" by the agent") : "";
  const vars = { by, ago: ago(usage.lastRunAt), times };
  return (
    <span className="wf-usage">{usage.lastStatus === "stopped" ? t("Last run stopped{by} {ago} · {times}", vars) : t("Last run ok{by} {ago} · {times}", vars)}</span>
  );
}

export function OriginBadge({ origin }: { origin: "recorded" | "agent" }) {
  return <span className={`wf-badge ${origin}`}>{origin === "agent" ? t("From agent run") : t("Recorded")}</span>;
}

/** Read-only step list, with the replay cursor/status when one is running. */
export function WorkflowStepList({ steps, replay, limit }: { steps: FlowStep[]; replay?: FlowReplayView | null; limit?: number }) {
  const shown = limit ? steps.slice(0, limit) : steps;
  return (
    <ol className="wf-steps">
      {shown.map((s, i) => {
        const status: FlowStepStatus | undefined = replay?.stepStatuses[i];
        const cursor = replay != null && replay.cursor === i && (replay.status === "running" || replay.status === "awaiting-approval" || replay.status === "paused");
        return (
          <li key={i} className={`wf-step ${status ? `st-${status}` : ""} ${cursor ? "cursor" : ""}`}>
            <span className="wf-step-mark">{glyph(s.kind)}</span>
            <span className="wf-step-label">{s.label}</span>
            {s.secret && <span className="wf-tag warn">{t("secret")}</span>}
            {paramNamesIn(s.kind === "navigate" ? s.url : s.value).length > 0 && <span className="wf-tag">{t("param")}</span>}
            {status && status !== "pending" && <span className={`wf-tag st-${status}`}>{status}</span>}
          </li>
        );
      })}
      {limit && steps.length > limit && <li className="wf-step more">+{steps.length - limit}{" "}{t("more")}</li>}
    </ol>
  );
}

/** Parameter inputs + Run. Values start from each parameter's default. */
export function WorkflowRunForm({ params, onRun, busy, compact }: { params: FlowParam[]; onRun: (values: Record<string, string>) => void; busy?: boolean; compact?: boolean }) {
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(params.map((p) => [p.name, p.default])));
  useEffect(() => {
    setValues((prev) => Object.fromEntries(params.map((p) => [p.name, prev[p.name] ?? p.default])));
  }, [params]);
  const missing = params.filter((p) => !(values[p.name] ?? "").trim()).map((p) => p.name);
  return (
    <form
      className={`wf-run-form ${compact ? "compact" : ""}`}
      onSubmit={(e) => {
        e.preventDefault();
        if (missing.length === 0) onRun(values);
      }}
    >
      {params.map((p) => (
        <label key={p.name} className="wf-field">
          <span>{p.label || p.name}</span>
          <input className="input" value={values[p.name] ?? ""} placeholder={`{{${p.name}}}`} onChange={(e) => setValues({ ...values, [p.name]: e.target.value })} />
        </label>
      ))}
      <div className="wf-actions">
        <button className="btn small primary" type="submit" disabled={busy || missing.length > 0} title={missing.length ? t("Fill in: {v}", { v: missing.join(", ") }) : undefined}>{t("Run workflow")}</button>
        {params.length > 0 && <span className="wf-hint">{t("Secret fields are never stored: you type them in the tab when the run reaches them.")}</span>}
      </div>
    </form>
  );
}

/**
 * Edit a workflow or review a draft. Steps can be reordered and removed; a typed value can become a
 * `{{parameter}}` (and back); parameters can be renamed and get a default.
 */
export function WorkflowEditor({
  initial,
  saveLabel,
  cancelLabel,
  onSave,
  onCancel,
  intro,
}: {
  initial: WorkflowEdit;
  saveLabel: string;
  cancelLabel: string;
  onSave: (edit: WorkflowEdit) => void;
  onCancel: () => void;
  intro?: string;
}) {
  const [edit, setEdit] = useState<WorkflowEdit>(initial);
  const [sitesText, setSitesText] = useState(initial.sites.join(", "));
  const suggestions = suggestParams(edit.steps);

  const save = (): void => {
    const sites = sitesText
      .split(/[,\s]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    onSave({ ...edit, sites });
  };

  return (
    <div className="wf-editor">
      {intro && <p className="wf-intro">{intro}</p>}
      <label className="wf-field">
        <span>{t("Name")}</span>
        <input className="input wf-name" value={edit.name} maxLength={120} onChange={(e) => setEdit({ ...edit, name: e.target.value })} />
      </label>
      <label className="wf-field">
        <span>{t("Description")}</span>
        <textarea className="input" rows={2} value={edit.description} maxLength={400} placeholder={t("What it does, when to use it")} onChange={(e) => setEdit({ ...edit, description: e.target.value })} />
      </label>
      <label className="wf-field">
        <span>{t("Sites")}</span>
        <input className="input" value={sitesText} placeholder={t("shop.example, other.example")} onChange={(e) => setSitesText(e.target.value)} />
      </label>

      <div className="wf-section-head">{t("Steps")}</div>
      <div className="wf-start" title={edit.startUrl}>{t("Starts at")}{" "}<code>{edit.startUrl}</code>
      </div>
      <ol className="wf-steps editable">
        {edit.steps.map((s, i) => {
          const names = s.kind === "type" ? paramNamesIn(s.value) : [];
          const suggestion = suggestions.find((x) => x.stepIndex === i);
          return (
            <li key={i} className="wf-step">
              <span className="wf-step-mark">{glyph(s.kind)}</span>
              <div className="wf-step-body">
                <span className="wf-step-label">{s.label}</span>
                {s.kind === "type" && !s.secret && (
                  <div className="wf-step-tools">
                    {names.length > 0 ? (
                      <button className="wf-link" onClick={() => setEdit(unparameterizeStep(edit, i))}>{t("Use a fixed value")}</button>
                    ) : (
                      <>
                        <input
                          className="input wf-inline"
                          value={s.value ?? ""}
                          aria-label={t("Typed value")}
                          onChange={(e) => setEdit({ ...edit, steps: edit.steps.map((x, j) => (j === i ? { ...x, value: e.target.value, label: labelForStep({ ...x, value: e.target.value }) } : x)) })}
                        />
                        <button className="wf-link" onClick={() => setEdit(parameterizeStep(edit, i, suggestion?.name ?? normalizeParamName(s.target?.name ?? "value")))}>{t("Make it a parameter")}</button>
                      </>
                    )}
                  </div>
                )}
                {s.secret && <span className="wf-hint">{t("Asked at run time, never stored.")}</span>}
              </div>
              <div className="wf-step-ctrl">
                <button className="icon-btn small" title={t("Move up")} disabled={i === 0} onClick={() => setEdit(moveStep(edit, i, i - 1))}>
                  <IconChevronUp size={14} />
                </button>
                <button className="icon-btn small" title={t("Move down")} disabled={i === edit.steps.length - 1} onClick={() => setEdit(moveStep(edit, i, i + 1))}>
                  <IconChevronDown size={14} />
                </button>
                <button className="icon-btn small" title={t("Delete step")} disabled={edit.steps.length <= 1} onClick={() => setEdit(removeStep(edit, i))}>
                  <IconTrash size={14} />
                </button>
              </div>
            </li>
          );
        })}
      </ol>

      <div className="wf-section-head">{t("Parameters")}</div>
      {edit.params.length === 0 ? (
        <p className="wf-hint">{t("No parameters. Turn a typed value into one to fill it in each time the workflow runs.")}</p>
      ) : (
        <div className="wf-params">
          {edit.params.map((p) => (
            <ParamRow key={p.name} param={p} onRename={(to) => setEdit(renameParam(edit, p.name, to))} onDefault={(v) => setEdit({ ...edit, params: edit.params.map((x) => (x.name === p.name ? { ...x, default: v } : x)) })} />
          ))}
        </div>
      )}

      <div className="wf-actions">
        <button className="btn small primary" disabled={!edit.name.trim() || edit.steps.length === 0} onClick={save}>
          {saveLabel}
        </button>
        <button className="btn small ghost" onClick={onCancel}>
          {cancelLabel}
        </button>
      </div>
    </div>
  );
}

function ParamRow({ param, onRename, onDefault }: { param: FlowParam; onRename: (to: string) => void; onDefault: (v: string) => void }) {
  const [name, setName] = useState(param.name);
  useEffect(() => setName(param.name), [param.name]);
  return (
    <div className="wf-param">
      <span className="wf-brace">{"{{"}</span>
      <input className="input wf-param-name" value={name} aria-label={t("Parameter name")} onChange={(e) => setName(e.target.value)} onBlur={() => (name.trim() && name !== param.name ? onRename(name) : setName(param.name))} />
      <span className="wf-brace">{"}}"}</span>
      <input className="input wf-param-default" value={param.default} placeholder={t("Default (optional)")} aria-label={t("Default value")} onChange={(e) => onDefault(e.target.value)} />
    </div>
  );
}
