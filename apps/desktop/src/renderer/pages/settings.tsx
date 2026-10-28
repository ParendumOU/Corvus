import { useCallback, useEffect, useState } from "react";
import type { Profile } from "@corvus/shared";
import type { AdblockView } from "../../shared/adblock";
import type { UserNote } from "../../shared/user-memory";
import type { ConnectionTestResult, EngineInfo, LocalServerInfo, McpStatus, UpdateStatus } from "../../shared/ipc";
import type { AccessLevel, ClaudeAccountMode, HomePage, SecretKey, SettingsPatch, SettingsView, TabLayout, ThemeSource, UiLanguageSetting, UpdateChannel } from "../../shared/settings";
import { resolveMcpAccessLevel, resolveUiLanguage } from "../../shared/settings";
import { DICTATION_PRESETS, dictationReady, type DictationPreset } from "../../shared/dictation";
import { errorMessage, internalApi } from "../common/api";
import { setUiLanguage, t } from "../common/i18n";
import { IconClose, IconCopy, IconTrash } from "../common/icons";
import { Toggle, formatTime } from "../common/ui";
import { AgentActivityLog } from "./settings-agent-log";
import { SyncSection } from "./settings-sync";
import {
  ContainersSection,
  DefaultBrowserSection,
  DownloadsSection,
  ImportSection,
  MediaSection,
  MemorySection,
  PhoneSection,
  SitePermissionsSection,
  SiteSearchSection,
  StartupSection,
} from "./settings-browser";
import { ConnectionsSection } from "./settings-connections";
import { SettingsSearch } from "./settings-search";
import { PageShell, Row, Section, mount } from "./shell";

