import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import type { AgentActivityView, AssistBridge, AssistMessage, AssistPanelState, AssistTabView } from "../../shared/assist-ipc";
import { prettyClientName } from "../../shared/agent-activity";
import { Favicon, hostOf } from "../common/ui";
import {
  AssistMark,
  GlyphBroom,
  GlyphClose,
  GlyphPause,
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
        </div>
        <span className="grow" />
        <button className="icon-btn" title="Close (Ctrl+Shift+A)" onClick={() => void api().call("panel.close")}>
          <GlyphClose size={16} />
        </button>
      </header>
      {state.view === "assist" ? <AssistPane state={state} /> : <AgentsPane agents={state.agents} />}
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
  }, [tab?.tabId, tab?.messages.length, last?.text.length, last?.status]);

  if (!state.ready) return <SetupState reason={state.setupReason} />;
  if (!tab) return <div className="empty">No tab is open.</div>;

  return (
    <>
      <PageContext tab={tab} state={state} />
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
      ) : (
        <p className="context-note">Open a web page to summarize, translate or ask about it. Selected text works anywhere: right-click it.</p>
      )}
    </div>
  );
}

function Intro({ tab }: { tab: AssistTabView }) {
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

function Cite({ n, sections }: { n: number; sections: string[] | undefined }) {
  const heading = sections?.[n];
  return (
    <button className="cite" title={heading ? `Jump to “${heading}”` : `Section ${n + 1}`} onClick={() => void api().call("assist.jumpToSection", n)}>
      {n + 1}
    </button>
  );
}

/** Paragraphs, "- " bullets, **bold** and [n] section citations. */
function RichText({ text, sections }: { text: string; sections?: string[] }) {
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
          if (sections && n >= 0 && n < sections.length) out.push(<Cite key={`${key}c${i++}`} n={n} sections={sections} />);
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
                  <Cite key={n} n={n} sections={m.sections} />
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
        {m.text ? <RichText text={m.text} {...(m.sections ? { sections: m.sections } : {})} /> : streaming ? null : null}
        {streaming && <Streaming />}
        {failed}
        <Usage m={m} />
      </article>
    </>
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

  const send = useCallback(() => {
    const q = value.trim();
    if (!q || tab.busy || !tab.readable) return;
    void api().call("assist.ask", q);
    setValue("");
  }, [value, tab.busy, tab.readable]);

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  return (
    <div className="composer">
      <textarea
        ref={ref}
        rows={1}
        value={value}
        disabled={!tab.readable}
        placeholder={tab.readable ? "Ask about this page" : "Open a web page to ask about it"}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={onKey}
        maxLength={600}
      />
      {tab.busy ? (
        <button className="send stop" title="Stop" onClick={() => void api().call("assist.cancel")}>
          <GlyphStop size={16} />
        </button>
      ) : (
        <button className="send" title="Ask (Enter)" disabled={!value.trim() || !tab.readable} onClick={send}>
          <GlyphSend size={16} />
        </button>
      )}
    </div>
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
