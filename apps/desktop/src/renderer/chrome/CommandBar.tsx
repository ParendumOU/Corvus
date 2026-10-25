import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import {
  AGENT_PREFIX,
  parseCommandInput,
  rankActions,
  type PaletteAction,
  type PaletteIcon,
} from "../../shared/command-bar";
import type { AgentRunStep, AgentRunView } from "../../shared/command-bar-ipc";
import type { CommandRecent } from "../../shared/command-history";
import type { SemanticHit } from "../../shared/semantic-search-ipc";
import type { WindowState } from "../../shared/ipc";
import { classifyOmnibox, intentToUrl } from "../../shared/omnibox";
import { chromeApi } from "../common/api";
import {
  IconActivity,
  IconAgent,
  IconDownload,
  IconFolder,
  IconGlobe,
  IconHistory,
  IconPause,
  IconPlay,
  IconPlus,
  IconPuzzle,
  IconSearch,
  IconSettings,
  IconShield,
  IconSparkle,
  IconStar,
} from "../common/icons";
import { Favicon } from "../common/ui";
import { useHoverSelect } from "./hover-select";

import { t } from "../common/i18n";
interface UiAction {
  action: PaletteAction;
  run: () => void;
}

const ICONS: Record<PaletteIcon, (p: { size?: number }) => JSX.Element> = {
  search: IconSearch,
  navigate: IconGlobe,
  tab: IconGlobe,
  history: IconHistory,
  bookmark: (p) => <IconStar {...p} filled />,
  newtab: IconPlus,
  settings: IconSettings,
  extensions: IconPuzzle,
  downloads: IconDownload,
  webscope: IconShield,
  bookmarks: IconFolder,
  assist: IconSparkle,
  organize: IconFolder,
  agent: IconAgent,
};

function ActionIcon({ action }: { action: PaletteAction }) {
  if (action.kind === "tab" || (action.kind === "bookmark" && action.keywords)) {
    return <Favicon url={action.keywords ?? ""} size={16} />;
  }
  const Icon = ICONS[action.icon] ?? IconGlobe;
  return <Icon size={16} />;
}

