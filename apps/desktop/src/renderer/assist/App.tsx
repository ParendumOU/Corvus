import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import type { AgentActivityView, AssistBridge, AssistMessage, AssistPanelState, AssistTabView, WorkflowsPaneView } from "../../shared/assist-ipc";
import { MAX_COMPARE_TABS, type CompareCandidate } from "../../shared/compare";
import type { AssistAgentStep, AssistAgentView } from "../../shared/assist-agent";
import type { FlowView } from "../../shared/flow-ipc";
import { editOf } from "../../shared/workflow";
import { OriginBadge, UsageLine, WorkflowEditor, WorkflowRunForm, WorkflowStepList } from "../common/workflows";
import { LearnedSite, StatsLine } from "../common/site-memory";
import { prettyClientName } from "../../shared/agent-activity";
import { Favicon, Toggle, hostOf } from "../common/ui";
import {
  AssistMark,
  GlyphBroom,
  GlyphClose,
  GlyphCompare,
  GlyphPause,
  GlyphPen,
  GlyphPlay,
  GlyphPlug,
  GlyphSend,
  GlyphStop,
  GlyphSummary,
  GlyphTranslate,
  GlyphUndo,
} from "./glyphs";

declare global {
  interface Window {
    corvusAssist?: AssistBridge;
  }
}

const api = (): AssistBridge => {
  if (!window.corvusAssist) throw new Error("Assist bridge is not available");
  return window.corvusAssist;
};

const nf = new Intl.NumberFormat();

function langName(tag: string): string {
  try {
    return new Intl.DisplayNames([tag], { type: "language" }).of(tag.split("-")[0] ?? tag) ?? tag;
  } catch {
    return tag;
  }
}

function modelName(model: string): string {
  const m = /claude-([a-z]+)-(\d+)-(\d+)/.exec(model);
  return m ? `${m[1]!.charAt(0).toUpperCase()}${m[1]!.slice(1)} ${m[2]}.${m[3]}` : model;
}

export function App() {
  const [state, setState] = useState<AssistPanelState | null>(null);

  useEffect(() => {
    void api().call("state.get").then(setState);
    return api().onEvent((e) => setState(e.state));
  }, []);

  if (!state) return null;
  return (
    <div className="panel">
      <ResizeHandle />
      <header className="panel-head">
        <AssistMark size={20} />
        <div className="seg" role="tablist" aria-label="Panel view">
          <button role="tab" aria-selected={state.view === "assist"} className={state.view === "assist" ? "on" : ""} onClick={() => void api().call("panel.setView", "assist")}>
            Assist
          </button>
          <button role="tab" aria-selected={state.view === "agents"} className={state.view === "agents" ? "on" : ""} onClick={() => void api().call("panel.setView", "agents")}>
            Agents
            {state.agents.paused ? <span className="seg-dot paused" /> : state.agents.calls.some((c) => c.durationMs === null) ? <span className="seg-dot live" /> : null}
          </button>
          <button role="tab" aria-selected={state.view === "workflows"} className={state.view === "workflows" ? "on" : ""} onClick={() => void api().call("panel.setView", "workflows")}>
            Workflows
          </button>
        </div>
        <span className="grow" />
        <button className="icon-btn" title="Close (Ctrl+Shift+A)" onClick={() => void api().call("panel.close")}>
          <GlyphClose size={16} />
        </button>
      </header>
      {state.view === "assist" ? <AssistPane state={state} /> : state.view === "workflows" ? <WorkflowsPane view={state.workflows} /> : <AgentsPane agents={state.agents} />}
    </div>
  );
}

function ResizeHandle() {
  const drag = useRef<{ x: number; width: number; frame: number } | null>(null);
  const onDown = (e: PointerEvent<HTMLDivElement>): void => {
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { x: e.screenX, width: window.innerWidth, frame: 0 };
  };
  const onMove = (e: PointerEvent<HTMLDivElement>): void => {
    const d = drag.current;
    if (!d) return;
    const width = d.width + (d.x - e.screenX);
    cancelAnimationFrame(d.frame);
    d.frame = requestAnimationFrame(() => void api().call("panel.resize", width));
  };
  const onUp = (): void => {
    drag.current = null;
  };
  return <div className="resize" onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} title="Drag to resize" />;
}

// ------------------------------------------------------------------ assist

