import { useCallback, useEffect, useMemo, useState } from "react";
import type { FlowRecordingView, FlowReplayView, FlowView, SiteMemoryState, WorkflowDraftView } from "../../shared/flow-ipc";
import { hintCount } from "../../shared/site-memory";
import { editOf, flowSites, isStale } from "../../shared/workflow";
import { errorMessage, internalApi } from "../common/api";
import { IconClose, IconEdit, IconPause, IconPlay, IconPointer, IconTrash } from "../common/icons";
import { OriginBadge, UsageLine, WorkflowEditor, WorkflowRunForm, WorkflowStepList, ago } from "../common/workflows";
import { LearnedSite, StatsLine } from "../common/site-memory";
import { Toggle } from "../common/ui";
import "./flows.css";
import { PageShell, mount } from "./shell";

type Api = ReturnType<typeof internalApi>;
type OriginFilter = "all" | "recorded" | "agent" | "stale";

function when(ms: number): string {
  return new Date(ms).toLocaleString();
}

function FlowsPage() {
  const api = internalApi();
  const [list, setList] = useState<FlowView[] | null>(null);
  const [recording, setRecording] = useState<FlowRecordingView | null>(null);
  const [draft, setDraft] = useState<WorkflowDraftView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [origin, setOrigin] = useState<OriginFilter>("all");
  const [section, setSection] = useState<"workflows" | "learned">(() => (window.location.hash === "#learned" ? "learned" : "workflows"));
  useEffect(() => {
    const onHash = (): void => setSection(window.location.hash === "#learned" ? "learned" : "workflows");
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  const go = (next: "workflows" | "learned"): void => {
    window.location.hash = next === "learned" ? "learned" : "";
    setSection(next);
  };
  const [site, setSite] = useState<string>("");

  const load = useCallback(() => {
    void api.call("flow.list").then(setList);
    void api.call("flow.recording").then(setRecording);
    void api.call("flow.draft").then(setDraft);
  }, [api]);

  useEffect(() => {
    load();
    return api.onEvent((e) => {
      if (e.type === "flows-changed") load();
    });
  }, [api, load]);

  const run = (p: Promise<FlowView[]>): void => {
    setError(null);
    p.then(setList).catch((e: unknown) => setError(errorMessage(e)));
  };

  const flows = list ?? [];
  const sites = useMemo(() => [...new Set(flows.flatMap((f) => flowSites(f)))].sort(), [flows]);
  const shown = flows.filter(
    (f) =>
      (origin === "all" || (origin === "stale" ? isStale(f.usage) : f.origin === origin)) &&
      (!site || flowSites(f).some((s) => s === site || site.endsWith(`.${s}`) || s.endsWith(`.${site}`))),
  );

  return (
    <PageShell
      title="Workflows"
      active="flows"
      toolbar={
        recording?.phase === "recording" ? (
          <span className="pill flow-rec-pill">Recording... {recording.steps.length} steps</span>
        ) : (
          <button
            className="btn small primary"
            onClick={() => {
              setError(null);
              void api.call("flow.startRecording").then(setRecording).catch((e: unknown) => setError(errorMessage(e)));
            }}
          >
            <IconPlay size={14} /> Record a flow
          </button>
        )
      }
    >
      {error && <div className="notice error">{error}</div>}

      <div className="wf-seg wf-sections" role="tablist" aria-label="Section">
        <button role="tab" aria-selected={section === "workflows"} className={section === "workflows" ? "on" : ""} onClick={() => go("workflows")}>
          Saved workflows
        </button>
        <button role="tab" aria-selected={section === "learned"} className={section === "learned" ? "on" : ""} onClick={() => go("learned")}>
          Learned about sites
        </button>
      </div>

      {section === "learned" ? (
        <LearnedSites api={api} onError={setError} />
      ) : (
      <>
      {draft && (
        <div className="card wf-draft-card">
          <div className="card-head">
            <h2>Save as workflow</h2>
            <p className="muted">
              Review the steps Corvus took for "{draft.task.slice(0, 160)}". Nothing is saved until you click Save.
              {draft.dropped > 0 ? ` ${draft.dropped} step${draft.dropped === 1 ? " was" : "s were"} left out (page reads, failed or skipped steps).` : ""}
            </p>
          </div>
          <div className="card-body padded">
            <WorkflowEditor
              key={draft.createdAt}
              initial={draft.edit}
              saveLabel="Save workflow"
              cancelLabel="Discard"
              onSave={(edit) => run(api.call("flow.saveDraft", edit))}
              onCancel={() => void api.call("flow.discardDraft").then(() => setDraft(null))}
            />
          </div>
        </div>
      )}

      {(!recording || recording.phase === "idle") && !draft && flows.length === 0 && (
        <div className="card">
          <div className="card-head">
            <h2>Workflows: steps you repeat, saved once</h2>
            <p className="muted">
              Save the steps of a finished agent run (Save as workflow), or record your own browsing. Run a workflow from here or from the
              Workflows side panel; the agent also finds the ones saved for the site it works on. A step that spends money always asks
              you first. Other risky steps (sign-in, submitting a form) pause for your approval when you run a workflow, and for the
              agent when Ask before risky actions is on. Secret fields are never stored or filled for you.
            </p>
          </div>
        </div>
      )}

      {recording && recording.phase === "recording" && (
        <div className="card flow-recording">
          <div className="card-head">
            <h2>
              <span className="flow-rec-dot" /> Recording in progress
            </h2>
            <p className="muted">
              Interact with the page you want to automate. {recording.steps.length} step{recording.steps.length === 1 ? "" : "s"} captured
              {recording.atCap ? " (reached the step limit, stop and save)." : "."}
            </p>
          </div>
          <div className="card-body">
            <WorkflowStepList steps={recording.steps} />
            <div className="flow-form-actions">
              <button className="btn small primary" onClick={() => void api.call("flow.stopRecording").then(setRecording)}>
                Stop and review
              </button>
            </div>
          </div>
        </div>
      )}

      {recording && recording.phase === "review" && <ReviewCard api={api} recording={recording} onList={setList} onRecording={setRecording} onError={setError} />}

      {flows.length > 0 && (
        <div className="wf-filters">
          <div className="wf-seg" role="tablist" aria-label="Origin">
            {(
              [
                ["all", "All"],
                ["agent", "From agent runs"],
                ["recorded", "Recorded"],
                ["stale", "Needs attention"],
              ] as const
            ).map(([id, label]) => (
              <button key={id} role="tab" aria-selected={origin === id} className={origin === id ? "on" : ""} onClick={() => setOrigin(id)}>
                {label}
              </button>
            ))}
          </div>
          <select className="input wf-site-filter" value={site} onChange={(e) => setSite(e.target.value)} aria-label="Site">
            <option value="">All sites</option>
            {sites.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          <span className="muted small">
            {shown.length} of {flows.length}
          </span>
        </div>
      )}

      {list && flows.length === 0 && recording?.phase !== "recording" && !draft ? (
        <div className="card">
          <div className="empty">
            <IconPointer size={26} />
            <p>No workflows yet. Save one from a finished agent run, or record your own.</p>
          </div>
        </div>
      ) : (
        shown.length > 0 && (
          <div className="card">
            <div className="list">
              {shown.map((f) => (
                <FlowRow key={f.id} f={f} api={api} run={run} />
              ))}
            </div>
          </div>
        )
      )}
      {flows.length > 0 && shown.length === 0 && <div className="notice">No workflows match these filters.</div>}
      </>
      )}
    </PageShell>
  );
}

/** Everything Corvus learned about sites: inspect, remove single hints, forget a site or everything. */
function LearnedSites({ api, onError }: { api: Api; onError: (e: string | null) => void }) {
  const [state, setState] = useState<SiteMemoryState | null>(null);
  const [open, setOpen] = useState<Set<string> | null>(null);
  const [confirmAll, setConfirmAll] = useState(false);
  const load = useCallback(() => {
    void api.call("memory.state").then(setState);
  }, [api]);
  useEffect(() => {
    load();
    return api.onEvent((e) => {
      if (e.type === "flows-changed") load();
    });
  }, [api, load]);
  const act = (p: Promise<SiteMemoryState>): void => {
    onError(null);
    p.then(setState).catch((e: unknown) => onError(errorMessage(e)));
  };
  if (!state) return null;
  const isOpen = (host: string, i: number): boolean => (open ? open.has(host) : i === 0);
  const toggle = (host: string, i: number): void => {
    const next = new Set(open ?? (state.entries[0] ? [state.entries[0].host] : []));
    if (isOpen(host, i)) next.delete(host);
    else next.add(host);
    setOpen(next);
  };

  return (
    <>
      <div className="card">
        <div className="card-head mem-head">
          <div>
            <h2>Learned about sites</h2>
            <p className="muted">
              After each successful agent run, Corvus keeps a few small hints per site: which buttons and fields worked, URL shapes with the
              values removed, obstacles such as cookie banners, and the usual order of steps. A new task on that site gets the top hints (about
              300 tokens), marked as data, so it needs fewer steps. A saved workflow for the site always comes first. Never typed values,
              passwords or codes; at most 2 KB per site. With sync on, it syncs end to end to your other devices (Settings, Sync, Site
              memory), and forgetting here forgets there too.
            </p>
          </div>
          <div className="mem-head-ctrl">
            <span className="muted small">{state.enabled ? "Learning" : "Off"}</span>
            <Toggle label="Learn from runs (site memory)" checked={state.enabled} onChange={(v) => act(api.call("memory.setEnabled", v))} />
          </div>
        </div>
        <div className="card-body padded">
          <StatsLine stats={state.stats} />
          {state.entries.length > 0 && (
            <div className="flow-form-actions">
              <button
                className="btn small ghost danger"
                onClick={() => {
                  if (!confirmAll) return setConfirmAll(true);
                  setConfirmAll(false);
                  act(api.call("memory.forgetAll"));
                }}
              >
                {confirmAll ? "Click again to forget everything" : "Forget everything"}
              </button>
            </div>
          )}
        </div>
      </div>

      {state.entries.length === 0 ? (
        <div className="card">
          <div className="empty">
            <IconPointer size={26} />
            <p>Nothing learned yet. Hints appear here after successful agent runs.</p>
          </div>
        </div>
      ) : (
        <div className="card">
          <div className="list">
            {state.entries.map((e, i) => (
              <div key={e.host} className="list-row mem-row">
                <div className="grow mem-row-main">
                  <button className="link-button mem-host" onClick={() => toggle(e.host, i)}>
                    {e.host}
                  </button>
                  <div className="sub muted">
                    {e.runs} successful run{e.runs === 1 ? "" : "s"} · {hintCount(e)} hints · last {ago(e.lastSeen)}
                  </div>
                  {isOpen(e.host, i) && (
                    <div className="mem-row-body">
                      <LearnedSite entry={e} onRemove={(kind, key) => act(api.call("memory.removeHint", e.host, kind, key))} onForget={() => act(api.call("memory.forget", e.host))} />
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
}

function ReviewCard({
  api,
  recording,
  onList,
  onRecording,
  onError,
}: {
  api: Api;
  recording: FlowRecordingView;
  onList: (l: FlowView[]) => void;
  onRecording: (r: FlowRecordingView) => void;
  onError: (e: string | null) => void;
}) {
  const [name, setName] = useState(recording.suggestedName);
  const empty = recording.steps.length === 0;
  const save = (): void => {
    onError(null);
    api
      .call("flow.saveRecording", name.trim() || recording.suggestedName)
      .then((l) => {
        onList(l);
        void api.call("flow.recording").then(onRecording);
      })
      .catch((e: unknown) => onError(errorMessage(e)));
  };
  return (
    <div className="card">
      <div className="card-head">
        <h2>Save this recording</h2>
        <p className="muted">Review the captured steps, give the flow a name and save it. You can add parameters afterwards with Edit.</p>
      </div>
      <div className="card-body">
        <label className="field">
          <span>Name</span>
          <input className="input" placeholder="My flow" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </label>
        {empty ? <div className="notice">No steps were captured. Try recording again.</div> : <WorkflowStepList steps={recording.steps} />}
        <div className="flow-form-actions">
          <button className="btn small primary" disabled={empty} onClick={save}>
            Save flow
          </button>
          <button className="btn small ghost" onClick={() => void api.call("flow.discardRecording").then(onRecording)}>
            Discard
          </button>
        </div>
      </div>
    </div>
  );
}

function statusText(r: FlowReplayView): string {
  switch (r.status) {
    case "running":
      return `Running step ${r.cursor + 1} of ${r.total}`;
    case "paused":
      return "Paused";
    case "awaiting-approval":
      return "Waiting for your approval";
    case "done":
      return "Run finished";
    case "error":
      return r.error ? `Stopped: ${r.error}` : "Run failed";
    case "stopped":
      return "Run stopped";
  }
}

function FlowRow({ f, api, run }: { f: FlowView; api: Api; run: (p: Promise<FlowView[]>) => void }) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"view" | "run" | "edit">("view");
  const replay = f.replay;
  const active = replay != null && (replay.status === "running" || replay.status === "paused" || replay.status === "awaiting-approval");

  if (mode === "edit") {
    return (
      <div className="list-row flow-row editing">
        <div className="grow flow-main">
          <WorkflowEditor
            initial={editOf(f)}
            saveLabel="Save changes"
            cancelLabel="Cancel"
            onSave={(edit) => {
              run(api.call("flow.update", f.id, edit));
              setMode("view");
            }}
            onCancel={() => setMode("view")}
          />
        </div>
      </div>
    );
  }

  return (
    <div className={`list-row flow-row ${active ? "replaying" : ""}`}>
      <div className="grow flow-main">
        <div className="flow-title-row">
          <button className="link-button flow-title" onClick={() => setOpen((v) => !v)} title="Show steps">
            {f.name}
          </button>
          <OriginBadge origin={f.origin} />
          {replay && <span className={`pill flow-status ${replay.status}`}>{statusText(replay)}</span>}
        </div>
        {f.description && <div className="flow-desc">{f.description}</div>}
        <div className="sub muted">
          {flowSites(f).join(", ") || "any site"} · {f.steps.length} step{f.steps.length === 1 ? "" : "s"}
          {f.params.length > 0 ? ` · ${f.params.map((p) => `{{${p.name}}}`).join(" ")}` : ""} · saved {when(f.createdAt)}
        </div>
        <div className="flow-usage">
          <UsageLine usage={f.usage} />
        </div>

        {replay?.approval && <ApprovalBanner f={f} api={api} run={run} />}
        {mode === "run" && !active && (
          <WorkflowRunForm
            params={f.params}
            onRun={(values) => {
              run(api.call("flow.replay", f.id, values));
              setMode("view");
            }}
          />
        )}

        {(open || active) && <WorkflowStepList steps={f.steps} replay={replay} />}
      </div>

      <div className="flow-actions">
        {active ? (
          <>
            <button
              className="icon-btn"
              title={replay?.status === "paused" ? "Resume" : "Pause"}
              onClick={() => run(api.call("flow.pauseReplay", f.id, replay?.status !== "paused"))}
            >
              {replay?.status === "paused" ? <IconPlay size={15} /> : <IconPause size={15} />}
            </button>
            <button className="icon-btn danger" title="Stop" onClick={() => run(api.call("flow.stopReplay", f.id))}>
              <IconClose size={15} />
            </button>
          </>
        ) : (
          <>
            {mode === "run" ? (
              <button className="btn small ghost" onClick={() => setMode("view")}>
                Cancel
              </button>
            ) : (
              <button className="btn small primary" onClick={() => (f.params.length > 0 ? setMode("run") : run(api.call("flow.replay", f.id)))}>
                <IconPlay size={13} /> Run
              </button>
            )}
            <button className="icon-btn" title="Edit" onClick={() => setMode("edit")}>
              <IconEdit size={15} />
            </button>
            <button className="icon-btn" title="Delete" onClick={() => run(api.call("flow.remove", f.id))}>
              <IconTrash size={15} />
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function ApprovalBanner({ f, api, run }: { f: FlowView; api: Api; run: (p: Promise<FlowView[]>) => void }) {
  const a = f.replay!.approval!;
  const approveLabel = a.kind === "error" ? "Retry step" : a.kind === "handoff" ? "I did it, continue" : "Approve";
  return (
    <div className={`notice ${a.kind === "error" ? "error" : "warn"} flow-approval`}>
      <div className="flow-approval-text">
        <strong>{a.kind === "error" ? "Step needs attention" : "Approval needed"}</strong>
        <div>{a.reason}</div>
        <div className="muted small mono">{a.title}</div>
        {a.kind === "handoff" && <div className="muted small">Type the secret in the tab (and submit if needed), then continue.</div>}
      </div>
      <div className="flow-approval-actions">
        <button className="btn small primary" onClick={() => run(api.call("flow.approve", f.id, "approve"))}>
          {approveLabel}
        </button>
        <button className="btn small" onClick={() => run(api.call("flow.approve", f.id, "skip"))}>
          Skip step
        </button>
        <button className="btn small ghost danger" onClick={() => run(api.call("flow.approve", f.id, "stop"))}>
          Stop
        </button>
      </div>
    </div>
  );
}

mount(<FlowsPage />);