const languages = () => [
  ["", t("Automatic (query language, then UI language)")],
  ["en", t("English")],
  ["es", t("Spanish")],
  ["fr", t("French")],
  ["de", t("German")],
  ["it", t("Italian")],
  ["pt", t("Portuguese")],
  ["nl", t("Dutch")],
  ["ca", t("Catalan")],
  ["pl", t("Polish")],
  ["sv", t("Swedish")],
  ["ru", t("Russian")],
  ["uk", t("Ukrainian")],
  ["tr", t("Turkish")],
  ["ar", t("Arabic")],
  ["hi", t("Hindi")],
  ["ja", t("Japanese")],
  ["ko", t("Korean")],
  ["zh", t("Chinese")],
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

function CopyButton({ text, label }: { text: string; label?: string }) {
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
      {copied ? t("Copied") : (label ?? t("Copy"))}
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

/** Multi-line text that saves on blur. */
function LazyTextarea({ value, onSave, placeholder, rows = 4 }: { value: string; onSave: (v: string) => void; placeholder?: string; rows?: number }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return (
    <textarea
      className="input mono"
      rows={rows}
      value={draft}
      placeholder={placeholder}
      spellCheck={false}
      style={{ width: 320, height: "auto", padding: "8px 10px", resize: "vertical" }}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => draft !== value && onSave(draft)}
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
        placeholder={isSet ? t("•••••••••••• (saved)") : placeholder}
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
        {t("Save")}
      </button>
      {isSet && (
        <button className="btn small ghost danger" onClick={() => void api.call("settings.setSecret", name, "").then(onSaved)}>
          {t("Clear")}
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

const accessLevels = (): Array<{ level: AccessLevel; label: string; blurb: string }> => [
  { level: "read", label: t("Read-only"), blurb: t("Agents can look: read page text, list tabs and take screenshots. They cannot act on anything.") },
  { level: "standard", label: t("Standard"), blurb: t("Agents can navigate, click, type and fill in forms — enough to use most sites. The recommended default.") },
  { level: "full", label: t("Full"), blurb: t("Everything in Standard, plus running JavaScript in pages, uploading files, reading downloads and saving PDFs.") },
];

function AccessLevelControl({ value, onChange }: { value: AccessLevel; onChange: (v: AccessLevel) => void }) {
  const levels = accessLevels();
  const active = levels.find((o) => o.level === value) ?? levels[1]!;
  return (
    <div className="access-level">
      <div className="access-head">
        <div>{t("What agents can do")}</div>
        <div className="muted small">{t("Applies to every approved MCP client. Tools above the level are not offered at all.")}</div>
      </div>
      <div className="access-seg" role="radiogroup" aria-label={t("Agent access level")}>
        {levels.map((o) => (
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
          {t("Full access lets agents run arbitrary scripts and reach files on this machine. Only choose it for agents you fully trust.")}
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------------- sections

function AppearanceSection({ view, update }: { view: SettingsView; update: (p: SettingsPatch) => void }) {
  const a = view.settings.appearance;
  return (
    <Section id="appearance" title={t("Appearance")}>
      <Row label={t("Theme")}>
        <Segmented<ThemeSource>
          value={a.theme}
          options={[
            ["system", t("System")],
            ["light", t("Light")],
            ["dark", t("Dark")],
          ]}
          onChange={(theme) => update({ appearance: { theme } })}
        />
      </Row>
      <Row label={t("Language")} hint={t("Language of Corvus's settings and page menu. System follows your operating system.")}>
        <Segmented<UiLanguageSetting>
          value={a.language}
          options={[
            ["system", t("System")],
            ["en", "English"],
            ["es", "Español"],
          ]}
          onChange={(language) => update({ appearance: { language } })}
        />
      </Row>
      <Row label={t("Home button")} hint={t("Shows a home button next to reload. Alt+Home works too; Ctrl+click or middle-click opens it in a new tab.")}>
        <Toggle label={t("Home button")} checked={a.showHomeButton} onChange={(v) => update({ appearance: { showHomeButton: v } })} />
      </Row>
      <Row label={t("Home page")} hint={t("Where the home button takes you. Corvus opens the New Tab page with Corvus search.")}>
        <select className="input" value={a.homePage} onChange={(e) => update({ appearance: { homePage: e.target.value as HomePage } })}>
          <option value="corvus">{t("Corvus (New Tab page)")}</option>
          <option value="google">Google</option>
          <option value="bing">Bing</option>
          <option value="duckduckgo">DuckDuckGo</option>
          <option value="yahoo">Yahoo</option>
          <option value="ecosia">Ecosia</option>
          <option value="brave">Brave Search</option>
          <option value="startpage">Startpage</option>
          <option value="custom">{t("Another address…")}</option>
        </select>
      </Row>
      {a.homePage === "custom" && (
        <Row label={t("Home page address")} hint={t("An http or https address.")}>
          <LazyInput value={a.homeUrl} width={320} placeholder="https://" onSave={(v) => update({ appearance: { homeUrl: v.trim() } })} />
        </Row>
      )}
      <Row label={t("Show bookmarks bar")} hint="Ctrl+Shift+B">
        <Toggle label={t("Show bookmarks bar")} checked={a.showBookmarksBar} onChange={(v) => update({ appearance: { showBookmarksBar: v } })} />
      </Row>
      <Row label={t("Tabs")} hint={t("Classic top strip, or a resizable, collapsible sidebar on the left.")}>
        <Segmented<TabLayout>
          value={a.tabLayout}
          options={[
            ["horizontal", t("Top")],
            ["vertical", t("Sidebar")],
          ]}
          onChange={(tabLayout) => update({ appearance: { tabLayout } })}
        />
      </Row>
      {a.tabLayout === "vertical" && (
        <Row label={t("Sidebar width")} hint={t("Pixels (180–480). Drag the sidebar edge to resize too.")}>
          <LazyInput value={String(a.sidebarWidth)} type="number" width={120} onSave={(v) => update({ appearance: { sidebarWidth: Number(v) || 240 } })} />
        </Row>
      )}
    </Section>
  );
}

const watchIntervals = (): Array<[number, string]> => [
  [5, t("Every 5 minutes")],
  [15, t("Every 15 minutes")],
  [30, t("Every 30 minutes")],
  [60, t("Hourly")],
  [180, t("Every 3 hours")],
  [360, t("Every 6 hours")],
  [720, t("Every 12 hours")],
  [1440, t("Daily")],
];

function MonitoringSection({ view, update }: { view: SettingsView; update: (p: SettingsPatch) => void }) {
  const m = view.settings.monitor;
  return (
    <Section
      id="monitoring"
      title={t("Page-change monitoring")}
      description={t("“Watch this page” re-fetches pages you choose in the background, detects meaningful changes to their main text and writes a short AI summary of what changed. Read-only, public http(s) pages only. Watches are per profile and stay on this device.")}
    >
      <Row label={t("Enable monitoring")} hint={t("Turning this off stops all background checks.")}>
        <Toggle label={t("Enable monitoring")} checked={m.enabled} onChange={(v) => update({ monitor: { enabled: v } })} />
      </Row>
      <Row label={t("Default check interval")} hint={t("Used for newly watched pages; each page can be changed individually.")}>
        <select
          className="input"
          value={m.defaultIntervalMinutes}
          onChange={(e) => update({ monitor: { defaultIntervalMinutes: Number(e.target.value) } })}
        >
          {watchIntervals().map(([mins, label]) => (
            <option key={mins} value={mins}>
              {label}
            </option>
          ))}
        </select>
      </Row>
      <Row label={t("Maximum watched pages")} hint={t("Per profile (1–200).")}>
        <LazyInput value={String(m.maxWatches)} type="number" width={120} onSave={(v) => update({ monitor: { maxWatches: Number(v) || 50 } })} />
      </Row>
      <Row label={t("Open")} hint={t("See everything you are watching and the latest changes.")}>
        <a className="btn small" href="corvus://watches/">
          {t("Open watched pages")}
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
      title={t("Scheduled agents")}
      description={t("Run AI agent tasks on a schedule (cron or interval) in a background tab, with a notification summary. Risky actions (sign-in, payments, submitting forms) always pause for your approval and are never performed unattended. Schedules are per profile and stay on this device.")}
    >
      <Row label={t("Enable scheduled agents")} hint={t("Turning this off stops all scheduled runs.")}>
        <Toggle label={t("Enable scheduled agents")} checked={sa.enabled} onChange={(v) => update({ scheduledAgents: { enabled: v } })} />
      </Row>
      <Row label={t("Max steps per run")} hint={t("Hard cap on tool actions any scheduled run may take (1–50).")}>
        <LazyInput value={String(sa.maxSteps)} type="number" width={120} onSave={(v) => update({ scheduledAgents: { maxSteps: Math.max(1, Math.min(50, Number(v) || 12)) } })} />
      </Row>
      <Row label={t("Token budget per run")} hint={t("Total input + output tokens before a run stops.")}>
        <LazyInput value={String(sa.maxTokens)} type="number" width={120} onSave={(v) => update({ scheduledAgents: { maxTokens: Math.max(2000, Math.min(500000, Number(v) || 60000)) } })} />
      </Row>
      <Row label={t("Open")} hint={t("Add, edit, pause and watch your scheduled tasks.")}>
        <a className="btn small" href="corvus://schedules/">
          {t("Open scheduled agents")}
        </a>
      </Row>
    </Section>
  );
}

function ReaderSection({ view, update }: { view: SettingsView; update: (p: SettingsPatch) => void }) {
  const r = view.settings.reader;
  return (
    <Section id="reader" title={t("Reader mode")} description={t("Defaults for the clean reading view (open it with the book icon in the address bar).")}>
      <Row label={t("Font size")} hint="15–28 px">
        <LazyInput value={String(r.fontSize)} type="number" width={100} onSave={(v) => update({ reader: { fontSize: Number(v) || 19 } })} />
      </Row>
      <Row label={t("Line width")} hint={t("Characters per line (36–90).")}>
        <LazyInput value={String(r.lineWidth)} type="number" width={100} onSave={(v) => update({ reader: { lineWidth: Number(v) || 64 } })} />
      </Row>
      <Row label={t("Theme")}>
        <Segmented<"light" | "sepia" | "dark">
          value={r.theme}
          options={[
            ["light", t("Light")],
            ["sepia", t("Sepia")],
            ["dark", t("Dark")],
          ]}
          onChange={(theme) => update({ reader: { theme } })}
        />
      </Row>
      <Row label={t("Typeface")}>
        <Segmented<"serif" | "sans">
          value={r.font}
          options={[
            ["serif", t("Serif")],
            ["sans", t("Sans")],
          ]}
          onChange={(font) => update({ reader: { font } })}
        />
      </Row>
      <Row label={t("Translate articles to")} hint={t("Default target for the reader's Translate tool; blank uses your answer language.")}>
        <LazyInput value={r.translateLanguage} placeholder={t("e.g. Spanish")} onSave={(v) => update({ reader: { translateLanguage: v.trim() } })} />
      </Row>
    </Section>
  );
}

function PdfSection({ view, update }: { view: SettingsView; update: (p: SettingsPatch) => void }) {
  const pdf = view.settings.pdf;
  return (
    <Section id="pdf" title={t("PDF viewer")} description={t("Read PDFs inside Corvus with the reading AI tools (Key points, TL;DR, Simplify, Translate, read-aloud) and page citations.")}>
      <Row label={t("Open PDFs in Corvus")} hint={t("When off, PDFs download instead of opening in the in-app viewer.")}>
        <Toggle label={t("Use the in-app PDF viewer")} checked={pdf.openInViewer} onChange={(v) => update({ pdf: { openInViewer: v } })} />
      </Row>
    </Section>
  );
}

function SemanticSearchSection({ view, update }: { view: SettingsView; update: (p: SettingsPatch) => void }) {
  const s = view.settings.semanticSearch;
  return (
    <Section
      id="semantic-search"
      title={t("Find in my pages")}
      description={t("Search your own history, bookmarks and saved articles by meaning — from the Command Bar or corvus://find. Keyword search always works offline; embeddings are optional and never required.")}
    >
      <Row label={t("Index my pages")} hint={t("Keep a local, per-device text index of pages you visit, bookmark and save. Nothing leaves your machine.")}>
        <Toggle label={t("Keep a local search index")} checked={s.indexPages} onChange={(v) => update({ semanticSearch: { indexPages: v } })} />
      </Row>
      <Row label={t("Semantic ranking")} hint={t("Re-rank results with embeddings from your local model endpoint (configured under AI search). Falls back to keyword ranking when offline or unset.")}>
        <Toggle label={t("Use embeddings to improve ranking")} checked={s.useEmbeddings} onChange={(v) => update({ semanticSearch: { useEmbeddings: v } })} />
      </Row>
      <Row label={t("Embedding model")} hint={t("Model on your local endpoint, e.g. nomic-embed-text (Ollama) or an embeddings model served by LM Studio.")}>
        <LazyInput value={s.embeddingModel} placeholder="nomic-embed-text" onSave={(v) => update({ semanticSearch: { embeddingModel: v.trim() } })} />
      </Row>
    </Section>
  );
}

const providerHint = (): Record<string, string> => ({
  "anthropic-api": t("Anthropic API with your own key."),
  "claude-code-cli": t("Uses your local Claude Code login. Personal use only — distributed builds must use an API key."),
  local: t("A model running on this machine (Ollama or an OpenAI-compatible server). Offline, no API key, nothing leaves the device."),
});

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
        {state.busy ? t("Testing…") : t("Test connection")}
      </button>
      {state.result && <span className={`pill ${state.result.ok ? "ok" : "bad"}`}>{state.result.detail}</span>}
    </div>
  );
}

/** Embedding models cannot write answers: the picker and the offer skip them by default. */
const isEmbeddingModel = (name: string): boolean => /embed|bge-|minilm/i.test(name);

/** A model server running on this computer, offered in one click when another provider is set. */
function LocalServerOffer({ update }: { update: (p: SettingsPatch) => void }) {
  const [servers, setServers] = useState<LocalServerInfo[] | null>(null);
  useEffect(() => {
    void internalApi().call("settings.discoverLocal").then(setServers, () => setServers([]));
  }, []);
  const server = servers?.find((s) => s.models.some((m) => !isEmbeddingModel(m)));
  if (!server) return null;
  const chat = server.models.filter((m) => !isEmbeddingModel(m));
  return (
    <div className="notice local-offer">
      <span>
        {t("{name} is running on this computer with {count} models ({models}). Use it to keep AI search and Corvus Assist on this device, with no API key.", {
          name: server.name,
          count: chat.length,
          models: chat.slice(0, 3).join(", ") + (chat.length > 3 ? "…" : ""),
        })}
      </span>
      <button className="btn small primary" onClick={() => update({ ai: { provider: "local", localApi: server.api, localBaseUrl: server.baseUrl, model: chat[0] ?? "" } })}>
        {t("Use {name}", { name: server.name })}
      </button>
    </div>
  );
}

/** The local server's models to pick from (refreshable); a text field when the server does not answer. */
function LocalModelPicker({ model, deps, onChange }: { model: string; deps: string; onChange: (model: string) => void }) {
  const [models, setModels] = useState<string[] | null | undefined>(undefined);
  const load = useCallback(() => {
    setModels(undefined);
    void internalApi().call("settings.localModels").then(setModels, () => setModels(null));
  }, []);
  useEffect(load, [load, deps]);
  if (!models || models.length === 0) {
    return (
      <>
        <LazyInput value={model} placeholder="llama3.1" onSave={(v) => onChange(v.trim() || "llama3.1")} />
        <button className="btn small" disabled={models === undefined} onClick={load}>
          {models === undefined ? t("Looking…") : t("Refresh models")}
        </button>
      </>
    );
  }
  const listed = models.includes(model) || models.some((m) => m.split(":")[0] === model);
  return (
    <>
      <select className="input" aria-label={t("Model")} value={listed ? (models.find((m) => m === model) ?? models.find((m) => m.split(":")[0] === model)) : model} onChange={(e) => onChange(e.target.value)}>
        {!listed && <option value={model}>{t("{model} (not on the server)", { model: model || "—" })}</option>}
        {models.map((m) => (
          <option key={m} value={m}>
            {isEmbeddingModel(m) ? t("{model} (embeddings)", { model: m }) : m}
          </option>
        ))}
      </select>
      <button className="btn small" onClick={load}>
        {t("Refresh models")}
      </button>
    </>
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
      title={t("AI search")}
      description={t("Searches run against a retriever first (no AI, zero tokens). One small-model call then writes a cited answer.")}
    >
      <Row label={t("Engine status")}>
        {engine ? (
          engine.available ? (
            <span className="pill ok">
              {t("Ready")} · {engine.model}
            </span>
          ) : (
            <span className="pill bad" title={engine.reason ?? ""}>
              {t("Unavailable")}
            </span>
          )
        ) : (
          <span className="spinner" />
        )}
      </Row>
      {engine && !engine.available && engine.reason && <div className="notice warn">{engine.reason}</div>}
      {ai.provider !== "local" && <LocalServerOffer update={update} />}
      <Row label={t("AI provider")} hint={providerHint()[ai.provider] ?? ""}>
        <select className="input" value={ai.provider} onChange={(e) => update({ ai: { provider: e.target.value as typeof ai.provider } })}>
          <option value="anthropic-api">Anthropic API</option>
          <option value="claude-code-cli">{t("Claude Code CLI (local)")}</option>
          <option value="local">{t("Local model (offline)")}</option>
        </select>
      </Row>
      {ai.provider === "anthropic-api" && (
        <Row
          label={t("Anthropic API key")}
          hint={view.secretsPersisted ? t("Encrypted with your operating system keychain.") : t("No OS keychain available: the key is kept in memory until Corvus quits.")}
        >
          <SecretField name="anthropicApiKey" isSet={view.secrets.anthropicApiKey} onSaved={setView} placeholder="sk-ant-…" />
        </Row>
      )}
      {ai.provider === "claude-code-cli" && (
        <>
          <Row label={t("Claude CLI path")} hint={t("Executable used for `claude -p`, or a wrapper around it.")}>
            <LazyInput value={ai.claudeCliPath} placeholder="claude" onSave={(v) => update({ ai: { claudeCliPath: v } })} />
          </Row>
          <Row
            label={t("Claude Code account")}
            hint={t(
              "Claude Code picks the account from its config folder (CLAUDE_CONFIG_DIR). Follow the connected session to use the account of the Claude Code session that drives Corvus over MCP; it updates when that session reconnects.",
            )}
          >
            <select className="input" value={ai.claudeAccount} onChange={(e) => update({ ai: { claudeAccount: e.target.value as ClaudeAccountMode } })}>
              <option value="default">{t("Your default Claude Code login")}</option>
              <option value="folder">{t("A config folder")}</option>
              <option value="mcp">{t("Follow the Claude Code session connected over MCP")}</option>
            </select>
          </Row>
          {ai.claudeAccount === "folder" && (
            <Row label={t("Config folder")} hint={t("The CLAUDE_CONFIG_DIR of the account, for example C:\\Users\\you\\.claude-work.")}>
              <LazyInput value={ai.claudeConfigDir} width={320} placeholder="~/.claude" onSave={(v) => update({ ai: { claudeConfigDir: v.trim() } })} />
            </Row>
          )}
          {ai.claudeAccount === "mcp" && (
            <Row label={t("Following")}>
              <span className="muted small">
                {ai.mcpClaudeAt > 0
                  ? t("{folder} · from {client}, {time}", {
                      folder: ai.mcpClaudeConfigDir || t("Claude Code's default folder"),
                      client: ai.mcpClaudeClient,
                      time: formatTime(ai.mcpClaudeAt),
                    })
                  : t("No Claude Code session has connected yet; the default login is used until one does.")}
              </span>
            </Row>
          )}
          <Row
            label={t("Environment variables")}
            hint={t("Optional. One NAME=value per line, added to the Claude Code CLI process (proxy, base URL and so on). They stay on this device.")}
          >
            <LazyTextarea value={ai.cliEnv} placeholder={"HTTPS_PROXY=http://proxy:8080"} onSave={(v) => update({ ai: { cliEnv: v } })} />
          </Row>
        </>
      )}
      {ai.provider === "local" && (
        <>
          <Row label={t("Local API")} hint={t("Ollama speaks its own API; llama.cpp, LM Studio and vLLM speak the OpenAI-compatible one.")}>
            <select className="input" value={ai.localApi} onChange={(e) => update({ ai: { localApi: e.target.value === "openai" ? "openai" : "ollama" } })}>
              <option value="ollama">Ollama</option>
              <option value="openai">{t("OpenAI-compatible")}</option>
            </select>
          </Row>
          <Row label={t("Base URL")} hint={ai.localApi === "ollama" ? t("Ollama server, e.g. http://localhost:11434.") : t("Server root, e.g. http://localhost:1234/v1 (LM Studio).")}>
            <LazyInput value={ai.localBaseUrl} placeholder="http://localhost:11434" onSave={(v) => update({ ai: { localBaseUrl: v.trim() } })} />
          </Row>
        </>
      )}
      <Row label={t("Model")} hint={ai.provider === "local" ? t("The model name the server exposes, e.g. llama3.1 or qwen2.5.") : t("A small, fast model keeps answers cheap.")}>
        {ai.provider === "local" ? (
          <LocalModelPicker model={ai.model} deps={`${ai.localApi}|${ai.localBaseUrl}`} onChange={(model) => update({ ai: { model } })} />
        ) : (
          <LazyInput value={ai.model} placeholder="claude-haiku-5-5" onSave={(v) => update({ ai: { model: v.trim() || "claude-haiku-5-5" } })} />
        )}
      </Row>
      {ai.provider === "local" && (
        <Row label={t("Connection")} hint={t("No API key is needed — everything stays on this device.")}>
          <TestConnectionButton deps={[ai.provider, ai.localApi, ai.localBaseUrl, ai.model]} />
        </Row>
      )}
      <Row label={t("Answer length")} hint={t("Maximum output tokens per answer.")}>
        <LazyInput value={String(ai.maxOutputTokens)} type="number" width={120} onSave={(v) => update({ ai: { maxOutputTokens: Number(v) || 400 } })} />
      </Row>
      <Row label={t("Answer language")}>
        <select className="input" value={ai.answerLanguage} onChange={(e) => update({ ai: { answerLanguage: e.target.value } })}>
          {languages().map(([code, name]) => (
            <option key={code} value={code}>
              {name}
            </option>
          ))}
        </select>
      </Row>
      <Row label={t("Translate pages into")} hint={t("Translates pages in place with this AI provider, from the address bar or the page's right-click menu.")}>
        <select
          className="input"
          value={view.settings.translate.targetLanguage}
          onChange={(e) => update({ translate: { targetLanguage: e.target.value } })}
        >
          <option value="">{t("The Corvus language")}</option>
          {languages()
            .slice(1)
            .map(([code, name]) => (
              <option key={code} value={code}>
                {name}
              </option>
            ))}
        </select>
      </Row>
      <Row label={t("Offer to translate")} hint={t("Shows a translate button in the address bar on pages written in another language.")}>
        <Toggle label={t("Offer to translate")} checked={view.settings.translate.offer} onChange={(v) => update({ translate: { offer: v } })} />
      </Row>
      <Row label={t("Search backend")}>
        <select className="input" value={ai.retriever} onChange={(e) => update({ ai: { retriever: e.target.value as typeof ai.retriever } })}>
          <option value="searxng">{t("SearXNG (self-hosted)")}</option>
          <option value="brave">Brave Search API</option>
          <option value="duckduckgo">DuckDuckGo</option>
        </select>
      </Row>
      {ai.retriever === "searxng" && (
        <Row label={t("SearXNG URL")} hint={t("Run it with `docker compose up -d searxng`.")}>
          <LazyInput value={ai.searxngUrl} placeholder="http://localhost:8898" onSave={(v) => update({ ai: { searxngUrl: v.trim() } })} />
        </Row>
      )}
      {ai.retriever === "brave" && (
        <Row label={t("Brave Search API key")}>
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
      title={t("Passwords")}
      description={
        <>
          {t("Saved logins, 2FA codes and KeePass databases are managed on the")} <a href="corvus://passwords/">{t("Passwords")}</a>
          {t("page.")}
        </>
      }
    >
      <Row
        label={t("Let AI agents use logins you opt in")}
        hint={t("The Command Bar agent and Full-access MCP clients may sign in and fill 2FA codes, but only for logins you opt in one by one, and only after you approve each use. They never see the password or the code. Off by default; CAPTCHAs are solved by the agent when Corvus does not pass them, and handed back to you after two failed attempts.")}
      >
        <Toggle label={t("Let AI agents use logins you opt in")} checked={pw.agentAccess} onChange={(v) => update({ passwords: { agentAccess: v } })} />
      </Row>
      <Row label={t("Lock KeePass databases after")} hint={t("Minutes without keyboard or mouse activity. 0 keeps them unlocked until you lock them or quit.")}>
        <LazyInput
          value={String(pw.keepassAutoLockMinutes)}
          type="number"
          width={120}
          onSave={(v) => update({ passwords: { keepassAutoLockMinutes: Math.max(0, Math.min(1440, Math.round(Number(v)) || 0)) } })}
        />
      </Row>
      <Row
        label={t("Passkeys and security keys")}
        hint={t("Let sites ask for a passkey, Windows Hello or a USB security key. Off by default: sites then offer your password and 2FA code instead of opening the system security-key dialog. Applies to tabs opened afterwards.")}
      >
        <Toggle label={t("Passkeys and security keys")} checked={pw.passkeys} onChange={(v) => update({ passwords: { passkeys: v } })} />
      </Row>
    </Section>
  );
}

const presetLabel = (id: DictationPreset["id"]): string => (id === "openai" ? "OpenAI" : id === "groq" ? "Groq" : t("A server of your own (OpenAI-compatible)"));

function DictationSection({ view, update, setView }: { view: SettingsView; update: (p: SettingsPatch) => void; setView: (v: SettingsView) => void }) {
  const d = view.settings.dictation;
  const preset = DICTATION_PRESETS.find((p) => p.baseUrl === d.baseUrl && p.model === d.model)?.id ?? (d.baseUrl ? "custom" : "");
  const needsKey = DICTATION_PRESETS.find((p) => p.id === preset)?.needsKey ?? false;
  return (
    <Section
      id="dictation"
      title={t("Voice dictation")}
      description={t(
        "Dictate in the Command Bar and in Corvus Assist with the microphone button, or press Ctrl+Shift+K (⌘⇧K on macOS) to say a task for the agent. Corvus records only while you dictate and sends the recording to the speech-to-text service you choose here; it has no speech model of its own.",
      )}
    >
      <Row label={t("Dictation")}>
        <Toggle label={t("Dictation")} checked={d.enabled} onChange={(v) => update({ dictation: { enabled: v } })} />
      </Row>
      {d.enabled && (
        <>
          <Row label={t("Service")} hint={t("Any service with the OpenAI-compatible /audio/transcriptions endpoint works; choosing one fills in its address and model.")}>
            <select
              className="input"
              value={preset}
              onChange={(e) => {
                const p = DICTATION_PRESETS.find((x) => x.id === e.target.value);
                if (p) update({ dictation: { baseUrl: p.baseUrl, model: p.model } });
              }}
            >
              {preset === "" && <option value="">{t("Choose a service…")}</option>}
              {DICTATION_PRESETS.map((p) => (
                <option key={p.id} value={p.id}>
                  {presetLabel(p.id)}
                </option>
              ))}
              {preset === "custom" && <option value="custom">{t("Another service")}</option>}
            </select>
          </Row>
          <Row label={t("Base URL")} hint={t("Where the service's API starts, e.g. https://api.openai.com/v1.")}>
            <LazyInput value={d.baseUrl} width={320} placeholder="https://api.openai.com/v1" onSave={(v) => update({ dictation: { baseUrl: v.trim() } })} />
          </Row>
          <Row label={t("Model")} hint={t("The service's transcription model, e.g. gpt-4o-mini-transcribe (OpenAI) or whisper-large-v3-turbo (Groq).")}>
            <LazyInput value={d.model} width={320} placeholder="gpt-4o-mini-transcribe" onSave={(v) => update({ dictation: { model: v.trim() } })} />
          </Row>
          <Row
            label={t("API key")}
            hint={
              view.secretsPersisted
                ? t("Encrypted with your operating system keychain. A server on your own computer usually needs none.")
                : t("No OS keychain available: the key is kept in memory until Corvus quits.")
            }
          >
            <SecretField name="transcriptionApiKey" isSet={view.secrets.transcriptionApiKey} onSaved={setView} placeholder={needsKey ? "sk-…" : t("Optional")} />
          </Row>
          <Row label={t("Language you speak")} hint={t("Telling the service your language makes short commands come out more accurately.")}>
            <select className="input" value={d.language} onChange={(e) => update({ dictation: { language: e.target.value } })}>
              <option value="">{t("Let the service detect it")}</option>
              {languages()
                .slice(1)
                .map(([code, name]) => (
                  <option key={code} value={code}>
                    {name}
                  </option>
                ))}
            </select>
          </Row>
          <Row label={t("Status")}>
            {dictationReady(d) ? (
              needsKey && !view.secrets.transcriptionApiKey ? (
                <span className="pill bad">{t("Add the service's API key")}</span>
              ) : (
                <span className="pill ok">{t("Ready")}</span>
              )
            ) : (
              <span className="pill bad">{t("Needs a base URL and a model")}</span>
            )}
          </Row>
        </>
      )}
    </Section>
  );
}

function CommandAgentSection({ view, update }: { view: SettingsView; update: (p: SettingsPatch) => void }) {
  const agent = view.settings.agent;
  const ai = view.settings.ai;
  return (
    <Section
      id="command-agent"
      title={t("Command Bar agent")}
      description={t("Press Ctrl+K (⌘K on macOS) to open the Command Bar. Start the line with “> ” to ask Corvus to run a task — it drives a dedicated tab with the same tools AI agents use, and you watch each step.")}
    >
      <Row label={t("Provider")} hint={t("Agent runs use your AI search provider and model.")}>
        <span className="pill off">
          {ai.provider === "claude-code-cli" ? "Claude Code CLI" : ai.provider === "local" ? t("Local model") : "Anthropic API"} · {ai.model}
        </span>
      </Row>
      <Row label={t("Max steps")} hint={t("Most tool actions one task may take before it stops.")}>
        <LazyInput value={String(agent.maxSteps)} type="number" width={120} onSave={(v) => update({ agent: { maxSteps: Math.max(1, Math.min(50, Number(v) || 15)) } })} />
      </Row>
      <Row
        label={t("Ask before risky actions")}
        hint={t("When on, Corvus asks before the agent submits a form, signs in or takes another risky step. When off, the agent runs on its own, but anything that spends money, saved logins and 2FA codes still ask you each time, and card or password fields are always handed back to you. CAPTCHAs are solved by the agent and handed back only if it cannot finish.")}
      >
        <Toggle label={t("Ask before risky actions")} checked={agent.askBeforeRisky} onChange={(v) => update({ agent: { askBeforeRisky: v } })} />
      </Row>
      <Row
        label={t("Learn from runs (site memory)")}
        hint={t("After a successful run, Corvus keeps a few small hints per site (which buttons and fields worked, URL shapes, cookie banners) so later tasks there take fewer steps. Never typed values or passwords. Learning is per device; what is learned syncs end to end when Site memory sync is on. See and forget them on the Workflows page.")}
      >
        <Toggle label={t("Learn from runs (site memory)")} checked={agent.siteMemory} onChange={(v) => update({ agent: { siteMemory: v } })} />
      </Row>
      <Row
        label={t("Remember what you run")}
        hint={t("Tasks you give the agent and searches and addresses you type in the Command Bar show under “Recent” when it opens empty. They sync end to end when Command Bar history sync is on.")}
      >
        <Toggle label={t("Remember what you run")} checked={agent.rememberCommands} onChange={(v) => update({ agent: { rememberCommands: v } })} />
        <button
          className="btn small ghost"
          onClick={() => {
            if (confirm(t("Clear the Command Bar history? Your other synced devices forget it too."))) void internalApi().call("commands.clear");
          }}
        >
          {t("Clear")}
        </button>
      </Row>
      <Row
        label={t("Keep captures of agent runs")}
        hint={t("A small picture of the page after each step, shown with the run in the agent history so you can see what it did. Kept only on this device and deleted with the run.")}
      >
        <Toggle label={t("Keep captures of agent runs")} checked={agent.runScreenshots} onChange={(v) => update({ agent: { runScreenshots: v } })} />
      </Row>
      <Row
        label={t("What the agent remembers about you")}
        hint={t("Short facts the agent keeps so it need not ask every time (home city, usual airport, travel class, sizes). It can save one when you tell it to; add or remove them here. Kept on this device; never secrets, cards or codes.")}
      >
        <UserMemoryEditor />
      </Row>
    </Section>
  );
}

function UserMemoryEditor() {
  const api = internalApi();
  const [notes, setNotes] = useState<UserNote[]>([]);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void api.call("userMemory.list").then(setNotes);
  }, [api]);
  const add = (): void => {
    const text = draft.trim();
    if (!text) return;
    void api.call("userMemory.add", text).then((r) => {
      setNotes(r.notes);
      setError(r.error);
      if (!r.error) setDraft("");
    });
  };
  return (
    <div className="mem-editor" data-user-memory>
      <ul className="mem-list">
        {notes.map((n) => (
          <li key={n.id}>
            <span>{n.text}</span>
            <button className="icon-btn small" title={t("Forget this")} onClick={() => void api.call("userMemory.remove", n.id).then(setNotes)}>
              <IconClose size={13} />
            </button>
          </li>
        ))}
      </ul>
      <div className="mem-add">
        <input
          type="text"
          maxLength={200}
          placeholder={t("e.g. I live in Bilbao")}
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            setError(null);
          }}
          onKeyDown={(e) => e.key === "Enter" && add()}
        />
        <button className="btn small" onClick={add} disabled={!draft.trim()}>{t("Add")}</button>
      </div>
      {error && <p className="mem-error">{error}</p>}
      {notes.length > 0 && (
        <button className="link-btn mem-clear" onClick={() => void api.call("userMemory.clear").then(setNotes)}>{t("Forget everything")}</button>
      )}
    </div>
  );
}

function AgentsSection({ view, update }: { view: SettingsView; update: (p: SettingsPatch) => void }) {
  const api = internalApi();
  const [status, setStatus] = useState<McpStatus | null>(null);
  const [showToken, setShowToken] = useState(false);
  const mcp = view.settings.mcp;

  useEffect(() => {
    let alive = true;
    const refresh = (): void => {
      void api.call("mcp.status").then((s) => alive && setStatus(s));
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
      title={t("AI agents (MCP)")}
      description={t("Let Claude Code, Claude Desktop or any MCP client drive this browser over a local-only server (127.0.0.1) protected by a bearer token.")}
    >
      <Row label={t("Enable MCP server")} hint={t("New clients must be approved the first time they connect.")}>
        {status && (
          <span className={`pill ${status.running ? "ok" : status.enabled && !status.available ? "bad" : "off"}`}>
            {status.running ? t("Running on port {port}", { port: status.port ?? "" }) : status.enabled ? (status.available ? t("Starting…") : t("Unavailable")) : t("Off")}
          </span>
        )}
        {status && (
          <span className={`pill ${status.accessLevel === "full" ? "bad" : "off"}`} title={t("Access level approved agents run at")}>
            {t("{level} access", { level: accessLevels().find((o) => o.level === status.accessLevel)?.label ?? status.accessLevel })}
          </span>
        )}
        <Toggle label={t("Enable MCP server")} checked={mcp.enabled} onChange={(v) => update({ mcp: { enabled: v } })} />
      </Row>
      {status?.error && <div className="notice warn">{status.error}</div>}
      <Row label={t("Port")} hint={t("0 picks a random free port once and keeps it.")}>
        <LazyInput value={String(mcp.port)} type="number" width={120} onSave={(v) => update({ mcp: { port: Math.max(0, Math.min(65535, Number(v) || 0)) } })} />
      </Row>
      <Row label={t("Access token")}>
        <code className="mono">{status ? (showToken ? status.token : `${status.token.slice(0, 4)}…${status.token.slice(-4)}`) : "…"}</code>
        <button className="btn small ghost" onClick={() => setShowToken((s) => !s)}>
          {showToken ? t("Hide") : t("Show")}
        </button>
        {status && <CopyButton text={status.token} />}
        <button
          className="btn small"
          onClick={() => {
            if (confirm(t("Regenerate the token? Connected agents will need the new command."))) void api.call("mcp.regenerateToken").then(setStatus);
          }}
        >
          {t("Regenerate")}
        </button>
      </Row>
      {status?.command ? (
        <>
          <div className="row" style={{ borderBottom: "none" }}>
            <div className="row-label">
              <div>{t("Connect Claude Code")}</div>
              <div className="muted small">{t("Run this once in a terminal.")}</div>
            </div>
          </div>
          <div className="code-box">
            <code>{status.command}</code>
            <CopyButton text={status.command} />
          </div>
        </>
      ) : (
        <div className="notice">{t("Enable the server once to get a port and the `claude mcp add` command.")}</div>
      )}
      <AccessLevelControl value={resolveMcpAccessLevel(mcp)} onChange={(level) => update({ mcp: { accessLevel: level, allowEvaluate: level === "full" } })} />

      <Row label={t("Approved clients")} hint={t("Clients that connect without asking.")}>
        {mcp.approvedClients.length === 0 && <span className="muted">{t("None yet")}</span>}
        {mcp.approvedClients.map((name) => (
          <span key={name} className="pill">
            {name}
            <button
              className="btn small ghost"
              style={{ height: 18, padding: "0 4px" }}
              title={t("Revoke")}
              onClick={() => update({ mcp: { approvedClients: mcp.approvedClients.filter((n) => n !== name) } })}
            >
              ×
            </button>
          </span>
        ))}
      </Row>
      <AgentActivityLog view={view} update={update} />
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
    if (on && !confirm(t("Expose this browser to the local network?\n\nAny device that can reach this machine and has the access token will be able to drive the browser. Keep the token secret and rotate it if leaked."))) {
      return;
    }
    update({ mcp: { host: on ? "0.0.0.0" : "127.0.0.1" } });
  };

  return (
    <Section
      id="agents-remote"
      title={t("AI agents: remote access")}
      description={t("By default the MCP server listens on 127.0.0.1 and only local clients can reach it. Turn this on to also accept connections from other devices on your network. The bearer token is still required.")}
    >
      <Row label={t("Allow remote clients")} hint={t("Binds the server to 0.0.0.0 (all interfaces) instead of loopback only.")}>
        {status && <span className={`pill ${remote ? "bad" : "off"}`}>{remote ? t("All interfaces") : t("Loopback only")}</span>}
        <Toggle label={t("Allow remote clients")} checked={remote} onChange={toggleRemote} />
      </Row>
      {remote && (
        <div className="notice warn">
          {t(
            "This browser is reachable from your local network. Anyone who can connect to this machine and holds the access token can open tabs, read pages, click and type. Only enable this on trusted networks, and rotate the token if it may have leaked.",
          )}
        </div>
      )}
      {remote && !mcp.enabled && <div className="notice">{t("The MCP server is off. Enable it under “AI agents (MCP)” for remote access to take effect.")}</div>}
      {remote && status?.running && (
        <Row label={t("Connect a remote client")} hint={status.lanAddress ? t("Use this machine's network address.") : t("No network address detected; use this machine's LAN IP.")}>
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
    lists?.source === "network"
      ? "uBlock Origin + EasyList + EasyPrivacy"
      : lists?.source === "cache"
        ? t("uBlock Origin + EasyList + EasyPrivacy (cached)")
        : t("Built-in list (offline)");

  return (
    <Section
      id="adblock"
      title={t("Ad & tracker blocker")}
      description={t("Blocks ads and trackers with the lists uBlock Origin uses (its own filters, EasyList and EasyPrivacy): requests, page elements, and the scripts that keep sites like YouTube free of video ads. Blocking never applies to corvus:// pages or local addresses, and settings are per profile and never synced.")}
    >
      <Row label={t("Block ads and trackers")} hint={t("Applies to every site except those you allow below.")}>
        <Toggle label={t("Block ads and trackers")} checked={view?.enabled ?? true} onChange={(v) => run(api.call("adblock.setEnabled", v))} />
      </Row>
      <Row label={t("Hide cookie notices and annoyances")} hint={t("Cookie consent banners, newsletter pop-ups, app banners and other clutter, with the EasyList Cookie and uBlock Origin annoyances lists.")}>
        <Toggle
          label={t("Hide cookie notices and annoyances")}
          checked={view?.annoyances ?? true}
          disabled={view?.enabled === false}
          onChange={(v) => run(api.call("adblock.setOptions", { annoyances: v }))}
        />
      </Row>
      <Row
        label={t("Reject cookie banners automatically")}
        hint={t("Answers cookie consent banners for you with DuckDuckGo’s Autoconsent rules: rejects everything, or unticks every purpose and vendor and saves only what is needed. A banner it cannot answer is hidden. Sites you allow below, or from the shield, keep their banner.")}
      >
        <Toggle
          label={t("Reject cookie banners automatically")}
          checked={view?.cookieConsent ?? true}
          onChange={(v) => run(api.call("adblock.setOptions", { cookieConsent: v }))}
        />
      </Row>
      <Row
        label={t("Tell sites not to sell or share my data (Global Privacy Control)")}
        hint={t("Sends the Sec-GPC signal with every request and sets navigator.globalPrivacyControl in pages. In some places, such as California, sites must honour it.")}
      >
        <Toggle
          label={t("Tell sites not to sell or share my data (Global Privacy Control)")}
          checked={view?.gpc ?? true}
          onChange={(v) => run(api.call("adblock.setOptions", { gpc: v }))}
        />
      </Row>
      <Row label={t("Remove tracking from links")} hint={t("Opens addresses without their tracking parameters (utm_*, fbclid, gclid, msclkid and similar), which only tell trackers where you came from.")}>
        <Toggle
          label={t("Remove tracking from links")}
          checked={view?.cleanUrls ?? true}
          disabled={view?.enabled === false}
          onChange={(v) => run(api.call("adblock.setOptions", { cleanUrls: v }))}
        />
      </Row>
      <Row
        label={t("Block fingerprinting")}
        hint={t("Sites that read your canvas, graphics card, audio stack or CPU count to recognise you get slightly different values on each site and each session. Sites you allow below are left alone.")}
      >
        <Toggle
          label={t("Block fingerprinting")}
          checked={view?.fingerprinting ?? true}
          onChange={(v) => run(api.call("adblock.setOptions", { fingerprinting: v }))}
        />
      </Row>
      <Row label={t("Filter lists")} hint={lists?.updatedAt ? t("{count} rules", { count: lists.filterCount.toLocaleString() }) : t("Using the bundled list until the first update succeeds.")}>
        <span className="muted small">
          {sourceLabel}
          {lists?.updatedAt ? ` · ${t("updated {time}", { time: formatTime(lists.updatedAt) })}` : ` · ${t("never updated")}`}
        </span>
        <button className="btn small" disabled={lists?.updating} onClick={() => run(api.call("adblock.update"))}>
          {lists?.updating ? t("Updating…") : t("Update now")}
        </button>
      </Row>
      <Row
        label={t("My filters")}
        hint={t("Your own rules, one per line, in uBlock Origin syntax (example.com##.banner hides .banner on example.com). “Hide this element” on a page adds its rule here.")}
      >
        <LazyTextarea
          value={(view?.userFilters ?? []).join("\n")}
          rows={5}
          placeholder={"example.com##.newsletter-popup\n||tracker.example^"}
          onSave={(v) => run(api.call("adblock.setUserFilters", v))}
        />
      </Row>
      <Row label={t("Allowed sites")} hint={t("Sites where blocking is paused (chosen from the shield in the address bar).")}>
        {view && view.allowedSites.length === 0 && <span className="muted">{t("None")}</span>}
      </Row>
      {view && view.allowedSites.length > 0 && (
        <div className="list" style={{ borderTop: "1px solid var(--border-soft)" }}>
          {view.allowedSites.map((host) => (
            <div key={host} className="list-row">
              <span className="grow">{host}</span>
              <button className="btn small ghost danger" title={t("Remove")} onClick={() => run(api.call("adblock.removeAllowed", host))}>
                <IconTrash size={13} />
                {t("Remove")}
              </button>
            </div>
          ))}
        </div>
      )}
      <Row label={t("Sites with their cookie banner")} hint={t("Corvus leaves the cookie banner of these sites for you to answer (chosen from the shield in the address bar).")}>
        {view && view.consentAllowedSites.length === 0 && <span className="muted">{t("None")}</span>}
      </Row>
      {view && view.consentAllowedSites.length > 0 && (
        <div className="list" style={{ borderTop: "1px solid var(--border-soft)" }}>
          {view.consentAllowedSites.map((site) => (
            <div key={site} className="list-row">
              <span className="grow">{site}</span>
              <button className="btn small ghost danger" title={t("Remove")} onClick={() => run(api.call("adblock.removeConsentAllowed", site))}>
                <IconTrash size={13} />
                {t("Remove")}
              </button>
            </div>
          ))}
        </div>
      )}
      <Row label={t("Sites forgotten on close")} hint={t("Their cookies and stored data are deleted when you close their last tab (chosen from the shield in the address bar).")}>
        {view && view.forgetSites.length === 0 && <span className="muted">{t("None")}</span>}
      </Row>
      {view && view.forgetSites.length > 0 && (
        <div className="list" style={{ borderTop: "1px solid var(--border-soft)" }}>
          {view.forgetSites.map((site) => (
            <div key={site} className="list-row">
              <span className="grow">{site}</span>
              <button className="btn small ghost danger" title={t("Remove")} onClick={() => run(api.call("adblock.removeForgetSite", site))}>
                <IconTrash size={13} />
                {t("Remove")}
              </button>
            </div>
          ))}
        </div>
      )}
      <Feedback error={error} />
    </Section>
  );
}

type ProfileTransfer = { kind: "export"; id: string; name: string } | { kind: "import" };

/** The password step of exporting a profile to a file, or importing one. */
function ProfileTransferForm({ transfer, onDone, onCancel }: { transfer: ProfileTransfer; onDone: (note: string) => void; onCancel: () => void }) {
  const api = internalApi();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const exporting = transfer.kind === "export";
  const ready = exporting ? password.length >= 8 && password === confirm : password.length > 0;
  const go = (): void => {
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    const done = exporting
      ? api.call("profiles.export", transfer.id, password).then((saved) => (saved ? t("Profile exported.") : null))
      : api.call("profiles.import", password).then((p) => (p ? t("Imported as “{name}”.", { name: p.name }) : null));
    done
      .then((note) => (note ? onDone(note) : setBusy(false)))
      .catch((e: unknown) => {
        setError(errorMessage(e));
        setBusy(false);
      });
  };
  return (
    <div className="profile-transfer">
      <strong>{exporting ? t("Export “{name}”", { name: transfer.name }) : t("Import a profile")}</strong>
      <p className="muted small">
        {exporting
          ? t("Choose a password for the file: it is needed to import it, and cannot be recovered. Keep the file somewhere safe, as it holds your saved logins.")
          : t("Enter the password the profile was exported with, then choose its file. It becomes a new profile.")}
      </p>
      <div className="profile-transfer-fields">
        <input className="input" type="password" autoComplete="new-password" aria-label={t("Password")} placeholder={t("Password")} value={password} onChange={(e) => setPassword(e.target.value)} onKeyDown={(e) => e.key === "Enter" && go()} />
        {exporting && (
          <input className="input" type="password" autoComplete="new-password" aria-label={t("Repeat the password")} placeholder={t("Repeat the password")} value={confirm} onChange={(e) => setConfirm(e.target.value)} onKeyDown={(e) => e.key === "Enter" && go()} />
        )}
        <button className="btn small primary" disabled={!ready || busy} onClick={go}>
          {busy ? t("Working…") : exporting ? t("Export…") : t("Choose file…")}
        </button>
        <button className="btn small ghost" onClick={onCancel}>
          {t("Cancel")}
        </button>
      </div>
      {exporting && password.length > 0 && password.length < 8 && <div className="muted small">{t("At least 8 characters.")}</div>}
      {exporting && confirm.length > 0 && confirm !== password && <div className="muted small">{t("The passwords do not match.")}</div>}
      <Feedback error={error} />
    </div>
  );
}

function ProfilesSection() {
  const api = internalApi();
  const [data, setData] = useState<{ profiles: Profile[]; current: string } | null>(null);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [transfer, setTransfer] = useState<ProfileTransfer | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const reload = useCallback(() => void api.call("profiles.list").then(setData), [api]);
  useEffect(reload, [reload]);

  const run = (p: Promise<unknown>): void => {
    setError(null);
    p.then(reload).catch((e: unknown) => setError(errorMessage(e)));
  };

  return (
    <Section id="profiles" title={t("Profiles")} description={t("Each profile has its own cookies, history, bookmarks, extensions and sync.")}>
      {data?.profiles.map((p) => (
        <Row
          key={p.id}
          label={
            <span className="inline">
              <span className="avatar-dot" style={{ background: p.avatar ?? "var(--accent)" }}>
                {p.name.charAt(0).toUpperCase()}
              </span>
              <LazyInput value={p.name} width={220} onSave={(v) => run(api.call("profiles.rename", p.id, v))} />
              {p.id === data.current && <span className="pill">{t("This window")}</span>}
              {p.syncChainId && <span className="pill ok">{t("Synced")}</span>}
            </span>
          }
        >
          <button className="btn small" onClick={() => run(api.call("profiles.openWindow", p.id))}>
            {t("Open window")}
          </button>
          <button className="btn small" onClick={() => setTransfer({ kind: "export", id: p.id, name: p.name })}>
            {t("Export…")}
          </button>
          <button className="btn small ghost danger" disabled={data.profiles.length <= 1} onClick={() => run(api.call("profiles.remove", p.id))}>
            {t("Delete")}
          </button>
        </Row>
      ))}
      <Row
        label={t("Move a profile")}
        hint={t("Export saves a profile as one file protected by a password: bookmarks, history, reading list, annotations, workspaces, site settings, containers, watched pages, workflows and saved logins. Cookies, extensions and KeePass databases stay on this computer.")}
      >
        <button className="btn small" onClick={() => setTransfer({ kind: "import" })}>
          {t("Import profile…")}
        </button>
      </Row>
      {transfer && (
        <ProfileTransferForm
          transfer={transfer}
          onDone={(note) => {
            setTransfer(null);
            setNotice(note);
            reload();
          }}
          onCancel={() => setTransfer(null)}
        />
      )}
      {notice && <div className="notice">{notice}</div>}
      <Row label={t("Add profile")}>
        <input className="input" placeholder={t("Profile name")} value={name} onChange={(e) => setName(e.target.value)} />
        <button
          className="btn small primary"
          disabled={!name.trim()}
          onClick={() => {
            run(api.call("profiles.create", name).then(() => setName("")));
          }}
        >
          {t("Create")}
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
      title={t("Updates")}
      description={t("Corvus updates itself from its GitHub Releases, or from a self-hosted feed you set below. Updates apply to this install and are never synced.")}
    >
      <Row label={t("Current version")}>
        <span className="pill off">Corvus {status?.currentVersion ?? "…"}</span>
        {status && !status.supported && <span className="muted small">{status.reason}</span>}
        {status?.supported && status.portable && (
          <span className="muted small">{t("Portable copy: an update replaces this file and starts the new version.")}</span>
        )}
      </Row>
      <Row
        label={t("Third-party software")}
        hint={t("Corvus includes open-source packages under their own licences. The source is MPL-2.0; this app is distributed under GPL-3.0 because it includes electron-chrome-extensions. Source: github.com/ParendumOU/Corvus.")}
      >
        <button className="btn small" onClick={() => void api.call("app.openThirdPartyNotices").then(setNoticesError)}>
          {t("View licences")}
        </button>
        {noticesError && <span className="muted small">{noticesError}</span>}
      </Row>
      <Row label={t("Release channel")} hint={t("Beta receives pre-releases from the same feed.")}>
        <Segmented<UpdateChannel>
          value={u.channel}
          options={[
            ["stable", t("Stable")],
            ["beta", t("Beta")],
          ]}
          onChange={(channel) => update({ update: { channel } })}
        />
      </Row>
      <Row label={t("Check on startup")} hint={t("Look for updates each time Corvus starts.")}>
        <Toggle label={t("Check on startup")} checked={u.autoCheck} onChange={(v) => update({ update: { autoCheck: v } })} />
      </Row>
      <Row label={t("Update feed URL")} hint={t("Base URL of a self-hosted “generic” feed. Blank uses GitHub Releases.")}>
        <LazyInput
          value={u.feedUrl}
          width={320}
          placeholder={status?.feedUrl ?? "https://updates.example.com/corvus"}
          onSave={(v) => update({ update: { feedUrl: v.trim() } })}
        />
      </Row>
      <Row label={t("Updates")} hint={t("Check now, then download and restart to install.")}>
        <button className="btn small" disabled={checking || !status?.supported} onClick={check}>
          {checking ? t("Checking…") : t("Check for updates")}
        </button>
        {phase === "available" && (
          <button className="btn small primary" onClick={download}>
            {t("Download")}
            {status?.newVersion ? ` ${status.newVersion}` : ""}
          </button>
        )}
        {phase === "downloaded" && (
          <button className="btn small primary" onClick={install}>
            {t("Restart to update")}
          </button>
        )}
      </Row>
      {phase === "downloading" && (
        <Row label={t("Downloading")} hint={status?.newVersion ? t("Version {version}", { version: status.newVersion }) : undefined}>
          <progress max={100} value={status?.percent ?? 0} style={{ width: 200 }} />
          <span className="muted small">{status?.percent ?? 0}%</span>
        </Row>
      )}
      {phase === "not-available" && <div className="notice">{t("You’re on the latest version.")}</div>}
      {phase === "downloaded" && (
        <div className="notice">{t("Version {version} is ready. Restart Corvus to finish updating.", { version: status?.newVersion ?? "" })}</div>
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
  // Before anything renders, so the whole page follows a language change at once.
  if (view) setUiLanguage(resolveUiLanguage(view.settings.appearance.language, navigator.language));

  useEffect(() => {
    document.title = t("Settings");
  });

  // Opened on a section (corvus://settings/#semantic-search): go to it once the page is drawn, and
  // again a moment later, after sections that load their own data have taken their height.
  useEffect(() => {
    const hash = location.hash.slice(1);
    if (!view || !hash) return;
    const go = (): void => document.getElementById(hash)?.scrollIntoView({ block: "start" });
    go();
    const later = setTimeout(go, 400);
    return () => clearTimeout(later);
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
      t("Appearance & reading"),
      [
        ["appearance", t("Appearance")],
        ["reader", t("Reader mode")],
        ["pdf", t("PDF viewer")],
      ],
    ],
    [
      t("Browsing"),
      [
        ["semantic-search", t("Find in my pages")],
        ["startup", t("On startup")],
        ["site-search", t("Search shortcuts")],
        ["memory", t("Memory")],
        ["media", t("Media")],
        ["phone", t("Send to your phone")],
        ["downloads", t("Downloads")],
        ["passwords", t("Passwords")],
        ["site-permissions", t("Site permissions")],
        ["adblock", t("Ad blocker")],
        ["containers", t("Containers")],
        ["connections", t("Connections")],
        ["monitoring", t("Page monitoring")],
      ],
    ],
    [
      t("AI & agents"),
      [
        ["ai", t("AI search")],
        ["dictation", t("Voice dictation")],
        ["command-agent", t("Command Bar")],
        ["scheduled-agents", t("Scheduled agents")],
        ["agents", t("AI agents")],
        ["agents-remote", t("Remote access")],
        ["webscope", t("Security workbench")],
      ],
    ],
    [
      t("System"),
      [
        ["profiles", t("Profiles")],
        ["sync", t("Sync")],
        ["updates", t("Updates")],
        ["crash-logs", t("Crash logs")],
        ["onboarding", t("First-run setup")],
      ],
    ],
  ];

  return (
    <PageShell
      title={t("Settings")}
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
          <DefaultBrowserSection view={view} update={update} />
          <SiteSearchSection />
          <MemorySection view={view} update={update} />
          <MediaSection view={view} update={update} />
          <PhoneSection view={view} update={update} />
          <DownloadsSection view={view} update={update} setView={setView} />
          <ImportSection />
          <PasswordsSection view={view} update={update} />
          <SitePermissionsSection />
          <AdblockSection />
          <ContainersSection />
          <ConnectionsSection />
          <MonitoringSection view={view} update={update} />
          <AiSection view={view} update={update} setView={setView} />
          <DictationSection view={view} update={update} setView={setView} />
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
            {t("An AI-native browser that is also an MCP server.")}
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
      title={t("Security workbench (WebScope)")}
      description={t("A Burp-style workbench over your own browser traffic: capture, replay, fuzz and transform in-scope requests. For authorized testing only. Off by default.")}
    >
      <Row label={t("Enable WebScope")} hint={t("Captures this profile's HTTP traffic for inspection. Everything stays scoped to the allowlist.")}>
        <Toggle label={t("Enable WebScope")} checked={ws.enabled} onChange={(v) => update({ webscope: { enabled: v } })} />
      </Row>
      <Row label={t("Open")} hint={t("Capture, Repeater, Fuzzer, Rules, Scope, Decoder and Comparer.")}>
        <a className="btn small" href="corvus://webscope/">
          {t("Open WebScope")}
        </a>
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
      title={t("Crash & error logs")}
      description={t("If Corvus or a page crashes, save a local diagnostic log you can use to report the problem. Logs stay on this device in a rotating file under your user data folder and are never uploaded. Off by default.")}
    >
      <Row label={t("Save crash logs locally")} hint={t("Records main-process errors and tab crashes to a local file. Nothing is sent anywhere.")}>
        <Toggle
          label={t("Save crash logs locally")}
          checked={view.settings.crashReports.saveLogs}
          onChange={(v) => update({ crashReports: { saveLogs: v } })}
        />
      </Row>
      <Row label={t("Log folder")} hint={logPath || undefined}>
        <button className="btn small" onClick={openFolder}>
          {t("Open log folder")}
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
      title={t("First-run setup")}
      description={t("Re-run the welcome wizard to reconfigure your AI provider, sync, imports and preferences. It normally appears only once, on first launch.")}
    >
      <Row label={t("Welcome wizard")} hint={t("Opens the step-by-step setup in a new page. Nothing changes until you pick it there.")}>
        <a className="btn small" href="corvus://welcome/">
          {t("Run setup again")}
        </a>
      </Row>
    </Section>
  );
}

mount(<SettingsPage />);