function AssistPane({ state }: { state: AssistPanelState }) {
  const tab = state.tab;
  const listRef = useRef<HTMLDivElement>(null);
  const last = tab?.messages.at(-1);

  useLayoutEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [tab?.tabId, tab?.messages.length, last?.text.length, last?.status, last?.agent?.steps.length, last?.agent?.approval?.id]);

  if (!state.ready) return <SetupState reason={state.setupReason} />;
  if (!tab) return <div className="empty">No tab is open.</div>;

  const waiting = state.waitingElsewhere;
  return (
    <>
      <PageContext tab={tab} state={state} />
      {waiting && (
        <div className="waiting-elsewhere">
          <span>Corvus is waiting for you in “{waiting.title || "another tab"}”.</span>
          <button className="btn small" onClick={() => void api().call("assist.showTab", waiting.tabId)}>
            Show
          </button>
        </div>
      )}
      {tab.comparePicker && <ComparePicker key={tab.comparePicker.map((c) => c.tabId).join()} candidates={tab.comparePicker} />}
      <div className="thread" ref={listRef}>
        {tab.messages.length === 0 ? (
          <Intro tab={tab} />
        ) : (
          tab.messages.map((m) => <Message key={m.id} m={m} lang={state.lang} />)
        )}
      </div>
      <Composer tab={tab} focusToken={state.focusToken} />
    </>
  );
}

function SetupState({ reason }: { reason: string | null }) {
  return (
    <div className="setup">
      <div className="setup-mark">
        <AssistMark size={44} />
      </div>
      <h2>Connect an AI provider</h2>
      <p>{reason ?? "Corvus Assist needs an AI provider."}</p>
      <p className="muted">Assist sends a trimmed copy of the page you ask about, about 2,000 tokens, in one request per action.</p>
      <button className="btn primary" onClick={() => void api().call("assist.openSettings")}>
        Open AI settings
      </button>
    </div>
  );
}

function PageContext({ tab, state }: { tab: AssistTabView; state: AssistPanelState }) {
  const translating = tab.translation === "working";
  return (
    <div className="context">
      <div className="context-page" title={tab.url}>
        <Favicon url={tab.url} {...(tab.faviconUrl ? { src: tab.faviconUrl } : {})} size={16} />
        <span className="context-title">{tab.title || hostOf(tab.url)}</span>
      </div>
      {tab.readable ? (
        <div className="actions">
          <button className="chip-btn" disabled={tab.busy} onClick={() => void api().call("assist.summarize")}>
            <GlyphSummary size={15} /> Summarize
          </button>
          {tab.translation === "translated" ? (
            <button className="chip-btn" onClick={() => void api().call("assist.restorePage")}>
              <GlyphUndo size={15} /> Show original
            </button>
          ) : (
            <button className="chip-btn" disabled={tab.busy || translating} onClick={() => void api().call("assist.translatePage")}>
              <GlyphTranslate size={15} /> Translate to {langName(state.lang)}
            </button>
          )}
          {tab.messages.length > 0 && (
            <button className="icon-btn small" title="Clear this conversation" onClick={() => void api().call("assist.clear")}>
              <GlyphBroom size={15} />
            </button>
          )}
        </div>
      ) : tab.canAct ? (
        <p className="context-note">Tell Corvus what to do: it can search, open sites and work in this tab while you watch.</p>
      ) : (
        <p className="context-note">Open a web page to summarize, translate or ask about it. Selected text works anywhere: right-click it.</p>
      )}
    </div>
  );
}

function Intro({ tab }: { tab: AssistTabView }) {
  if (tab.canAct) {
    return (
      <div className="intro">
        <p>Ask about this page, or tell Corvus what to do: “find the cheapest flight to Lisbon”, “open my GitLab issues and summarize the ones assigned to me”, “fill this form with my work address”.</p>
        <p className="muted">Corvus works in this tab while you watch, shows each step here, and asks before anything risky. Spending money always asks.</p>
      </div>
    );
  }
  if (!tab.readable) return null;
  return (
    <div className="intro">
      <p>Ask anything about this page, or start with a summary.</p>
      <p className="muted">The page text stays in your browser until you ask. Each action is one small request, and the tokens it used are shown under the answer.</p>
    </div>
  );
}

function Usage({ m }: { m: AssistMessage }) {
  const u = m.usage;
  if (!u) return null;
  const secs = (u.ms / 1000).toFixed(1);
  return (
    <div className="usage" title={u.model}>
      {u.cached ? `From cache, no tokens used (${modelName(u.model)})` : `${nf.format(u.inputTokens)} tokens in, ${nf.format(u.outputTokens)} out, ${secs} s with ${modelName(u.model)}`}
    </div>
  );
}

