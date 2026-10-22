import { useCallback, useEffect, useRef, useState } from "react";
import type { FlowStep } from "../../shared/flow";
import type { FlowRecordingView, FlowReplayView, FlowStepStatus, FlowView } from "../../shared/flow-ipc";
import { errorMessage, internalApi } from "../common/api";
import { IconClose, IconEdit, IconPause, IconPlay, IconPlus, IconPointer, IconTrash } from "../common/icons";
import "./flows.css";
import { PageShell, mount } from "./shell";

type Api = ReturnType<typeof internalApi>;

function hostOf(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

function when(ms: number): string {
  return new Date(ms).toLocaleString();
}

function stepIcon(kind: FlowStep["kind"]): string {
  if (kind === "navigate") return "→";
  if (kind === "type") return "⌨";
  return "•";
}

function FlowsPage() {
  const api = internalApi();
  const [list, setList] = useState<FlowView[] | null>(null);
  const [recording, setRecording] = useState<FlowRecordingView | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    void api.call("flow.list").then(setList);
    void api.call("flow.recording").then(setRecording);
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

  return (
    <PageShell
      title="Recorded flows"
      active="flows"
      toolbar={
        recording?.phase === "recording" ? (
          <span className="pill flow-rec-pill">Recording… {recording.steps.length} steps</span>
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

      {(!recording || recording.phase === "idle") && (
        <div className="card">
          <div className="card-head">
            <h2>Record and replay your own browsing</h2>
            <p className="muted">
              Start recording, then click, type and navigate in a web tab as usual. Corvus saves the steps as a named macro you can replay later.
              Replaying runs each step with the same engine the AI agent uses — anything risky (sign-in, payment, submitting a form) pauses and
              waits for your approval, and secret fields are never filled for you.
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
              {recording.atCap ? " (reached the step limit — stop and save)." : "."}
            </p>
          </div>
          <div className="card-body">
            <StepList steps={recording.steps} />
            <div className="flow-form-actions">
              <button className="btn small primary" onClick={() => void api.call("flow.stopRecording").then(setRecording)}>
                Stop & review
              </button>
            </div>
          </div>
        </div>
      )}

      {recording && recording.phase === "review" && <ReviewCard api={api} recording={recording} onList={setList} onRecording={setRecording} onError={setError} />}

      {list && flows.length === 0 && recording?.phase !== "recording" ? (
        <div className="card">
          <div className="empty">
            <IconPointer size={26} />
            <p>No saved flows yet. Record one to replay it later.</p>
          </div>
        </div>
      ) : (
        flows.length > 0 && (
          <div className="card">
            <div className="list">
              {flows.map((f) => (
                <FlowRow key={f.id} f={f} api={api} run={run} />
              ))}
            </div>
          </div>
        )
      )}
    </PageShell>
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
        <p className="muted">Review the captured steps, give the flow a name and save it.</p>
      </div>
      <div className="card-body">
        <label className="field">
          <span>Name</span>
          <input className="input" placeholder="My flow" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </label>
        {empty ? <div className="notice">No steps were captured. Try recording again.</div> : <StepList steps={recording.steps} />}
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

function StepList({ steps, replay }: { steps: FlowStep[]; replay?: FlowReplayView | null }) {
  return (
    <ol className="flow-steps">
      {steps.map((s, i) => {
        const status: FlowStepStatus | undefined = replay?.stepStatuses[i];
        const isCursor = replay != null && replay.cursor === i && (replay.status === "running" || replay.status === "awaiting-approval" || replay.status === "paused");
        return (
          <li key={i} className={`flow-step ${status ? `st-${status}` : ""} ${isCursor ? "cursor" : ""}`}>
            <span className="flow-step-mark">{stepIcon(s.kind)}</span>
            <span className="flow-step-label">{s.label}</span>
            {s.secret && <span className="pill tiny warn">secret</span>}
            {status && status !== "pending" && <span className={`pill tiny st-${status}`}>{status}</span>}
          </li>
        );
      })}
    </ol>
  );
}

function statusText(r: FlowReplayView): string {
  switch (r.status) {
    case "running":
      return `Replaying step ${r.cursor + 1} of ${r.total}`;
    case "paused":
      return "Paused";
    case "awaiting-approval":
      return "Waiting for your approval";
    case "done":
      return "Replay finished";
    case "error":
      return r.error ? `Stopped: ${r.error}` : "Replay failed";
    case "stopped":
      return "Replay stopped";
  }
}

function FlowRow({ f, api, run }: { f: FlowView; api: Api; run: (p: Promise<FlowView[]>) => void }) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(f.name);
  const inputRef = useRef<HTMLInputElement>(null);
  const replay = f.replay;
  const active = replay != null && (replay.status === "running" || replay.status === "paused" || replay.status === "awaiting-approval");

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  const commitRename = (): void => {
    setEditing(false);
    if (name.trim() && name.trim() !== f.name) run(api.call("flow.rename", f.id, name.trim()));
    else setName(f.name);
  };

  return (
    <div className={`list-row flow-row ${active ? "replaying" : ""}`}>
      <div className="grow flow-main">
        <div className="flow-title-row">
          {editing ? (
            <input
              ref={inputRef}
              className="input flow-name-input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onBlur={commitRename}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitRename();
                if (e.key === "Escape") (setEditing(false), setName(f.name));
              }}
            />
          ) : (
            <button className="link-button flow-title" onClick={() => setOpen((v) => !v)} title="Show steps">
              {f.name}
            </button>
          )}
          {replay && <span className={`pill flow-status ${replay.status}`}>{statusText(replay)}</span>}
        </div>
        <div className="sub muted">
          {hostOf(f.startUrl)} · {f.steps.length} step{f.steps.length === 1 ? "" : "s"} · saved {when(f.createdAt)}
        </div>

        {replay?.approval && <ApprovalBanner f={f} api={api} run={run} />}

        {(open || active) && <StepList steps={f.steps} replay={replay} />}
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
            <button className="icon-btn danger" title="Stop replay" onClick={() => run(api.call("flow.stopReplay", f.id))}>
              <IconClose size={15} />
            </button>
          </>
        ) : (
          <>
            <button className="btn small primary" onClick={() => run(api.call("flow.replay", f.id))}>
              <IconPlay size={13} /> Replay
            </button>
            <button className="icon-btn" title="Rename" onClick={() => (setName(f.name), setEditing(true))}>
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
  const approveLabel = a.kind === "error" ? "Retry step" : a.kind === "handoff" ? "I did it — continue" : "Approve";
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
