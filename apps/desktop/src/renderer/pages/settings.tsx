import { useCallback, useEffect, useState } from "react";
import type { Profile } from "@corvus/shared";
import type { AdblockView } from "../../shared/adblock";
import type { ConnectionTestResult, EngineInfo, McpActivity, McpStatus, UpdateStatus } from "../../shared/ipc";
import type { AccessLevel, SecretKey, SettingsPatch, SettingsView, TabLayout, ThemeSource, UpdateChannel } from "../../shared/settings";
import { resolveMcpAccessLevel } from "../../shared/settings";
import { errorMessage, internalApi } from "../common/api";
import { IconCopy, IconTrash } from "../common/icons";
import { Toggle, formatTime } from "../common/ui";
import { SyncSection } from "./settings-sync";
import { DownloadsSection, SitePermissionsSection, StartupSection } from "./settings-browser";
import { SettingsSearch } from "./settings-search";
import { PageShell, Row, Section, mount } from "./shell";

const LANGUAGES = [
  ["", "Automatic (query language, then UI language)"],
  ["en", "English"],
  ["es", "Spanish"],
  ["fr", "French"],
  ["de", "German"],
  ["it", "Italian"],
  ["pt", "Portuguese"],
  ["nl", "Dutch"],
  ["ca", "Catalan"],
  ["pl", "Polish"],
  ["sv", "Swedish"],
  ["ru", "Russian"],
  ["uk", "Ukrainian"],
  ["tr", "Turkish"],
  ["ar", "Arabic"],
  ["hi", "Hindi"],
  ["ja", "Japanese"],
  ["ko", "Korean"],
  ["zh", "Chinese"],
] as const;

function useAsync<T>(load: () => Promise<T>): [T | null, () => void, (v: T) => void] {
  const [value, setValue] = useState<T | null>(null);
  const reload = useCallback(() => {
    void load().then(setValue);
  }, [load]);
  useEffect(reload, [reload]);
  return [value, reload, setValue];
}

function Feedback({ error, ok }: { error: string | null; ok?: string | null }) {
  if (error) return <div className="notice error">{error}</div>;
  if (ok) return <div className="notice">{ok}</div>;
  return null;
}

function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="btn small"
      onClick={() => {
        void internalApi()
          .call("clipboard.write", text)
          .then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          });
      }}
    >
      <IconCopy size={13} />
      {copied ? "Copied" : label}
    </button>
  );
}

/** Text input that saves on blur or Enter. */
function LazyInput({ value, onSave, placeholder, type = "text", width }: { value: string; onSave: (v: string) => void; placeholder?: string; type?: string; width?: number }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = (): void => {
    if (draft !== value) onSave(draft);
  };
  return (
    <input
      className="input"
      type={type}
      value={draft}
      placeholder={placeholder}
      spellCheck={false}
      style={width ? { width } : undefined}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === "Enter" && commit()}
    />
  );
}

function SecretField({ name, isSet, onSaved, placeholder }: { name: SecretKey; isSet: boolean; onSaved: (v: SettingsView) => void; placeholder: string }) {
  const [draft, setDraft] = useState("");
  const api = internalApi();
  return (
    <>
      <input
        className="input"
        type="password"
        value={draft}
        placeholder={isSet ? "•••••••••••• (saved)" : placeholder}
        autoComplete="off"
        onChange={(e) => setDraft(e.target.value)}
      />
      <button
        className="btn small primary"
        disabled={!draft.trim()}
        onClick={() => {
          void api.call("settings.setSecret", name, draft).then((v) => {
            setDraft("");
            onSaved(v);
          });
        }}
      >
        Save
      </button>
      {isSet && (
        <button className="btn small ghost danger" onClick={() => void api.call("settings.setSecret", name, "").then(onSaved)}>
          Clear
        </button>
      )}
    </>
  );
}

function Segmented<T extends string>({ value, options, onChange }: { value: T; options: Array<[T, string]>; onChange: (v: T) => void }) {
  return (
    <div className="segmented">
      {options.map(([v, label]) => (
        <button key={v} className={v === value ? "on" : ""} onClick={() => onChange(v)}>
          {label}
        </button>
      ))}
    </div>
  );
}

const ACCESS_LEVELS: Array<{ level: AccessLevel; label: string; blurb: string }> = [
  { level: "read", label: "Read-only", blurb: "Agents can look: read page text, list tabs and take screenshots. They cannot act on anything." },
  { level: "standard", label: "Standard", blurb: "Agents can navigate, click, type and fill in forms — enough to use most sites. The recommended default." },
  { level: "full", label: "Full", blurb: "Everything in Standard, plus running JavaScript in pages, uploading files, reading downloads and saving PDFs." },
];