function Streaming() {
  return <div className="sheen-line" aria-label="Working" />;
}

function Cite({ n, sections, video }: { n: number; sections: string[] | undefined; video?: boolean | undefined }) {
  const heading = sections?.[n];
  // A video's sections are stretches of its transcript: the chip shows and plays from their timestamp.
  const title = heading ? (video ? `Play from ${heading}` : `Jump to “${heading}”`) : `Section ${n + 1}`;
  return (
    <button className={video ? "cite time" : "cite"} title={title} onClick={() => void api().call("assist.jumpToSection", n)}>
      {video && heading ? heading : n + 1}
    </button>
  );
}

/** Paragraphs, "- " bullets, **bold** and [n] section citations. */
function RichText({ text, sections, video }: { text: string; sections?: string[]; video?: boolean | undefined }) {
  const inline = (line: string, key: string): ReactNode[] => {
    const out: ReactNode[] = [];
    const re = /\*\*([^*]+)\*\*|\[(\d+(?:\s*,\s*\d+)*)\]/g;
    let last = 0;
    let i = 0;
    for (const m of line.matchAll(re)) {
      if (m.index! > last) out.push(line.slice(last, m.index));
      if (m[1]) out.push(<strong key={`${key}b${i++}`}>{m[1]}</strong>);
      else
        for (const part of m[2]!.split(",")) {
          const n = Number(part.trim()) - 1;
          if (sections && n >= 0 && n < sections.length) out.push(<Cite key={`${key}c${i++}`} n={n} sections={sections} video={video} />);
        }
      last = m.index! + m[0].length;
    }
    if (last < line.length) out.push(line.slice(last));
    return out;
  };
  const blocks: ReactNode[] = [];
  let bullets: string[] = [];
  const flush = (k: number): void => {
    if (bullets.length) blocks.push(<ul key={`u${k}`}>{bullets.map((b, j) => <li key={j}>{inline(b, `u${k}-${j}`)}</li>)}</ul>);
    bullets = [];
  };
  text.split(/\n/).forEach((raw, k) => {
    const line = raw.trim();
    const bullet = /^(?:[-*•]|\d+[.)])\s+(.*)$/.exec(line);
    if (bullet) bullets.push(bullet[1]!);
    else {
      flush(k);
      if (line) blocks.push(<p key={`p${k}`}>{inline(line.replace(/^#+\s*/, ""), `p${k}`)}</p>);
    }
  });
  flush(-1);
  return <div className="rich">{blocks}</div>;
}

function Message({ m, lang }: { m: AssistMessage; lang: string }) {
  const streaming = m.status === "streaming";
  const failed = m.status === "error" ? <p className="error">{m.error}</p> : m.status === "cancelled" ? <p className="muted small">Stopped.</p> : null;

  if (m.kind === "summarize") {
    const s = m.summary;
    return (
      <article className="msg summary">
        <div className="msg-label">
          <GlyphSummary size={14} /> Summary
          {m.readingMinutes ? <span className="read-time">{m.readingMinutes} min read</span> : null}
        </div>
        {streaming && !s?.tldr && <Streaming />}
        {s?.tldr ? <p className="tldr">{s.tldr}</p> : null}
        {s && s.points.length > 0 && (
          <ul className="points">
            {s.points.map((p, i) => (
              <li key={i}>
                <span>{p.text}</span>
                {p.sections.map((n) => (
                  <Cite key={n} n={n} sections={m.sections} video={m.video} />
                ))}
              </li>
            ))}
          </ul>
        )}
        {streaming && s?.tldr ? <Streaming /> : null}
        {failed}
        <Usage m={m} />
      </article>
    );
  }

  if (m.kind === "compare") {
    const c = m.comparison;
    return (
      <article className="msg compare">
        <div className="msg-label">
          <GlyphCompare size={14} /> {m.prompt}
        </div>
        {streaming && <Streaming />}
        {c && (
          <>
            <div className="compare-scroll">
              <table className="compare-table">
                <thead>
                  <tr>
                    <th />
                    {c.pages.map((p) => (
                      <th key={p.tabId}>
                        <button className="compare-page" title={`Show “${p.title}”`} onClick={() => void api().call("assist.showTab", p.tabId)}>
                          <Favicon url={p.url} {...(p.faviconUrl ? { src: p.faviconUrl } : {})} />
                          <span>{p.title || hostOf(p.url)}</span>
                        </button>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {c.rows.map((r, i) => (
                    <tr key={i}>
                      <th scope="row">{r.label}</th>
                      {r.values.map((v, j) => (
                        <td key={j}>{v}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {c.verdict ? <p className="compare-verdict">{c.verdict}</p> : null}
            <div className="write-actions">
              <button className="btn small" onClick={() => void api().call("assist.copyComparison", m.id)}>
                Copy table
              </button>
            </div>
          </>
        )}
        {failed}
        <Usage m={m} />
      </article>
    );
  }

  if (m.kind === "write") {
    const w = m.write;
    return (
      <article className="msg write">
        <div className="msg-label">
          <GlyphPen size={14} /> {m.prompt}
          {w?.site ? <span className="read-time">{w.site}</span> : null}
        </div>
        {m.text ? <div className="write-text">{m.text}</div> : null}
        {streaming && <Streaming />}
        {m.status === "done" && w && (
          <div className="write-actions">
            {w.inserted ? (
              <span className="muted small">Inserted into the field.</span>
            ) : w.gone ? (
              <span className="muted small">That field is no longer on the page: copy the text instead.</span>
            ) : (
              <button className="btn small primary" title="Put this text in the field" onClick={() => void api().call("assist.insertWrite", m.id)}>
                Insert into the field
              </button>
            )}
            <button className="btn small" onClick={() => void api().call("assist.copyText", m.id)}>
              Copy
            </button>
          </div>
        )}
        {failed}
        <Usage m={m} />
      </article>
    );
  }

  if (m.kind === "translate-page") {
    const [done, total] = m.text.split("/").map(Number);
    return (
      <article className="msg translate">
        <div className="msg-label">
          <GlyphTranslate size={14} /> Page translation
        </div>
        {streaming && (
          <>
            <p>{total ? `Translating ${done} of ${total} passages into ${langName(lang)}…` : "Collecting the page text…"}</p>
            <div className="progress">
              <span style={{ width: total ? `${Math.max(4, ((done ?? 0) / total) * 100)}%` : "4%" }} />
            </div>
          </>
        )}
        {m.status === "done" && (
          <>
            <p>
              Translated {m.translated} passages into {langName(lang)}.{m.more ? " There is more text further down." : ""}
            </p>
            <div className="row">
              <button className="btn small" onClick={() => void api().call("assist.restorePage")}>
                <GlyphUndo size={14} /> Show original
              </button>
              {m.more && (
                <button className="btn small" onClick={() => void api().call("assist.translateMore")}>
                  Translate the rest
                </button>
              )}
            </div>
          </>
        )}
        {failed}
        <Usage m={m} />
      </article>
    );
  }

  if (m.agent) {
    const agent = m.agent;
    return (
      <>
        <div className="question">{m.prompt}</div>
        <article className="msg ask agent">
          <AgentSteps agent={agent} />
          {agent.approval && <AgentApproval agent={agent} />}
          {m.text ? <RichText text={m.text} {...(m.sections ? { sections: m.sections } : {})} video={m.video} /> : null}
          {streaming && !agent.approval && <Streaming />}
          {agent.limit && (
            <p className="muted small">
              {agent.limit === "max_steps" ? `Stopped after ${agent.stepCount} steps, the limit for one request.` : "Stopped at the token budget for one request."} Say “continue” to keep going.
            </p>
          )}
          {failed}
          <Usage m={m} />
        </article>
      </>
    );
  }

  const isSelection = m.kind === "explain" || m.kind === "translate-selection";
  return (
    <>
      {m.kind === "ask" && <div className="question">{m.prompt}</div>}
      <article className={`msg ${m.kind}`}>
        {isSelection && (
          <>
            <div className="msg-label">
              {m.kind === "explain" ? <GlyphSummary size={14} /> : <GlyphTranslate size={14} />}
              {m.kind === "explain" ? "Explanation" : `Translation into ${langName(lang)}`}
            </div>
            <blockquote>{m.prompt}</blockquote>
          </>
        )}
        {m.text ? <RichText text={m.text} {...(m.sections ? { sections: m.sections } : {})} video={m.video} /> : streaming ? null : null}
        {streaming && <Streaming />}
        {failed}
        <Usage m={m} />
      </article>
    </>
  );
}

/** "Compare tabs": tick 2 to 6 of the window's pages and say what matters. */
function ComparePicker({ candidates }: { candidates: CompareCandidate[] }) {
  const [checked, setChecked] = useState(() => new Set(candidates.filter((c) => c.checked).map((c) => c.tabId)));
  const [focus, setFocus] = useState("");
  const toggle = (id: string): void =>
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else if (next.size < MAX_COMPARE_TABS) next.add(id);
      return next;
    });
  const compare = (): void => {
    const ids = candidates.filter((c) => checked.has(c.tabId)).map((c) => c.tabId);
    if (ids.length >= 2) void api().call("assist.compare", ids, focus.trim());
  };
  return (
    <div className="compare-picker">
      <div className="msg-label">
        <GlyphCompare size={14} /> Compare tabs
        <span className="read-time">
          {checked.size} of up to {MAX_COMPARE_TABS}
        </span>
      </div>
      <div className="compare-list">
        {candidates.map((c) => (
          <label key={c.tabId} className="compare-item">
            <input type="checkbox" checked={checked.has(c.tabId)} disabled={!checked.has(c.tabId) && checked.size >= MAX_COMPARE_TABS} onChange={() => toggle(c.tabId)} />
            <Favicon url={c.url} {...(c.faviconUrl ? { src: c.faviconUrl } : {})} />
            <span className="grow">{c.title || hostOf(c.url)}</span>
          </label>
        ))}
      </div>
      <input
        className="compare-focus"
        placeholder="What matters? E.g. price, battery life, weight"
        value={focus}
        maxLength={600}
        onChange={(e) => setFocus(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && compare()}
      />
      <div className="write-actions">
        <button className="btn small primary" disabled={checked.size < 2} onClick={compare}>
          Compare {checked.size} tabs
        </button>
        <button className="btn small" onClick={() => void api().call("assist.closeCompare")}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/** Steps shown before the older ones fold into "N earlier steps". */
const VISIBLE_STEPS = 6;

/** The agent's steps, compact: one line each, a thumbnail under screenshots, older ones folded. */
function AgentSteps({ agent }: { agent: AssistAgentView }) {
  const [all, setAll] = useState(false);
  if (agent.steps.length === 0) return null;
  const hidden = all ? 0 : Math.max(0, agent.steps.length - VISIBLE_STEPS);
  const shown = agent.steps.slice(hidden);
  return (
    <ol className="agent-steps" aria-label="Steps">
      {hidden > 0 && (
        <li className="astep more">
          <button className="link-btn" onClick={() => setAll(true)}>
            {hidden} earlier step{hidden === 1 ? "" : "s"}
          </button>
        </li>
      )}
      {shown.map((s) => (
        <AgentStepRow key={s.id} s={s} />
      ))}
    </ol>
  );
}

function AgentStepRow({ s }: { s: AssistAgentStep }) {
  if (s.kind === "message") {
    return <li className="astep note">{s.label}</li>;
  }
  return (
    <li className={`astep ${s.status}`} data-tool={s.kind}>
      <span className="astep-dot" aria-hidden="true" />
      <span className="astep-label">{s.label}</span>
      {s.status === "skipped" && <span className="astep-flag">skipped</span>}
      {s.thumb && <img className="astep-thumb" src={s.thumb} alt="Screenshot the assistant took" />}
    </li>
  );
}

/** The approval prompt of a running turn, answered right here in the conversation. */
function AgentApproval({ agent }: { agent: AssistAgentView }) {
  const a = agent.approval!;
  const decide = (d: "approve" | "skip" | "stop"): void => void api().call("assist.approve", d);
  return (
    <div className={`agent-approval ${a.handoff ? "handoff" : ""}`} role="alertdialog" aria-label={a.handoff ? "Over to you" : "Approve this action?"}>
      <strong>{a.handoff ? "Over to you" : "Approve this action?"}</strong>
      <p>{a.reason}</p>
      {a.summary && !a.handoff && <p className="muted small">{`${a.tool} ${a.summary}`}</p>}
      <div className="row">
        <button className="btn small primary" onClick={() => decide("approve")}>
          {a.handoff ? "I've done it" : "Approve"}
        </button>
        <button className="btn small" onClick={() => decide("skip")}>
          Skip
        </button>
        <button className="btn small ghost" onClick={() => decide("stop")}>
          Stop
        </button>
      </div>
    </div>
  );
}

function Composer({ tab, focusToken }: { tab: AssistTabView; focusToken: number }) {
  const [value, setValue] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    ref.current?.focus();
  }, [focusToken, tab.tabId]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(140, el.scrollHeight)}px`;
  }, [value]);

  const writing = tab.writing;
  const usable = tab.readable || tab.canAct || writing !== null;
  const send = useCallback(() => {
    const q = value.trim();
    if (!q || tab.busy || !usable) return;
    void api().call(writing ? "assist.write" : "assist.ask", q);
    setValue("");
  }, [value, tab.busy, usable, writing]);

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  const placeholder = writing
    ? "What should Corvus write in the field? E.g. a polite reply that says yes"
    : tab.canAct
      ? tab.readable
        ? "Ask about this page or tell Corvus what to do"
        : "Tell Corvus what to do"
      : tab.readable
        ? "Ask about this page"
        : "Open a web page to ask about it";
  return (
    <>
      {writing && (
        <div className="write-target">
          <GlyphPen size={14} />
          <span className="grow">
            Writing in a field on <strong>{writing.site || "this page"}</strong>
            {writing.excerpt ? <span className="muted"> · “{writing.excerpt}”</span> : null}
          </span>
          <button className="icon-btn" title="Cancel" onClick={() => void api().call("assist.cancelWrite")}>
            <GlyphClose size={14} />
          </button>
        </div>
      )}
      <div className="composer">
      <textarea
        ref={ref}
        rows={1}
        value={value}
        disabled={!usable}
        placeholder={placeholder}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={onKey}
        maxLength={tab.canAct || writing ? 2000 : 600}
      />
      {tab.busy ? (
        <button className="send stop" title="Stop" onClick={() => void api().call("assist.cancel")}>
          <GlyphStop size={16} />
        </button>
      ) : (
        <button className="send" title="Send (Enter)" disabled={!value.trim() || !usable} onClick={send}>
          <GlyphSend size={16} />
        </button>
      )}
      </div>
    </>
  );
}

// ------------------------------------------------------------------ agents

function clock(at: number): string {
  return new Date(at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function size(chars: number | null): string {
  if (chars === null) return "";
  return chars < 1000 ? `${chars} chars` : `${(chars / 1000).toFixed(chars < 10_000 ? 1 : 0)}k chars`;
}

function ago(at: number, now: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s} s ago`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m} min ago` : clock(at);
}

function AgentsPane({ agents }: { agents: AgentActivityView }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(t);
  }, []);
  const longest = Math.max(400, ...agents.calls.map((c) => c.durationMs ?? 0));
  const status = agents.paused
    ? { title: "Agents are paused", text: "Every tool call fails until you resume. Nothing in your tabs is touched." }
    : agents.mcpRunning
      ? { title: "Agents can control this browser", text: "Approved MCP clients can open tabs, read pages, click and type. You see each step on the page." }
      : { title: "The MCP server is off", text: "Turn it on in Settings, AI agents, to let Claude Code or another client drive Corvus." };

  return (
    <div className="agents">
      <section className={`kill ${agents.paused ? "paused" : ""}`}>
        <div>
          <h3>{status.title}</h3>
          <p>{status.text}</p>
        </div>
        <button className={`kill-btn ${agents.paused ? "resume" : ""}`} onClick={() => void api().call("agents.pause", !agents.paused)}>
          {agents.paused ? <GlyphPlay size={15} /> : <GlyphPause size={15} />}
          {agents.paused ? "Resume agents" : "Pause agents"}
        </button>
      </section>

      <section>
        <h4>Clients</h4>
        {agents.clients.length === 0 ? (
          <p className="muted small">No agent has connected since Corvus started.</p>
        ) : (
          <ul className="clients">
            {agents.clients.map((c) => {
              const live = c.status === "connected" && now - c.lastSeen < 60_000;
              return (
                <li key={c.name}>
                  <span className={`client-dot ${live ? "live" : c.status}`} />
                  <div className="client-main">
                    <strong>{prettyClientName(c.name)}</strong>
                    <span className="muted small">
                      {c.status === "revoked" ? "Access revoked" : c.status === "rejected" ? "Not approved" : `${c.calls} calls, last ${ago(c.lastSeen, now)}`}
                    </span>
                  </div>
                  {c.status === "connected" && (
                    <button className="btn small ghost danger" onClick={() => void api().call("agents.revoke", c.name)}>
                      Revoke
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="timeline-wrap">
        <div className="section-head">
          <h4>Timeline</h4>
          {agents.calls.length > 0 && (
            <button className="btn small ghost" onClick={() => void api().call("agents.clear")}>
              Clear
            </button>
          )}
        </div>
        {agents.calls.length === 0 ? (
          <div className="timeline-empty">
            <GlyphPlug size={22} />
            <p>Tool calls appear here live: what the agent asked for, how long it took and how much it read back.</p>
          </div>
        ) : (
          <ol className="timeline">
            {agents.calls.map((c) => (
              <li key={c.id} className={c.blocked ? "blocked" : c.ok === false ? "failed" : c.durationMs === null ? "running" : ""}>
                <span className="t-time">{clock(c.at)}</span>
                <div className="t-body">
                  <div className="t-line">
                    <strong className="t-tool">{c.tool}</strong>
                    {c.summary && <span className="t-args">{c.summary}</span>}
                  </div>
                  <div className="t-meta">
                    <span>{prettyClientName(c.client)}</span>
                    {c.blocked ? (
                      <span className="t-flag">Blocked while paused</span>
                    ) : c.durationMs === null ? (
                      <span className="t-flag live">Running</span>
                    ) : (
                      <>
                        <span>{c.durationMs} ms</span>
                        {c.resultChars !== null && <span>{size(c.resultChars)}</span>}
                        {c.ok === false && <span className="t-flag">Failed</span>}
                      </>
                    )}
                  </div>
                  {!c.blocked && (
                    <div className="t-bar">
                      <span style={{ width: c.durationMs === null ? "100%" : `${Math.max(2, (c.durationMs / longest) * 100)}%` }} />
                    </div>
                  )}
                </div>
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}

// ------------------------------------------------------------------ workflows

function errorText(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw.replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
}

function WorkflowsPane({ view }: { view: WorkflowsPaneView | null }) {
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<"saved" | "learned">("saved");
  const call = (p: Promise<unknown>): void => {
    setError(null);
    p.catch((e: unknown) => setError(errorText(e)));
  };
  if (!view) return <div className="empty">Loading workflows...</div>;
  const draft = view.draft;

  return (
    <div className="wf-pane">
      {error && <div className="wf-error">{error}</div>}
      {draft && (
        <section className="wf-card draft">
          <h3>Save as workflow</h3>
          <WorkflowEditor
            key={draft.createdAt}
            initial={draft.edit}
            intro={`Review the steps Corvus took for "${draft.task.slice(0, 120)}". Nothing is saved until you click Save.${draft.dropped > 0 ? ` ${draft.dropped} step${draft.dropped === 1 ? " was" : "s were"} left out (page reads, failed or skipped steps).` : ""}`}
            saveLabel="Save workflow"
            cancelLabel="Discard"
            onSave={(edit) => call(api().call("workflows.saveDraft", edit))}
            onCancel={() => call(api().call("workflows.discardDraft"))}
          />
        </section>
      )}

      <div className="wf-subtabs seg" role="tablist" aria-label="Workflows or learned hints">
        <button role="tab" aria-selected={tab === "saved"} className={tab === "saved" ? "on" : ""} onClick={() => setTab("saved")}>
          Saved{view.items.length ? ` (${view.items.length})` : ""}
        </button>
        <button role="tab" aria-selected={tab === "learned"} className={tab === "learned" ? "on" : ""} onClick={() => setTab("learned")}>
          Learned
        </button>
      </div>

      {tab === "learned" ? (
        <LearnedPane view={view} call={call} />
      ) : (
      <>
      <div className="wf-pane-head">
        <div>
          <h3>{view.host ? `Workflows for ${view.host}` : "Workflows"}</h3>
          <p className="muted small">
            {view.host ? `${view.items.length} saved for this site` : "Open a web page to see the workflows saved for it."}
          </p>
        </div>
        <button className="btn small ghost" onClick={() => call(api().call("workflows.openManager"))}>
          All workflows ({view.total})
        </button>
      </div>

      {view.host && view.items.length === 0 && !draft && (
        <div className="wf-empty">
          <p>No workflows for this site yet.</p>
          <p className="muted small">
            Ask Corvus to do a task here (Ctrl/Cmd+K, then Tab) and add "save this as a workflow", or use Save as workflow after any run. You can also record your own steps from the full list.
          </p>
        </div>
      )}

      {view.items.map((f) => (
        <WorkflowCard key={f.id} f={f} call={call} />
      ))}
      </>
      )}
    </div>
  );
}

function LearnedPane({ view, call }: { view: WorkflowsPaneView; call: (p: Promise<unknown>) => void }) {
  const mem = view.memory;
  return (
    <div className="mem-pane">
      <div className="wf-pane-head">
        <div>
          <h3>{view.host ? `Learned about ${view.host}` : "Learned about sites"}</h3>
          <p className="muted small">Small hints from successful runs, so the agent needs fewer steps here. Synced end to end when Site memory sync is on.</p>
        </div>
        <div className="mem-switch">
          <span>{mem.enabled ? "Learning" : "Off"}</span>
          <Toggle label="Learn from runs (site memory)" checked={mem.enabled} onChange={(v) => call(api().call("memory.setEnabled", v))} />
        </div>
      </div>
      {!mem.enabled && <div className="wf-empty"><p>Learning is off. Nothing new is learned or sent to the agent; what is below is kept until you forget it.</p></div>}
      {mem.entry ? (
        <section className="wf-card">
          <LearnedSite
            entry={mem.entry}
            compact
            onRemove={(kind, key) => call(api().call("memory.removeHint", mem.entry!.host, kind, key))}
            onForget={() => call(api().call("memory.forget", mem.entry!.host))}
          />
        </section>
      ) : (
        view.host && (
          <div className="wf-empty">
            <p>Nothing learned about this site yet.</p>
            <p className="muted small">After a successful agent run here, Corvus keeps which buttons and fields worked, URL shapes and obstacles. Never what you typed.</p>
          </div>
        )
      )}
      <StatsLine stats={mem.stats} />
      <div className="wf-actions">
        <button className="btn small ghost" onClick={() => call(api().call("workflows.openManager"))}>
          All learned sites ({mem.totalHosts})
        </button>
      </div>
    </div>
  );
}

function WorkflowCard({ f, call }: { f: FlowView; call: (p: Promise<unknown>) => void }) {
  const [mode, setMode] = useState<"view" | "run" | "edit">("view");
  const replay = f.replay;
  const active = replay != null && (replay.status === "running" || replay.status === "paused" || replay.status === "awaiting-approval");

  if (mode === "edit") {
    return (
      <section className="wf-card">
        <WorkflowEditor
          initial={editOf(f)}
          saveLabel="Save changes"
          cancelLabel="Cancel"
          onSave={(edit) => {
            call(api().call("workflows.update", f.id, edit));
            setMode("view");
          }}
          onCancel={() => setMode("view")}
        />
      </section>
    );
  }

  return (
    <section className={`wf-card ${active ? "live" : ""}`}>
      <div className="wf-card-head">
        <strong className="wf-card-name">{f.name}</strong>
        <OriginBadge origin={f.origin} />
      </div>
      {f.description && <p className="wf-card-desc">{f.description}</p>}
      <div className="wf-card-meta">
        <span>
          {f.steps.length} step{f.steps.length === 1 ? "" : "s"}
          {f.params.length > 0 ? ` · ${f.params.map((p) => `{{${p.name}}}`).join(" ")}` : ""}
        </span>
        <UsageLine usage={f.usage} />
      </div>
      <WorkflowStepList steps={f.steps} replay={replay} limit={active ? undefined : 4} />

      {replay?.approval && (
        <div className="wf-approval">
          <strong>{replay.approval.kind === "error" ? "Step needs attention" : replay.approval.kind === "handoff" ? "Over to you" : "Approve this step?"}</strong>
          <span>{replay.approval.reason}</span>
          <div className="wf-actions">
            <button className="btn small primary" onClick={() => call(api().call("workflows.approve", f.id, "approve"))}>
              {replay.approval.kind === "error" ? "Retry" : replay.approval.kind === "handoff" ? "I've done it" : "Approve"}
            </button>
            <button className="btn small" onClick={() => call(api().call("workflows.approve", f.id, "skip"))}>
              Skip
            </button>
            <button className="btn small ghost" onClick={() => call(api().call("workflows.approve", f.id, "stop"))}>
              Stop
            </button>
          </div>
        </div>
      )}

      {mode === "run" && !active && (
        <WorkflowRunForm
          params={f.params}
          compact
          onRun={(values) => {
            call(api().call("workflows.run", f.id, values));
            setMode("view");
          }}
        />
      )}

      <div className="wf-actions">
        {active ? (
          <button className="btn small danger" onClick={() => call(api().call("workflows.stop", f.id))}>
            Stop
          </button>
        ) : mode === "run" ? (
          <button className="btn small ghost" onClick={() => setMode("view")}>
            Cancel
          </button>
        ) : (
          <>
            <button className="btn small primary" onClick={() => (f.params.length > 0 ? setMode("run") : call(api().call("workflows.run", f.id, {})))}>
              <GlyphPlay size={13} /> Run
            </button>
            <button className="btn small" onClick={() => setMode("edit")}>
              Edit
            </button>
            <button className="btn small ghost danger" onClick={() => call(api().call("workflows.remove", f.id))}>
              Delete
            </button>
          </>
        )}
      </div>
    </section>
  );
}