export function CommandBar({ state, onClose, onOrganize }: { state: WindowState; onClose: () => void; onOrganize: () => void }) {
  const api = chromeApi();
  const [value, setValue] = useState("");
  const [selected, setSelected] = useState(0);
  const hoverSelect = useHoverSelect(setSelected);
  const [suggestions, setSuggestions] = useState<UiAction[]>([]);
  const [localHits, setLocalHits] = useState<SemanticHit[]>([]);
  const [recents, setRecents] = useState<CommandRecent[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const request = useRef(0);

  const run = state.agentRun;
  const parsed = parseCommandInput(value);
  const showRun = run !== null && value.trim() === "";

  useEffect(() => {
    inputRef.current?.focus();
    void api.call("commands.recent").then(setRecents);
  }, [api]);

  const staticActions = useMemo<UiAction[]>(() => {
    // Actions that take the user somewhere close the bar; the agent row keeps it open for its run.
    const andClose = (fn: () => void): (() => void) => () => {
      fn();
      onClose();
    };
    const open = (url: string): (() => void) => andClose(() => void api.call("tabs.openUrl", url, "new-tab"));
    const items: UiAction[] = [
      { action: { id: "newtab", kind: "command", title: t("New tab"), icon: "newtab", priority: 4 }, run: andClose(() => void api.call("tabs.create", {})) },
      { action: { id: "settings", kind: "command", title: t("Open settings"), icon: "settings", priority: 2 }, run: open("corvus://settings/") },
      { action: { id: "bookmarks", kind: "command", title: t("Open bookmarks"), icon: "bookmarks", priority: 1 }, run: open("corvus://bookmarks/") },
      { action: { id: "history", kind: "command", title: t("Open history"), icon: "history", priority: 1 }, run: open("corvus://history/") },
      { action: { id: "downloads", kind: "command", title: t("Open downloads"), icon: "downloads" }, run: open("corvus://downloads/") },
      { action: { id: "extensions", kind: "command", title: t("Open extensions"), icon: "extensions" }, run: open("corvus://extensions/") },
      { action: { id: "webscope", kind: "command", title: t("Open WebScope"), icon: "webscope" }, run: open("corvus://webscope/") },
      { action: { id: "assist", kind: "command", title: t("Toggle Corvus Assist"), icon: "assist" }, run: andClose(() => void api.call("assist.toggle")) },
      { action: { id: "organize", kind: "command", title: t("Organize tabs into groups"), icon: "organize" }, run: onOrganize },
    ];
    for (const tab of state.tabs) {
      if (tab.id === state.activeTabId) continue;
      items.push({
        action: { id: `tab:${tab.id}`, kind: "tab", title: tab.title || tab.url, subtitle: hostOf(tab.url), keywords: tab.url, icon: "tab" },
        run: andClose(() => void api.call("tabs.activate", tab.id)),
      });
    }
    return items;
  }, [api, state.tabs, state.activeTabId, onOrganize, onClose]);

  // Query-dependent actions: the agent task, the web search / open URL, and ranked history/bookmarks.
  const dynamic = useMemo<UiAction[]>(() => {
    const q = value.trim();
    const out: UiAction[] = [];
    if (parsed.mode === "agent") {
      const task = parsed.query.trim();
      out.push({
        action: { id: "agent", kind: "agent", title: task ? t("Ask Corvus to: {task}", { task }) : t("Ask Corvus to do a task…"), subtitle: t("Runs an agent in a new tab"), icon: "agent", priority: 100 },
        run: () => startAgent(task),
      });
      return out;
    }
    if (q) {
      const intent = classifyOmnibox(q);
      if (intent.kind === "url") {
        out.push({
          action: { id: "open-url", kind: "navigate", title: t("Open {url}", { url: intent.url }), icon: "navigate", priority: 50 },
          run: () => commit(intent.url, { kind: "url", text: intent.url }),
        });
      } else {
        out.push({
          action: { id: "search", kind: "search", title: t("Search the web for \"{query}\"", { query: intent.query }), icon: "search", priority: 50 },
          run: () => commit(intentToUrl(intent), { kind: "search", text: intent.query }),
        });
      }
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const fetchSuggestions = useCallback(
    (text: string): void => {
      const id = ++request.current;
      const q = text.trim();
      if (!q || q.startsWith(AGENT_PREFIX)) {
        setSuggestions([]);
        setLocalHits([]);
        return;
      }
      void api.call("omnibox.suggest", q).then((list) => {
        if (id !== request.current) return;
        setSuggestions(
          list
            .filter((s) => s.kind === "history" || s.kind === "bookmark")
            .map((s) => ({
              action: { id: `sugg:${s.url}`, kind: s.kind, title: s.title, subtitle: s.detail, keywords: s.url, icon: s.kind === "bookmark" ? "bookmark" : "history" } as PaletteAction,
              run: () => commit(s.url),
            })),
        );
      });
      void api.call("search.local", q).then((res) => {
        if (id !== request.current) return;
        setLocalHits(res.hits);
      });
    },
    [api],
  );

  const ranked = useMemo(() => {
    const pool = [...dynamic, ...staticActions, ...suggestions];
    const byId = new Map(pool.map((u) => [u.action.id, u]));
    const q = parsed.mode === "agent" ? "" : value.trim();
    return rankActions(q, pool.map((u) => u.action), 10)
      .map((a) => byId.get(a.id))
      .filter((u): u is UiAction => u !== undefined);
  }, [dynamic, staticActions, suggestions, value, parsed.mode]);

  // "Find in my history": semantic/keyword hits over the user's own pages, shown as their own
  // section (not re-fuzzed), deduped against whatever the fuzzy list already surfaced.
  const localItems = useMemo<UiAction[]>(() => {
    if (parsed.mode === "agent" || value.trim() === "") return [];
    const seen = new Set(ranked.map((u) => u.action.keywords ?? u.action.id));
    return localHits
      .filter((h) => !seen.has(h.url))
      .map((h) => ({
        action: {
          id: `local:${h.id}`,
          kind: "tab",
          title: h.title || h.url,
          subtitle: h.snippet || hostOf(h.url),
          keywords: h.url,
          icon: "history",
        } as PaletteAction,
        run: () => commit(h.url),
      }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [localHits, ranked, parsed.mode, value]);

  // "Recent": what was run from the bar, while it is empty. A task comes back as "> task" to read
  // (and change) before Enter runs it again; a search or an address opens.
  const recentItems = useMemo<UiAction[]>(() => {
    if (value !== "") return [];
    return recents.map((r) => {
      const subtitle = r.kind === "agent" ? t("Agent task") : r.kind === "search" ? t("Web search") : hostOf(r.text);
      const icon: PaletteIcon = r.kind === "agent" ? "agent" : r.kind === "search" ? "search" : "navigate";
      return {
        action: { id: `recent:${r.id}`, kind: r.kind === "agent" ? "agent" : r.kind === "search" ? "search" : "navigate", title: r.text, subtitle, icon } as PaletteAction,
        run: () => {
          if (r.kind === "agent") {
            setValue(`${AGENT_PREFIX} ${r.text}`);
            inputRef.current?.focus();
            return;
          }
          const intent = classifyOmnibox(r.text);
          commit(intentToUrl(intent), { kind: r.kind, text: r.text });
        },
      };
    });
  }, [recents, value]);

  const rows = useMemo(() => [...recentItems, ...ranked, ...localItems], [recentItems, ranked, localItems]);
  const firstActionIndex = recentItems.length;
  const firstLocalIndex = recentItems.length + ranked.length;

  useEffect(() => setSelected(0), [value]);
  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [selected, rows.length]);

  function commit(url: string, remember?: { kind: "search" | "url"; text: string }): void {
    if (remember) void api.call("commands.remember", remember.kind, remember.text);
    void api.call("tabs.openUrl", url, "current");
    onClose();
  }

  function forget(id: string): void {
    void api.call("commands.forget", id).then(setRecents);
  }

  function startAgent(task: string): void {
    if (!task) return;
    if (!state.agentReady) {
      void api.call("tabs.openUrl", "corvus://settings/#command-agent", "new-tab");
      onClose();
      return;
    }
    void api.call("commands.remember", "agent", task);
    void api.call("agent.start", task);
    setValue("");
  }

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "Tab") {
      e.preventDefault();
      setValue((v) => (v.trimStart().startsWith(AGENT_PREFIX) ? v.replace(/^\s*>\s?/, "") : `> ${v}`));
    } else if (showRun) {
      return;
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelected((s) => (rows.length ? (s + 1) % rows.length : 0));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelected((s) => (rows.length ? (s - 1 + rows.length) % rows.length : 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (parsed.mode === "agent") startAgent(parsed.query.trim());
      else rows[selected]?.run();
    }
  };

  return (
    <div className="cmdbar" role="dialog" aria-label={t("Command Bar")} onMouseDown={(e) => e.stopPropagation()}>
      <div className={`cmd-field ${parsed.mode === "agent" ? "agent" : ""}`}>
        <span className="cmd-lead">{parsed.mode === "agent" ? <IconAgent size={17} /> : <IconSearch size={16} />}</span>
        <input
          ref={inputRef}
          className="cmd-input"
          spellCheck={false}
          value={value}
          placeholder={parsed.mode === "agent" ? t("Describe the task for Corvus to do…") : t("Search tabs and actions, type a URL, or “> ” to ask Corvus")}
          onChange={(e) => {
            setValue(e.target.value);
            fetchSuggestions(e.target.value);
          }}
          onKeyDown={onKeyDown}
        />
        <kbd className="cmd-hint">{parsed.mode === "agent" ? t("Enter to run") : t("Tab for agent")}</kbd>
      </div>

      {showRun ? (
        <RunPanel run={run!} state={state} api={api} />
      ) : (
        <ul className="cmd-list" ref={listRef} role="listbox">
          {rows.length === 0 && <li className="cmd-empty">{t("No matches. Press Tab to ask Corvus to do it.")}</li>}
          {rows.map((u, i) => (
            <Fragment key={u.action.id}>
              {i === 0 && recentItems.length > 0 && (
                <li className="cmd-section" role="presentation">{t("Recent")}</li>
              )}
              {i === firstActionIndex && recentItems.length > 0 && ranked.length > 0 && (
                <li className="cmd-section" role="presentation">{t("Actions")}</li>
              )}
              {i === firstLocalIndex && localItems.length > 0 && (
                <li className="cmd-section" role="presentation">{t("Find in my history")}</li>
              )}
              <li
                role="option"
                aria-selected={i === selected}
                className={`cmd-row ${i === selected ? "sel" : ""} ${u.action.kind === "agent" ? "agent" : ""}`}
                onMouseMove={hoverSelect(i)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  u.run();
                }}
              >
                <span className="cmd-icon">
                  <ActionIcon action={u.action} />
                </span>
                <span className="cmd-title">{u.action.title}</span>
                {u.action.subtitle && <span className="cmd-sub">{u.action.subtitle}</span>}
                {u.action.kind === "agent" && <span className="cmd-tag">{t("Agent")}</span>}
                {u.action.id.startsWith("recent:") && (
                  <button
                    type="button"
                    className="cmd-forget"
                    title={t("Remove from Recent")}
                    aria-label={t("Remove from Recent")}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      forget(u.action.id.slice("recent:".length));
                    }}
                  >
                    ×
                  </button>
                )}
              </li>
            </Fragment>
          ))}
        </ul>
      )}
    </div>
  );
}

const STATUS_LABEL: Record<AgentRunView["status"], string> = {
  running: t("Working"),
  paused: t("Paused"),
  "awaiting-approval": t("Needs your OK"),
  done: t("Done"),
  error: t("Failed"),
  stopped: t("Stopped"),
};

function RunPanel({ run, state, api }: { run: AgentRunView; state: WindowState; api: ReturnType<typeof chromeApi> }) {
  const active = run.status === "running" || run.status === "paused" || run.status === "awaiting-approval";
  const bottomRef = useRef<HTMLDivElement>(null);
  // Workflows: a finished run with successful click/type/navigate steps can be saved (after review).
  const savable = !active && run.steps.some((s) => s.action !== undefined && s.status === "ok");
  const [offerDismissed, setOfferDismissed] = useState(false);
  const saveWorkflow = (): void => void api.call("workflow.saveFromRun");
  useEffect(() => {
    // scrollIntoView can be absent in some embedded renderers; guard it and keep the effect's
    // return undefined (an expression body would hand React a non-function "cleanup").
    bottomRef.current?.scrollIntoView?.({ block: "end" });
  }, [run.steps]);

  if (!state.agentReady && run.status === "error") {
    return (
      <div className="run-panel">
        <div className="run-setup">
          <p>{state.agentSetupReason ?? run.error}</p>
          <button className="btn" onMouseDown={(e) => { e.preventDefault(); void api.call("tabs.openUrl", "corvus://settings/#command-agent", "new-tab"); }}>{t("Open settings")}</button>
        </div>
      </div>
    );
  }

  return (
    <div className="run-panel">
      {state.agentOthers.length > 0 && (
        <div className="run-others" data-run-others>
          <span className="run-others-title">{t("Other tasks")}</span>
          {state.agentOthers.map((o) => (
            <button
              key={o.id}
              className={`run-other ${o.status}`}
              title={o.task}
              onMouseDown={(e) => {
                e.preventDefault();
                void api.call("agent.focus", o.id);
              }}
            >
              <span className="run-other-dot" aria-hidden />
              {o.task}
            </button>
          ))}
        </div>
      )}
      <div className="run-head">
        <IconAgent size={16} />
        <span className="run-task">{run.task}</span>
        <span className={`run-chip ${run.status}`}>{STATUS_LABEL[run.status]}</span>
      </div>
      <div className="run-meta">
        <span>{run.stepCount}{t("/{maxSteps} steps", { maxSteps: run.maxSteps })}</span>
        <span title={run.cachedInputTokens ? t("{cached} input tokens reused from the prompt cache", { cached: run.cachedInputTokens.toLocaleString() }) : undefined}>{(run.inputTokens + run.outputTokens).toLocaleString()}{" "}{t("tokens")}</span>
        {run.siteHints && run.siteHints.workflows > 0 && <span title={t("Saved workflows for this site were offered to the agent")}>{run.siteHints.workflows}{" "}{t("workflow")}{run.siteHints.workflows === 1 ? "" : "s"}</span>}
        {run.siteHints && run.siteHints.hints > 0 && <span title={t("Learned hints about this site were given to the agent")}>{run.siteHints.hints}{" "}{t("site hints")}</span>}
        <span className="run-model">{run.model}</span>
      </div>

      <div className="run-steps">
        {run.steps.map((s) => (
          <StepRow key={s.id} step={s} />
        ))}
        {run.error && <div className="run-error">{run.error}</div>}
        <div ref={bottomRef} />
      </div>

      {run.leftTabs && run.leftTabs.length > 0 && (
        <div className="run-left" data-run-left>
          <span className="run-left-title">{t("Left open for you")}</span>
          {run.leftTabs.map((tab) => (
            <button key={tab.id} className="run-left-tab" title={tab.url} onMouseDown={(e) => { e.preventDefault(); void api.call("tabs.activate", tab.id); }}>
              {tab.title || tab.url}
            </button>
          ))}
        </div>
      )}

      {run.takenOver && !run.approval && (
        <div className="run-approval" data-took-over>
          <div className="appr-text">
            <strong>{t("You took over")}</strong>
            <span>{t("Corvus waits while you use the page. Hand it back when you are done.")}</span>
          </div>
          <div className="appr-actions">
            <button className="btn" onMouseDown={(e) => { e.preventDefault(); void api.call("agent.handBack"); }}>{t("Hand it back")}</button>
            <button className="btn danger" onMouseDown={(e) => { e.preventDefault(); void api.call("agent.stop"); }}>{t("Stop")}</button>
          </div>
        </div>
      )}

      {run.approval && (
        <div className="run-approval">
          <div className="appr-text">
            <strong>{run.approval.handoff ? t("Over to you") : t("Approve this action?")}</strong>
            <span>{run.approval.reason}</span>
            {!run.approval.handoff && run.approval.summary && <code>{run.approval.summary}</code>}
          </div>
          <div className="appr-actions">
            <button className="btn" onMouseDown={(e) => { e.preventDefault(); void api.call("agent.approve", "approve"); }}>
              {run.approval.handoff ? t("I've done it") : t("Approve")}
            </button>
            <button className="btn ghost" onMouseDown={(e) => { e.preventDefault(); void api.call("agent.approve", "skip"); }}>{t("Skip")}</button>
            <button className="btn danger" onMouseDown={(e) => { e.preventDefault(); void api.call("agent.approve", "stop"); }}>{t("Stop")}</button>
          </div>
        </div>
      )}

      {savable && run.offerWorkflow && run.status === "done" && !offerDismissed && (
        <div className="run-approval run-offer">
          <div className="appr-text">
            <strong>{t("Save these steps as a workflow?")}</strong>
            <span>{t("You said this task is repetitive. Review the steps, pick what to fill in each time, and run it again in one go.")}</span>
          </div>
          <div className="appr-actions">
            <button className="btn" onMouseDown={(e) => { e.preventDefault(); saveWorkflow(); }}>{t("Review and save")}</button>
            <button className="btn ghost" onMouseDown={(e) => { e.preventDefault(); setOfferDismissed(true); }}>{t("Not now")}</button>
          </div>
        </div>
      )}

      <div className="run-controls">
        {active ? (
          <>
            <button className="btn ghost" onMouseDown={(e) => { e.preventDefault(); void api.call("agent.pause", !state.agentsPaused); }}>
              {state.agentsPaused ? <IconPlay size={14} /> : <IconPause size={14} />}
              {state.agentsPaused ? t("Resume") : t("Pause")}
            </button>
            <button className="btn danger" onMouseDown={(e) => { e.preventDefault(); void api.call("agent.stop"); }}>{t("Stop")}</button>
          </>
        ) : (
          <>
            <button className="btn ghost" onMouseDown={(e) => { e.preventDefault(); void api.call("agent.clear"); }}>{t("Clear")}</button>
            {savable && (
              <button className="btn ghost run-save-wf" onMouseDown={(e) => { e.preventDefault(); saveWorkflow(); }}>{t("Save as workflow")}</button>
            )}
            <button className="btn" onMouseDown={(e) => { e.preventDefault(); void api.call("assist.toggle", "agents"); }}>
              <IconActivity size={14} />{" "}{t("View timeline")}</button>
          </>
        )}
      </div>
    </div>
  );
}

function StepRow({ step }: { step: AgentRunStep }) {
  const isMessage = step.kind === "message";
  return (
    <div className={`step ${step.status} ${isMessage ? "msg" : ""}`}>
      <span className="step-dot" aria-hidden />
      <div className="step-body">
        <div className="step-line">
          <span className="step-name">{isMessage ? t("Corvus") : (step.label ?? prettyTool(step.kind))}</span>
          {!step.label && step.summary && <span className="step-args">{step.summary}</span>}
          {typeof step.resultChars === "number" && step.resultChars > 0 && <span className="step-size">{formatBytes(step.resultChars)}</span>}
        </div>
        {step.detail && <div className="step-detail">{step.detail}</div>}
      </div>
    </div>
  );
}

function prettyTool(tool: string): string {
  return tool.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function formatBytes(chars: number): string {
  return chars > 1000 ? `${(chars / 1000).toFixed(1)}k` : String(chars);
}