function AccessLevelControl({ value, onChange }: { value: AccessLevel; onChange: (v: AccessLevel) => void }) {
  const active = ACCESS_LEVELS.find((o) => o.level === value) ?? ACCESS_LEVELS[1]!;
  return (
    <div className="access-level">
      <div className="access-head">
        <div>What agents can do</div>
        <div className="muted small">Applies to every approved MCP client. Tools above the level are not offered at all.</div>
      </div>
      <div className="access-seg" role="radiogroup" aria-label="Agent access level">
        {ACCESS_LEVELS.map((o) => (
          <button
            key={o.level}
            role="radio"
            aria-checked={o.level === value}
            className={`${o.level === value ? "on" : ""} ${o.level === "full" ? "full" : ""}`}
            onClick={() => onChange(o.level)}
          >
            {o.label}
          </button>
        ))}
      </div>
      <p className={`access-desc ${value === "full" ? "full" : ""}`}>{active.blurb}</p>
      {value === "full" && (
        <div className="notice warn access-caution">
          Full access lets agents run arbitrary scripts and reach files on this machine. Only choose it for agents you fully trust.
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------------- sections

function AppearanceSection({ view, update }: { view: SettingsView; update: (p: SettingsPatch) => void }) {
  const a = view.settings.appearance;
  return (
    <Section id="appearance" title="Appearance">
      <Row label="Theme">
        <Segmented<ThemeSource>
          value={a.theme}
          options={[
            ["system", "System"],
            ["light", "Light"],
            ["dark", "Dark"],
          ]}
          onChange={(theme) => update({ appearance: { theme } })}
        />
      </Row>
      <Row label="Show bookmarks bar" hint="Ctrl+Shift+B">
        <Toggle label="Show bookmarks bar" checked={a.showBookmarksBar} onChange={(v) => update({ appearance: { showBookmarksBar: v } })} />
      </Row>
      <Row label="Tabs" hint="Classic top strip, or a resizable, collapsible sidebar on the left.">
        <Segmented<TabLayout>
          value={a.tabLayout}
          options={[
            ["horizontal", "Top"],
            ["vertical", "Sidebar"],
          ]}
          onChange={(tabLayout) => update({ appearance: { tabLayout } })}
        />
      </Row>
      {a.tabLayout === "vertical" && (
        <Row label="Sidebar width" hint="Pixels (180–480). Drag the sidebar edge to resize too.">
          <LazyInput value={String(a.sidebarWidth)} type="number" width={120} onSave={(v) => update({ appearance: { sidebarWidth: Number(v) || 240 } })} />
        </Row>
      )}
    </Section>
  );
}

const WATCH_INTERVALS: Array<[number, string]> = [
  [5, "Every 5 minutes"],
  [15, "Every 15 minutes"],
  [30, "Every 30 minutes"],
  [60, "Hourly"],
  [180, "Every 3 hours"],
  [360, "Every 6 hours"],
  [720, "Every 12 hours"],
  [1440, "Daily"],
];

function MonitoringSection({ view, update }: { view: SettingsView; update: (p: SettingsPatch) => void }) {
  const m = view.settings.monitor;
  return (
    <Section
      id="monitoring"
      title="Page-change monitoring"
      description="“Watch this page” re-fetches pages you choose in the background, detects meaningful changes to their main text and writes a short AI summary of what changed. Read-only, public http(s) pages only. Watches are per profile and stay on this device."
    >
      <Row label="Enable monitoring" hint="Turning this off stops all background checks.">
        <Toggle label="Enable monitoring" checked={m.enabled} onChange={(v) => update({ monitor: { enabled: v } })} />
      </Row>
      <Row label="Default check interval" hint="Used for newly watched pages; each page can be changed individually.">
        <select
          className="input"
          value={m.defaultIntervalMinutes}
          onChange={(e) => update({ monitor: { defaultIntervalMinutes: Number(e.target.value) } })}
        >
          {WATCH_INTERVALS.map(([mins, label]) => (
            <option key={mins} value={mins}>
              {label}
            </option>
          ))}
        </select>
      </Row>
      <Row label="Maximum watched pages" hint="Per profile (1–200).">
        <LazyInput value={String(m.maxWatches)} type="number" width={120} onSave={(v) => update({ monitor: { maxWatches: Number(v) || 50 } })} />
      </Row>
      <Row label="Open" hint="See everything you are watching and the latest changes.">
        <a className="btn small" href="corvus://watches/">
          Open watched pages
        </a>
      </Row>
    </Section>
  );
}

function ScheduledAgentsSection({ view, update }: { view: SettingsView; update: (p: SettingsPatch) => void }) {
  const sa = view.settings.scheduledAgents;
  return (
    <Section
      id="scheduled-agents"
      title="Scheduled agents"
      description="Run AI agent tasks on a schedule (cron or interval) in a background tab, with a notification summary. Risky actions (sign-in, payments, submitting forms) always pause for your approval and are never performed unattended. Schedules are per profile and stay on this device."
    >
      <Row label="Enable scheduled agents" hint="Turning this off stops all scheduled runs.">
        <Toggle label="Enable scheduled agents" checked={sa.enabled} onChange={(v) => update({ scheduledAgents: { enabled: v } })} />
      </Row>
      <Row label="Max steps per run" hint="Hard cap on tool actions any scheduled run may take (1–50).">
        <LazyInput value={String(sa.maxSteps)} type="number" width={120} onSave={(v) => update({ scheduledAgents: { maxSteps: Math.max(1, Math.min(50, Number(v) || 12)) } })} />
      </Row>
      <Row label="Token budget per run" hint="Total input + output tokens before a run stops.">
        <LazyInput value={String(sa.maxTokens)} type="number" width={120} onSave={(v) => update({ scheduledAgents: { maxTokens: Math.max(2000, Math.min(500000, Number(v) || 60000)) } })} />
      </Row>
      <Row label="Open" hint="Add, edit, pause and watch your scheduled tasks.">
        <a className="btn small" href="corvus://schedules/">
          Open scheduled agents
        </a>
      </Row>
    </Section>
  );
}

function ReaderSection({ view, update }: { view: SettingsView; update: (p: SettingsPatch) => void }) {
  const r = view.settings.reader;
  return (
    <Section id="reader" title="Reader mode" description="Defaults for the clean reading view (open it with the book icon in the address bar).">
      <Row label="Font size" hint="15–28 px">
        <LazyInput value={String(r.fontSize)} type="number" width={100} onSave={(v) => update({ reader: { fontSize: Number(v) || 19 } })} />
      </Row>
      <Row label="Line width" hint="Characters per line (36–90).">
        <LazyInput value={String(r.lineWidth)} type="number" width={100} onSave={(v) => update({ reader: { lineWidth: Number(v) || 64 } })} />
      </Row>
      <Row label="Theme">
        <Segmented<"light" | "sepia" | "dark">
          value={r.theme}
          options={[
            ["light", "Light"],
            ["sepia", "Sepia"],
            ["dark", "Dark"],
          ]}
          onChange={(theme) => update({ reader: { theme } })}
        />
      </Row>
      <Row label="Typeface">
        <Segmented<"serif" | "sans">
          value={r.font}
          options={[
            ["serif", "Serif"],
            ["sans", "Sans"],
          ]}
          onChange={(font) => update({ reader: { font } })}
        />
      </Row>
      <Row label="Translate articles to" hint="Default target for the reader's Translate tool; blank uses your answer language.">
        <LazyInput value={r.translateLanguage} placeholder="e.g. Spanish" onSave={(v) => update({ reader: { translateLanguage: v.trim() } })} />
      </Row>
    </Section>
  );
}

function PdfSection({ view, update }: { view: SettingsView; update: (p: SettingsPatch) => void }) {
  const pdf = view.settings.pdf;
  return (
    <Section id="pdf" title="PDF viewer" description="Read PDFs inside Corvus with the reading AI tools (Key points, TL;DR, Simplify, Translate, read-aloud) and page citations.">
      <Row label="Open PDFs in Corvus" hint="When off, PDFs download instead of opening in the in-app viewer.">
        <Toggle label="Use the in-app PDF viewer" checked={pdf.openInViewer} onChange={(v) => update({ pdf: { openInViewer: v } })} />
      </Row>
    </Section>
  );
}

function SemanticSearchSection({ view, update }: { view: SettingsView; update: (p: SettingsPatch) => void }) {
  const s = view.settings.semanticSearch;
  return (
    <Section
      id="semantic-search"
      title="Find in my pages"
      description="Search your own history, bookmarks and saved articles by meaning — from the Command Bar or corvus://find. Keyword search always works offline; embeddings are optional and never required."
    >
      <Row label="Index my pages" hint="Keep a local, per-device text index of pages you visit, bookmark and save. Nothing leaves your machine.">
        <Toggle label="Keep a local search index" checked={s.indexPages} onChange={(v) => update({ semanticSearch: { indexPages: v } })} />
      </Row>
      <Row label="Semantic ranking" hint="Re-rank results with embeddings from your local model endpoint (configured under AI search). Falls back to keyword ranking when offline or unset.">
        <Toggle label="Use embeddings to improve ranking" checked={s.useEmbeddings} onChange={(v) => update({ semanticSearch: { useEmbeddings: v } })} />
      </Row>
      <Row label="Embedding model" hint="Model on your local endpoint, e.g. nomic-embed-text (Ollama) or an embeddings model served by LM Studio.">
        <LazyInput value={s.embeddingModel} placeholder="nomic-embed-text" onSave={(v) => update({ semanticSearch: { embeddingModel: v.trim() } })} />
      </Row>
    </Section>
  );
}

const PROVIDER_HINT: Record<string, string> = {
  "anthropic-api": "Anthropic API with your own key.",
  "claude-code-cli": "Uses your local Claude Code login. Personal use only — distributed builds must use an API key.",
  local: "A model running on this machine (Ollama or an OpenAI-compatible server). Offline, no API key, nothing leaves the device.",
};

/** Probes the configured local server and reports reachability, model presence and tool support. */
function TestConnectionButton({ deps }: { deps: unknown[] }) {
  const [state, setState] = useState<{ busy: boolean; result: ConnectionTestResult | null }>({ busy: false, result: null });
  useEffect(() => setState({ busy: false, result: null }), deps);
  const run = (): void => {
    setState({ busy: true, result: null });
    void internalApi()
      .call("settings.testConnection")
      .then((result) => setState({ busy: false, result }))
      .catch((err: unknown) => setState({ busy: false, result: { ok: false, detail: errorMessage(err) } }));
  };
  return (
    <div className="stack">
      <button className="btn small" disabled={state.busy} onClick={run}>
        {state.busy ? "Testing…" : "Test connection"}
      </button>
      {state.result && <span className={`pill ${state.result.ok ? "ok" : "bad"}`}>{state.result.detail}</span>}
    </div>
  );
}

function AiSection({ view, update, setView }: { view: SettingsView; update: (p: SettingsPatch) => void; setView: (v: SettingsView) => void }) {
  const ai = view.settings.ai;
  const loadEngine = useCallback(() => internalApi().call("search.engineInfo"), []);
  const [engine, reloadEngine] = useAsync<EngineInfo>(loadEngine);
  useEffect(reloadEngine, [view, reloadEngine]);

  return (
    <Section
      id="ai"
      title="AI search"
      description="Searches run against a retriever first (no AI, zero tokens). One small-model call then writes a cited answer."
    >
      <Row label="Engine status">
        {engine ? (
          engine.available ? (
            <span className="pill ok">Ready · {engine.model}</span>
          ) : (
            <span className="pill bad" title={engine.reason ?? ""}>
              Unavailable
            </span>
          )
        ) : (
          <span className="spinner" />
        )}
      </Row>
      {engine && !engine.available && engine.reason && <div className="notice warn">{engine.reason}</div>}
      <Row label="AI provider" hint={PROVIDER_HINT[ai.provider] ?? ""}>
        <select className="input" value={ai.provider} onChange={(e) => update({ ai: { provider: e.target.value as typeof ai.provider } })}>
          <option value="anthropic-api">Anthropic API</option>
          <option value="claude-code-cli">Claude Code CLI (local)</option>
          <option value="local">Local model (offline)</option>
        </select>
      </Row>
      {ai.provider === "anthropic-api" && (
        <Row
          label="Anthropic API key"
          hint={view.secretsPersisted ? "Encrypted with your operating system keychain." : "No OS keychain available: the key is kept in memory until Corvus quits."}
        >
          <SecretField name="anthropicApiKey" isSet={view.secrets.anthropicApiKey} onSaved={setView} placeholder="sk-ant-…" />
        </Row>
      )}
      {ai.provider === "claude-code-cli" && (
        <Row label="Claude CLI path" hint="Executable used for `claude -p`.">
          <LazyInput value={ai.claudeCliPath} placeholder="claude" onSave={(v) => update({ ai: { claudeCliPath: v } })} />
        </Row>
      )}
      {ai.provider === "local" && (
        <>
          <Row label="Local API" hint="Ollama speaks its own API; llama.cpp, LM Studio and vLLM speak the OpenAI-compatible one.">
            <select className="input" value={ai.localApi} onChange={(e) => update({ ai: { localApi: e.target.value === "openai" ? "openai" : "ollama" } })}>
              <option value="ollama">Ollama</option>
              <option value="openai">OpenAI-compatible</option>
            </select>
          </Row>
          <Row label="Base URL" hint={ai.localApi === "ollama" ? "Ollama server, e.g. http://localhost:11434." : "Server root, e.g. http://localhost:1234/v1 (LM Studio)."}>
            <LazyInput value={ai.localBaseUrl} placeholder="http://localhost:11434" onSave={(v) => update({ ai: { localBaseUrl: v.trim() } })} />
          </Row>
        </>
      )}
      <Row label="Model" hint={ai.provider === "local" ? "The model name the server exposes, e.g. llama3.1 or qwen2.5." : "A small, fast model keeps answers cheap."}>
        <LazyInput
          value={ai.model}
          placeholder={ai.provider === "local" ? "llama3.1" : "claude-haiku-5-5"}
          onSave={(v) => update({ ai: { model: v.trim() || (ai.provider === "local" ? "llama3.1" : "claude-haiku-5-5") } })}
        />
      </Row>
      {ai.provider === "local" && (
        <Row label="Connection" hint="No API key is needed — everything stays on this device.">
          <TestConnectionButton deps={[ai.provider, ai.localApi, ai.localBaseUrl, ai.model]} />
        </Row>
      )}
      <Row label="Answer length" hint="Maximum output tokens per answer.">
        <LazyInput value={String(ai.maxOutputTokens)} type="number" width={120} onSave={(v) => update({ ai: { maxOutputTokens: Number(v) || 400 } })} />
      </Row>
      <Row label="Answer language">
        <select className="input" value={ai.answerLanguage} onChange={(e) => update({ ai: { answerLanguage: e.target.value } })}>
          {LANGUAGES.map(([code, name]) => (
            <option key={code} value={code}>
              {name}
            </option>
          ))}
        </select>
      </Row>
      <Row label="Search backend">
        <select className="input" value={ai.retriever} onChange={(e) => update({ ai: { retriever: e.target.value as typeof ai.retriever } })}>
          <option value="searxng">SearXNG (self-hosted)</option>
          <option value="brave">Brave Search API</option>
          <option value="duckduckgo">DuckDuckGo</option>
        </select>
      </Row>
      {ai.retriever === "searxng" && (
        <Row label="SearXNG URL" hint="Run it with `docker compose up -d searxng`.">
          <LazyInput value={ai.searxngUrl} placeholder="http://localhost:8898" onSave={(v) => update({ ai: { searxngUrl: v.trim() } })} />
        </Row>
      )}
      {ai.retriever === "brave" && (
        <Row label="Brave Search API key">
          <SecretField name="braveApiKey" isSet={view.secrets.braveApiKey} onSaved={setView} placeholder="BSA…" />
        </Row>
      )}
    </Section>
  );
}

function PasswordsSection({ view, update }: { view: SettingsView; update: (p: SettingsPatch) => void }) {
  const pw = view.settings.passwords;
  return (
    <Section
      id="passwords"
      title="Passwords"
      description={
        <>
          Saved logins, 2FA codes and KeePass databases are managed on the <a href="corvus://passwords/">Passwords</a> page.
        </>
      }
    >
      <Row
        label="Let AI agents use logins you opt in"
        hint="The Command Bar agent and Full-access MCP clients may sign in and fill 2FA codes, but only for logins you opt in one by one, and only after you approve each use. They never see the password or the code. Off by default; CAPTCHAs are always handed back to you."
      >
        <Toggle label="Let AI agents use logins you opt in" checked={pw.agentAccess} onChange={(v) => update({ passwords: { agentAccess: v } })} />
      </Row>
      <Row label="Lock KeePass databases after" hint="Minutes without keyboard or mouse activity. 0 keeps them unlocked until you lock them or quit.">
        <LazyInput
          value={String(pw.keepassAutoLockMinutes)}
          type="number"
          width={120}
          onSave={(v) => update({ passwords: { keepassAutoLockMinutes: Math.max(0, Math.min(1440, Math.round(Number(v)) || 0)) } })}
        />
      </Row>
    </Section>
  );
}

function CommandAgentSection({ view, update }: { view: SettingsView; update: (p: SettingsPatch) => void }) {
  const agent = view.settings.agent;
  const ai = view.settings.ai;
  return (
    <Section
      id="command-agent"
      title="Command Bar agent"
      description="Press Ctrl+K (⌘K on macOS) to open the Command Bar. Start the line with “> ” to ask Corvus to run a task — it drives a dedicated tab with the same tools AI agents use, and you watch each step."
    >
      <Row label="Provider" hint="Agent runs use your AI search provider and model.">
        <span className="pill off">
          {ai.provider === "claude-code-cli" ? "Claude Code CLI" : ai.provider === "local" ? "Local model" : "Anthropic API"} · {ai.model}
        </span>
      </Row>
      <Row label="Max steps" hint="Most tool actions one task may take before it stops.">
        <LazyInput value={String(agent.maxSteps)} type="number" width={120} onSave={(v) => update({ agent: { maxSteps: Math.max(1, Math.min(50, Number(v) || 15)) } })} />
      </Row>
      <Row label="Ask before risky actions" hint="Confirm before submitting forms, spending money or signing in. Payments and CAPTCHAs are always handed back to you, and so are passwords and 2FA codes unless you let agents use a login (Settings, Passwords). Using a saved login always asks first.">

        <Toggle label="Ask before risky actions" checked={agent.askBeforeRisky} onChange={(v) => update({ agent: { askBeforeRisky: v } })} />
      </Row>
      <Row
        label="Learn from runs (site memory)"
        hint="After a successful run, Corvus keeps a few small hints per site (which buttons and fields worked, URL shapes, cookie banners) so later tasks there take fewer steps. Never typed values or passwords. Learning is per device; what is learned syncs end to end when Site memory sync is on. See and forget them on the Workflows page."
      >
        <Toggle label="Learn from runs (site memory)" checked={agent.siteMemory} onChange={(v) => update({ agent: { siteMemory: v } })} />
      </Row>
    </Section>
  );
}

function AgentsSection({ view, update }: { view: SettingsView; update: (p: SettingsPatch) => void }) {
  const api = internalApi();
  const [status, setStatus] = useState<McpStatus | null>(null);
  const [activity, setActivity] = useState<McpActivity[]>([]);
  const [showToken, setShowToken] = useState(false);
  const mcp = view.settings.mcp;

  useEffect(() => {
    let alive = true;
    const refresh = (): void => {
      void api.call("mcp.status").then((s) => alive && setStatus(s));
      void api.call("mcp.activity").then((a) => alive && setActivity(a));
    };
    refresh();
    const timer = setInterval(refresh, 3000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [api, view]);

  return (
    <Section
      id="agents"
      title="AI agents (MCP)"
      description="Let Claude Code, Claude Desktop or any MCP client drive this browser over a local-only server (127.0.0.1) protected by a bearer token."
    >
      <Row label="Enable MCP server" hint="New clients must be approved the first time they connect.">
        {status && (
          <span className={`pill ${status.running ? "ok" : status.enabled && !status.available ? "bad" : "off"}`}>
            {status.running ? `Running on port ${status.port}` : status.enabled ? (status.available ? "Starting…" : "Unavailable") : "Off"}
          </span>
        )}
        {status && (
          <span className={`pill ${status.accessLevel === "full" ? "bad" : "off"}`} title="Access level approved agents run at">
            {ACCESS_LEVELS.find((o) => o.level === status.accessLevel)?.label ?? status.accessLevel} access
          </span>
        )}
        <Toggle label="Enable MCP server" checked={mcp.enabled} onChange={(v) => update({ mcp: { enabled: v } })} />
      </Row>
      {status?.error && <div className="notice warn">{status.error}</div>}
      <Row label="Port" hint="0 picks a random free port once and keeps it.">
        <LazyInput value={String(mcp.port)} type="number" width={120} onSave={(v) => update({ mcp: { port: Math.max(0, Math.min(65535, Number(v) || 0)) } })} />
      </Row>
      <Row label="Access token">
        <code className="mono">{status ? (showToken ? status.token : `${status.token.slice(0, 4)}…${status.token.slice(-4)}`) : "…"}</code>
        <button className="btn small ghost" onClick={() => setShowToken((s) => !s)}>
          {showToken ? "Hide" : "Show"}
        </button>
        {status && <CopyButton text={status.token} />}
        <button
          className="btn small"
          onClick={() => {
            if (confirm("Regenerate the token? Connected agents will need the new command.")) void api.call("mcp.regenerateToken").then(setStatus);
          }}
        >
          Regenerate
        </button>
      </Row>
      {status?.command ? (
        <>
          <div className="row" style={{ borderBottom: "none" }}>
            <div className="row-label">
              <div>Connect Claude Code</div>
              <div className="muted small">Run this once in a terminal.</div>
            </div>
          </div>
          <div className="code-box">
            <code>{status.command}</code>
            <CopyButton text={status.command} />
          </div>
        </>
      ) : (
        <div className="notice">Enable the server once to get a port and the `claude mcp add` command.</div>
      )}
      <AccessLevelControl value={resolveMcpAccessLevel(mcp)} onChange={(level) => update({ mcp: { accessLevel: level, allowEvaluate: level === "full" } })} />

      <Row label="Approved clients" hint="Clients that connect without asking.">
        {mcp.approvedClients.length === 0 && <span className="muted">None yet</span>}
        {mcp.approvedClients.map((name) => (
          <span key={name} className="pill">
            {name}
            <button
              className="btn small ghost"
              style={{ height: 18, padding: "0 4px" }}
              title="Revoke"
              onClick={() => update({ mcp: { approvedClients: mcp.approvedClients.filter((n) => n !== name) } })}
            >
              ×
            </button>
          </span>
        ))}
      </Row>
      {activity.length > 0 && (
        <div className="list" style={{ borderTop: "1px solid var(--border-soft)" }}>
          {activity.slice(0, 8).map((a, i) => (
            <div key={`${a.at}-${i}`} className="list-row">
              <span className="mono muted">{formatTime(a.at)}</span>
              <span className="grow">
                <strong>{a.client}</strong> <span className="muted">{a.tool}</span>
              </span>
            </div>
          ))}
        </div>
      )}
    </Section>
  );
}

function McpRemoteSection({ view, update }: { view: SettingsView; update: (p: SettingsPatch) => void }) {
  const api = internalApi();
  const [status, setStatus] = useState<McpStatus | null>(null);
  const mcp = view.settings.mcp;
  const remote = mcp.host === "0.0.0.0";

  useEffect(() => {
    let alive = true;
    const refresh = (): void => void api.call("mcp.status").then((s) => alive && setStatus(s));
    refresh();
    const timer = setInterval(refresh, 3000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [api, view]);

  const toggleRemote = (on: boolean): void => {
    if (on && !confirm("Expose this browser to the local network?\n\nAny device that can reach this machine and has the access token will be able to drive the browser. Keep the token secret and rotate it if leaked.")) {
      return;
    }
    update({ mcp: { host: on ? "0.0.0.0" : "127.0.0.1" } });
  };

  return (
    <Section
      id="agents-remote"
      title="AI agents: remote access"
      description="By default the MCP server listens on 127.0.0.1 and only local clients can reach it. Turn this on to also accept connections from other devices on your network. The bearer token is still required."
    >
      <Row label="Allow remote clients" hint="Binds the server to 0.0.0.0 (all interfaces) instead of loopback only.">
        {status && <span className={`pill ${remote ? "bad" : "off"}`}>{remote ? "All interfaces" : "Loopback only"}</span>}
        <Toggle label="Allow remote clients" checked={remote} onChange={toggleRemote} />
      </Row>
      {remote && (
        <div className="notice warn">
          This browser is reachable from your local network. Anyone who can connect to this machine and holds the access token can
          open tabs, read pages, click and type. Only enable this on trusted networks, and rotate the token if it may have leaked.
        </div>
      )}
      {remote && !mcp.enabled && <div className="notice">The MCP server is off. Enable it under “AI agents (MCP)” for remote access to take effect.</div>}
      {remote && status?.running && (
        <Row label="Connect a remote client" hint={status.lanAddress ? "Use this machine's network address." : "No network address detected; use this machine's LAN IP."}>
          <code className="mono">{status.url}</code>
          {status.url && <CopyButton text={status.url} />}
          {status.command && <CopyButton text={status.command} />}
        </Row>
      )}
    </Section>
  );
}

function AdblockSection() {
  const api = internalApi();
  const [view, setView] = useState<AdblockView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(() => void api.call("adblock.get").then(setView), [api]);
  useEffect(() => {
    reload();
    return api.onEvent((e) => {
      if (e.type === "settings-changed") reload();
    });
  }, [api, reload]);

  const run = (p: Promise<AdblockView>): void => {
    setError(null);
    p.then(setView).catch((e: unknown) => setError(errorMessage(e)));
  };

  const lists = view?.lists;
  const sourceLabel =
    lists?.source === "network" ? "EasyList + EasyPrivacy" : lists?.source === "cache" ? "EasyList + EasyPrivacy (cached)" : "Built-in list (offline)";

  return (
    <Section
      id="adblock"
      title="Ad &amp; tracker blocker"
      description="Blocks ads and trackers with EasyList and EasyPrivacy, including cosmetic (page element) filters. Blocking never applies to corvus:// pages or local addresses, and settings are per profile and never synced."
    >
      <Row label="Block ads and trackers" hint="Applies to every site except those you allow below.">
        <Toggle label="Block ads and trackers" checked={view?.enabled ?? true} onChange={(v) => run(api.call("adblock.setEnabled", v))} />
      </Row>
      <Row label="Filter lists" hint={lists?.updatedAt ? `${lists.filterCount.toLocaleString()} rules` : "Using the bundled list until the first update succeeds."}>
        <span className="muted small">
          {sourceLabel}
          {lists?.updatedAt ? ` · updated ${formatTime(lists.updatedAt)}` : " · never updated"}
        </span>
        <button className="btn small" disabled={lists?.updating} onClick={() => run(api.call("adblock.update"))}>
          {lists?.updating ? "Updating…" : "Update now"}
        </button>
      </Row>
      <Row label="Allowed sites" hint="Sites where blocking is paused (chosen from the shield in the address bar).">
        {view && view.allowedSites.length === 0 && <span className="muted">None</span>}
      </Row>
      {view && view.allowedSites.length > 0 && (
        <div className="list" style={{ borderTop: "1px solid var(--border-soft)" }}>
          {view.allowedSites.map((host) => (
            <div key={host} className="list-row">
              <span className="grow">{host}</span>
              <button className="btn small ghost danger" title="Remove" onClick={() => run(api.call("adblock.removeAllowed", host))}>
                <IconTrash size={13} />
                Remove
              </button>
            </div>
          ))}
        </div>
      )}
      <Feedback error={error} />
    </Section>
  );
}

function ProfilesSection() {
  const api = internalApi();
  const [data, setData] = useState<{ profiles: Profile[]; current: string } | null>(null);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(() => void api.call("profiles.list").then(setData), [api]);
  useEffect(reload, [reload]);

  const run = (p: Promise<unknown>): void => {
    setError(null);
    p.then(reload).catch((e: unknown) => setError(errorMessage(e)));
  };

  return (
    <Section id="profiles" title="Profiles" description="Each profile has its own cookies, history, bookmarks, extensions and sync.">
      {data?.profiles.map((p) => (
        <Row
          key={p.id}
          label={
            <span className="inline">
              <span className="avatar-dot" style={{ background: p.avatar ?? "var(--accent)" }}>
                {p.name.charAt(0).toUpperCase()}
              </span>
              <LazyInput value={p.name} width={220} onSave={(v) => run(api.call("profiles.rename", p.id, v))} />
              {p.id === data.current && <span className="pill">This window</span>}
              {p.syncChainId && <span className="pill ok">Synced</span>}
            </span>
          }
        >
          <button className="btn small" onClick={() => run(api.call("profiles.openWindow", p.id))}>
            Open window
          </button>
          <button className="btn small ghost danger" disabled={data.profiles.length <= 1} onClick={() => run(api.call("profiles.remove", p.id))}>
            Delete
          </button>
        </Row>
      ))}
      <Row label="Add profile">
        <input className="input" placeholder="Profile name" value={name} onChange={(e) => setName(e.target.value)} />
        <button
          className="btn small primary"
          disabled={!name.trim()}
          onClick={() => {
            run(api.call("profiles.create", name).then(() => setName("")));
          }}
        >
          Create
        </button>
      </Row>
      <Feedback error={error} />
    </Section>
  );
}

function UpdatesSection({ view, update }: { view: SettingsView; update: (p: SettingsPatch) => void }) {
  const api = internalApi();
  const u = view.settings.update;
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [noticesError, setNoticesError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void api.call("update.status").then((s) => alive && setStatus(s));
    const off = api.onEvent((e) => {
      if (e.type === "update-changed") setStatus(e.status);
    });
    return () => {
      alive = false;
      off();
    };
  }, [api]);

  const check = (): void => {
    setBusy(true);
    void api
      .call("update.check")
      .then(setStatus)
      .finally(() => setBusy(false));
  };
  const download = (): void => void api.call("update.download").then(setStatus);
  const install = (): void => void api.call("update.install");

  const phase = status?.phase ?? "idle";
  const checking = busy || phase === "checking";
  return (
    <Section
      id="updates"
      title="Updates"
      description="Corvus updates itself from its GitHub Releases, or from a self-hosted feed you set below. Updates apply to this install and are never synced."
    >
      <Row label="Current version">
        <span className="pill off">Corvus {status?.currentVersion ?? "…"}</span>
        {status && !status.supported && <span className="muted small">{status.reason}</span>}
      </Row>
      <Row
        label="Third-party software"
        hint="Corvus includes open-source packages under their own licences. The source is MPL-2.0; this app is distributed under GPL-3.0 because it includes electron-chrome-extensions. Source: github.com/ParendumOU/Corvus."
      >
        <button className="btn small" onClick={() => void api.call("app.openThirdPartyNotices").then(setNoticesError)}>
          View licences
        </button>
        {noticesError && <span className="muted small">{noticesError}</span>}
      </Row>
      <Row label="Release channel" hint="Beta receives pre-releases from the same feed.">
        <Segmented<UpdateChannel>
          value={u.channel}
          options={[
            ["stable", "Stable"],
            ["beta", "Beta"],
          ]}
          onChange={(channel) => update({ update: { channel } })}
        />
      </Row>
      <Row label="Check on startup" hint="Look for updates each time Corvus starts.">
        <Toggle label="Check on startup" checked={u.autoCheck} onChange={(v) => update({ update: { autoCheck: v } })} />
      </Row>
      <Row label="Update feed URL" hint="Base URL of a self-hosted “generic” feed. Blank uses GitHub Releases.">
        <LazyInput
          value={u.feedUrl}
          width={320}
          placeholder={status?.feedUrl ?? "https://updates.example.com/corvus"}
          onSave={(v) => update({ update: { feedUrl: v.trim() } })}
        />
      </Row>
      <Row label="Updates" hint="Check now, then download and restart to install.">
        <button className="btn small" disabled={checking || !status?.supported} onClick={check}>
          {checking ? "Checking…" : "Check for updates"}
        </button>
        {phase === "available" && (
          <button className="btn small primary" onClick={download}>
            Download{status?.newVersion ? ` ${status.newVersion}` : ""}
          </button>
        )}
        {phase === "downloaded" && (
          <button className="btn small primary" onClick={install}>
            Restart to update
          </button>
        )}
      </Row>
      {phase === "downloading" && (
        <Row label="Downloading" hint={status?.newVersion ? `Version ${status.newVersion}` : undefined}>
          <progress max={100} value={status?.percent ?? 0} style={{ width: 200 }} />
          <span className="muted small">{status?.percent ?? 0}%</span>
        </Row>
      )}
      {phase === "not-available" && <div className="notice">You’re on the latest version.</div>}
      {phase === "downloaded" && (
        <div className="notice">Version {status?.newVersion} is ready. Restart Corvus to finish updating.</div>
      )}
      {status?.error && <div className="notice warn">{status.error}</div>}
      {status?.releaseNotes && (phase === "available" || phase === "downloaded") && (
        <div className="notice" style={{ whiteSpace: "pre-wrap", maxHeight: 160, overflow: "auto" }}>
          {status.releaseNotes}
        </div>
      )}
    </Section>
  );
}

function SettingsPage() {
  const loadView = useCallback(() => internalApi().call("settings.get"), []);
  const [view, , setView] = useAsync<SettingsView>(loadView);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const hash = location.hash.slice(1);
    if (view && hash) document.getElementById(hash)?.scrollIntoView({ block: "start" });
  }, [view !== null]);

  const update = useCallback(
    (patch: SettingsPatch) => {
      setError(null);
      internalApi()
        .call("settings.update", patch)
        .then(setView)
        .catch((e: unknown) => setError(errorMessage(e)));
    },
    [setView],
  );

  const navGroups: Array<[string, Array<[string, string]>]> = [
    [
      "Appearance & reading",
      [
        ["appearance", "Appearance"],
        ["reader", "Reader mode"],
        ["pdf", "PDF viewer"],
      ],
    ],
    [
      "Browsing",
      [
        ["semantic-search", "Find in my pages"],
        ["startup", "On startup"],
        ["downloads", "Downloads"],
        ["passwords", "Passwords"],
        ["site-permissions", "Site permissions"],
        ["adblock", "Ad blocker"],
        ["monitoring", "Page monitoring"],
      ],
    ],
    [
      "AI & agents",
      [
        ["ai", "AI search"],
        ["command-agent", "Command Bar"],
        ["scheduled-agents", "Scheduled agents"],
        ["agents", "AI agents"],
        ["agents-remote", "Remote access"],
        ["webscope", "Security workbench"],
      ],
    ],
    [
      "System",
      [
        ["profiles", "Profiles"],
        ["sync", "Sync"],
        ["updates", "Updates"],
        ["crash-logs", "Crash logs"],
        ["onboarding", "First-run setup"],
      ],
    ],
  ];

  return (
    <PageShell
      title="Settings"
      active="settings"
      sidebar={navGroups.map(([group, items]) => (
        <div key={group} className="nav-group">
          <div className="nav-group-head">{group}</div>
          {items.map(([id, label]) => (
            <a key={id} href={`#${id}`} data-nav-id={id} className="small">
              {label}
            </a>
          ))}
        </div>
      ))}
    >
      {error && <div className="notice error">{error}</div>}
      {view && (
        <>
          <SettingsSearch />
          <AppearanceSection view={view} update={update} />
          <ReaderSection view={view} update={update} />
          <PdfSection view={view} update={update} />
          <SemanticSearchSection view={view} update={update} />
          <StartupSection view={view} update={update} />
          <DownloadsSection view={view} update={update} setView={setView} />
          <PasswordsSection view={view} update={update} />
          <SitePermissionsSection />
          <AdblockSection />
          <MonitoringSection view={view} update={update} />
          <AiSection view={view} update={update} setView={setView} />
          <CommandAgentSection view={view} update={update} />
          <ScheduledAgentsSection view={view} update={update} />
          <AgentsSection view={view} update={update} />
          <McpRemoteSection view={view} update={update} />
          <WebScopeSection view={view} update={update} />
          <ProfilesSection />
          <SyncSection />
          <UpdatesSection view={view} update={update} />
          <CrashLogsSection view={view} update={update} />
          <OnboardingSection />
          <p className="muted small" style={{ textAlign: "center" }}>
            Corvus 0.1.0 · An AI-native browser that is also an MCP server.
          </p>
        </>
      )}
    </PageShell>
  );
}

function WebScopeSection({ view, update }: { view: SettingsView; update: (p: SettingsPatch) => void }) {
  const ws = view.settings.webscope;
  return (
    <Section
      id="webscope"
      title="Security workbench (WebScope)"
      description="A Burp-style workbench over your own browser traffic: capture, replay, fuzz and transform in-scope requests. For authorized testing only. Off by default."
    >
      <Row label="Enable WebScope" hint="Captures this profile's HTTP traffic for inspection. Everything stays scoped to the allowlist.">
        <Toggle label="Enable WebScope" checked={ws.enabled} onChange={(v) => update({ webscope: { enabled: v } })} />
      </Row>
      <Row label="Open" hint="Capture, Repeater, Fuzzer, Rules, Scope, Decoder and Comparer.">
        <a className="btn small" href="corvus://webscope/">Open WebScope</a>
      </Row>
    </Section>
  );
}

function CrashLogsSection({ view, update }: { view: SettingsView; update: (p: SettingsPatch) => void }) {
  const api = internalApi();
  const [logPath, setLogPath] = useState("");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void api.call("crashReports.logPath").then(setLogPath);
  }, [api]);
  const openFolder = (): void => {
    setError(null);
    void api.call("crashReports.openFolder").then((err) => {
      if (err) setError(err);
    });
  };
  return (
    <Section
      id="crash-logs"
      title="Crash &amp; error logs"
      description="If Corvus or a page crashes, save a local diagnostic log you can use to report the problem. Logs stay on this device in a rotating file under your user data folder and are never uploaded. Off by default."
    >
      <Row label="Save crash logs locally" hint="Records main-process errors and tab crashes to a local file. Nothing is sent anywhere.">
        <Toggle
          label="Save crash logs locally"
          checked={view.settings.crashReports.saveLogs}
          onChange={(v) => update({ crashReports: { saveLogs: v } })}
        />
      </Row>
      <Row label="Log folder" hint={logPath || undefined}>
        <button className="btn small" onClick={openFolder}>
          Open log folder
        </button>
      </Row>
      {error && <div className="notice error">{error}</div>}
    </Section>
  );
}

function OnboardingSection() {
  return (
    <Section
      id="onboarding"
      title="First-run setup"
      description="Re-run the welcome wizard to reconfigure your AI provider, sync, imports and preferences. It normally appears only once, on first launch."
    >
      <Row label="Welcome wizard" hint="Opens the step-by-step setup in a new page. Nothing changes until you pick it there.">
        <a className="btn small" href="corvus://welcome/">
          Run setup again
        </a>
      </Row>
    </Section>
  );
}

mount(<SettingsPage />);
