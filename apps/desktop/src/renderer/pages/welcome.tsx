import { useEffect, useState } from "react";
import type { AdblockView } from "../../shared/adblock";
import type { BookmarkImportResult, ConnectionTestResult, SyncStatus } from "../../shared/ipc";
import type { SettingsPatch, SettingsView, ThemeSource } from "../../shared/settings";
import { errorMessage, internalApi } from "../common/api";
import { CorvusMark } from "../common/icons";
import "./welcome.css";
import { mount } from "./shell";

const STEP_TITLES = ["AI provider", "Sync", "Import", "Preferences"] as const;

function goToBrowser(): void {
  window.location.href = "corvus://newtab/";
}

function SecretField({ isSet, persisted, onSaved }: { isSet: boolean; persisted: boolean; onSaved: (view: SettingsView) => void }) {
  const [value, setValue] = useState("");
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = (): void => {
    const trimmed = value.trim();
    if (!trimmed) return;
    setError(null);
    internalApi()
      .call("settings.setSecret", "anthropicApiKey", trimmed)
      .then((view) => {
        onSaved(view);
        setValue("");
        setSaved(true);
        setTimeout(() => setSaved(false), 1800);
      })
      .catch((e: unknown) => setError(errorMessage(e)));
  };
  return (
    <div className="wz-secret">
      <div className="wz-inline">
        <input
          className="input"
          type="password"
          value={value}
          placeholder={isSet ? "••••••••  (a key is saved)" : "sk-ant-…"}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") save();
          }}
        />
        <button className="btn small" disabled={!value.trim()} onClick={save}>
          {saved ? "Saved" : "Save key"}
        </button>
      </div>
      <p className="wz-hint">
        {persisted ? "Stored encrypted in your OS keychain." : "No OS keychain here: the key is kept in memory until Corvus quits."}
        {isSet && " A key is already saved."}
      </p>
      {error && <div className="wz-notice error">{error}</div>}
    </div>
  );
}

function TestConnection({ deps }: { deps: unknown[] }) {
  const [state, setState] = useState<{ busy: boolean; result: ConnectionTestResult | null }>({ busy: false, result: null });
  useEffect(() => setState({ busy: false, result: null }), deps);
  const run = (): void => {
    setState({ busy: true, result: null });
    internalApi()
      .call("settings.testConnection")
      .then((result) => setState({ busy: false, result }))
      .catch((e: unknown) => setState({ busy: false, result: { ok: false, detail: errorMessage(e) } }));
  };
  return (
    <div className="wz-inline">
      <button className="btn small" disabled={state.busy} onClick={run}>
        {state.busy ? "Testing…" : "Test connection"}
      </button>
      {state.result && <span className={`wz-pill ${state.result.ok ? "ok" : "bad"}`}>{state.result.detail}</span>}
    </div>
  );
}

function ProviderStep({ view, update, setView }: { view: SettingsView; update: (p: SettingsPatch) => void; setView: (v: SettingsView) => void }) {
  const ai = view.settings.ai;
  return (
    <div className="wz-step">
      <p className="wz-lead">Corvus writes cited answers with a small model. Pick where that model runs — you can change this later in Settings.</p>
      <label className="wz-field">
        <span>AI provider</span>
        <select className="input" value={ai.provider} onChange={(e) => update({ ai: { provider: e.target.value as typeof ai.provider } })}>
          <option value="anthropic-api">Anthropic API (your key)</option>
          <option value="claude-code-cli">Claude Code CLI (local login)</option>
          <option value="local">Local model — Ollama / OpenAI-compatible (offline)</option>
        </select>
      </label>

      {ai.provider === "anthropic-api" && (
        <label className="wz-field">
          <span>Anthropic API key</span>
          <SecretField isSet={view.secrets.anthropicApiKey} persisted={view.secretsPersisted} onSaved={setView} />
        </label>
      )}

      {ai.provider === "claude-code-cli" && (
        <label className="wz-field">
          <span>Claude CLI path</span>
          <input
            className="input"
            defaultValue={ai.claudeCliPath}
            placeholder="claude"
            onBlur={(e) => update({ ai: { claudeCliPath: e.target.value.trim() || "claude" } })}
          />
          <p className="wz-hint">Uses your local Claude Code login. Personal use only — distributed builds must use an API key.</p>
        </label>
      )}

      {ai.provider === "local" && (
        <>
          <label className="wz-field">
            <span>Local API</span>
            <select className="input" value={ai.localApi} onChange={(e) => update({ ai: { localApi: e.target.value === "openai" ? "openai" : "ollama" } })}>
              <option value="ollama">Ollama</option>
              <option value="openai">OpenAI-compatible</option>
            </select>
          </label>
          <label className="wz-field">
            <span>Base URL</span>
            <input
              className="input"
              defaultValue={ai.localBaseUrl}
              placeholder="http://localhost:11434"
              onBlur={(e) => update({ ai: { localBaseUrl: e.target.value.trim() } })}
            />
          </label>
        </>
      )}

      <label className="wz-field">
        <span>Model</span>
        <input
          className="input"
          defaultValue={ai.model}
          placeholder={ai.provider === "local" ? "llama3.1" : "claude-haiku-5-5"}
          onBlur={(e) => update({ ai: { model: e.target.value.trim() || (ai.provider === "local" ? "llama3.1" : "claude-haiku-5-5") } })}
        />
      </label>

      {ai.provider === "local" && <TestConnection deps={[ai.provider, ai.localApi, ai.localBaseUrl, ai.model]} />}
    </div>
  );
}

function PhraseGrid({ phrase }: { phrase: string }) {
  return (
    <div className="wz-phrase">
      {phrase.split(" ").map((w, i) => (
        <span key={i}>
          <i>{i + 1}</i>
          {w}
        </span>
      ))}
    </div>
  );
}

function SyncStep({ status, onStatus }: { status: SyncStatus | null; onStatus: (s: SyncStatus) => void }) {
  const api = internalApi();
  const [serverUrl, setServerUrl] = useState("");
  const [deviceName, setDeviceName] = useState("");
  const [generated, setGenerated] = useState<string | null>(null);
  const [savedPhrase, setSavedPhrase] = useState(false);
  const [joinPhrase, setJoinPhrase] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (status) {
      setServerUrl((v) => v || status.serverUrl);
      setDeviceName((v) => v || status.deviceName);
    }
  }, [status]);

  if (!status) return <div className="wz-step">Loading…</div>;
  if (!status.available) {
    return (
      <div className="wz-step">
        <div className="wz-notice warn">Sync is not available in this build. You can skip this step.</div>
      </div>
    );
  }
  if (status.enabled) {
    return (
      <div className="wz-step">
        <div className="wz-notice ok">Sync is on for this profile. Device “{status.deviceName}”.</div>
        <p className="wz-hint">Manage it any time in Settings → Sync.</p>
      </div>
    );
  }

  const enable = (phrase: string): void => {
    setBusy(true);
    setError(null);
    api
      .call("sync.enable", { serverUrl, phrase, deviceName })
      .then(onStatus)
      .catch((e: unknown) => setError(errorMessage(e)))
      .finally(() => setBusy(false));
  };

  return (
    <div className="wz-step">
      <p className="wz-lead">
        Sync is end-to-end encrypted — the server only stores ciphertext. A 24-word recovery phrase is the key. Skip this and set it up later if you prefer.
      </p>
      <label className="wz-field">
        <span>Sync server</span>
        <input className="input" value={serverUrl} onChange={(e) => setServerUrl(e.target.value)} placeholder="http://localhost:8797" />
      </label>
      <label className="wz-field">
        <span>Device name</span>
        <input className="input" value={deviceName} onChange={(e) => setDeviceName(e.target.value)} />
      </label>

      <div className="wz-two">
        <div className="wz-card">
          <h3>Start a new chain</h3>
          <p className="wz-hint">Creates a fresh 24-word phrase. Anyone with it can read your synced data.</p>
          <button
            className="btn small"
            onClick={() => {
              setError(null);
              api
                .call("sync.generatePhrase")
                .then((p) => {
                  setGenerated(p);
                  setSavedPhrase(false);
                })
                .catch((e: unknown) => setError(errorMessage(e)));
            }}
          >
            Generate phrase
          </button>
          {generated && (
            <>
              <PhraseGrid phrase={generated} />
              <label className="wz-check">
                <input type="checkbox" checked={savedPhrase} onChange={(e) => setSavedPhrase(e.target.checked)} /> I wrote this phrase down somewhere safe
              </label>
              <button className="btn small primary" disabled={!savedPhrase || busy} onClick={() => enable(generated)}>
                Turn on sync
              </button>
            </>
          )}
        </div>

        <div className="wz-card">
          <h3>Join an existing chain</h3>
          <p className="wz-hint">Enter the recovery phrase from another device. This profile takes the synced data.</p>
          <textarea
            className="input"
            rows={3}
            value={joinPhrase}
            onChange={(e) => setJoinPhrase(e.target.value)}
            placeholder="24 words separated by spaces"
            spellCheck={false}
          />
          <button className="btn small primary" disabled={!joinPhrase.trim() || busy} onClick={() => enable(joinPhrase)}>
            {busy ? "Joining…" : "Join and sync"}
          </button>
        </div>
      </div>
      {error && <div className="wz-notice error">{error}</div>}
    </div>
  );
}

function ImportStep() {
  const [result, setResult] = useState<BookmarkImportResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = (): void => {
    setBusy(true);
    setError(null);
    internalApi()
      .call("onboarding.importBookmarks")
      .then(setResult)
      .catch((e: unknown) => setError(errorMessage(e)))
      .finally(() => setBusy(false));
  };
  return (
    <div className="wz-step">
      <p className="wz-lead">
        Bring your bookmarks over from another browser. In that browser choose <strong>Export bookmarks to HTML</strong> (Chrome, Edge, Firefox, Safari and Brave
        all have it), then pick the file here. A Chrome/Edge <code>Bookmarks</code> file works too.
      </p>
      <button className="btn small primary" disabled={busy} onClick={run}>
        {busy ? "Importing…" : "Choose a bookmarks file…"}
      </button>
      {result && !result.canceled && (
        <div className={`wz-notice ${result.imported > 0 ? "ok" : "warn"}`}>
          {result.imported > 0
            ? `Imported ${result.imported} bookmark${result.imported === 1 ? "" : "s"}${result.folders > 0 ? ` in ${result.folders} folder${result.folders === 1 ? "" : "s"}` : ""} from ${result.source}.`
            : `No bookmarks found in ${result.source}.`}
        </div>
      )}
      {error && <div className="wz-notice error">{error}</div>}
      <p className="wz-hint">
        History isn’t imported: browsers keep it in a locked database that can’t be read cleanly from an exported file. You can skip this step.
      </p>
    </div>
  );
}

function PreferencesStep({ view, update }: { view: SettingsView; update: (p: SettingsPatch) => void }) {
  const api = internalApi();
  const ai = view.settings.ai;
  const [adblock, setAdblock] = useState<AdblockView | null>(null);
  useEffect(() => {
    void api.call("adblock.get").then(setAdblock);
  }, [api]);
  return (
    <div className="wz-step">
      <p className="wz-lead">A few defaults to finish. All of these live in Settings afterwards.</p>
      <label className="wz-field">
        <span>Default search</span>
        <select className="input" value={ai.retriever} onChange={(e) => update({ ai: { retriever: e.target.value as typeof ai.retriever } })}>
          <option value="searxng">SearXNG (self-hosted)</option>
          <option value="brave">Brave Search API</option>
          <option value="duckduckgo">DuckDuckGo</option>
        </select>
      </label>
      <label className="wz-field">
        <span>Theme</span>
        <select className="input" value={view.settings.appearance.theme} onChange={(e) => update({ appearance: { theme: e.target.value as ThemeSource } })}>
          <option value="system">Match system</option>
          <option value="light">Light</option>
          <option value="dark">Dark</option>
        </select>
      </label>
      <label className="wz-toggle">
        <input
          type="checkbox"
          checked={adblock?.enabled ?? true}
          disabled={!adblock}
          onChange={(e) => void api.call("adblock.setEnabled", e.target.checked).then(setAdblock)}
        />
        <span>Block ads and trackers</span>
      </label>
    </div>
  );
}

function WelcomePage() {
  const api = internalApi();
  const [step, setStep] = useState(0);
  const [view, setView] = useState<SettingsView | null>(null);
  const [sync, setSync] = useState<SyncStatus | null>(null);
  const [finishing, setFinishing] = useState(false);

  useEffect(() => {
    void api.call("settings.get").then(setView);
    void api.call("sync.status").then(setSync);
  }, [api]);

  const update = (patch: SettingsPatch): void => {
    void api.call("settings.update", patch).then(setView);
  };
  const finish = (): void => {
    setFinishing(true);
    void api
      .call("onboarding.complete")
      .catch(() => undefined)
      .finally(goToBrowser);
  };

  const last = STEP_TITLES.length - 1;

  return (
    <div className="wz">
      <aside className="wz-side">
        <div className="wz-brand">
          <CorvusMark size={30} />
          <span>Corvus</span>
        </div>
        <ol className="wz-steps">
          {STEP_TITLES.map((title, i) => (
            <li key={title} className={i === step ? "active" : i < step ? "done" : ""}>
              <i>{i + 1}</i>
              <span>{title}</span>
            </li>
          ))}
        </ol>
        <button className="wz-skip" onClick={finish} disabled={finishing}>
          Skip setup
        </button>
      </aside>

      <main className="wz-main">
        <header className="wz-head">
          <h1>{step === 0 ? "Welcome to Corvus" : STEP_TITLES[step]}</h1>
          <p className="wz-sub">Step {step + 1} of {STEP_TITLES.length}</p>
        </header>

        <div className="wz-content">
          {!view ? (
            <div className="wz-step">Loading…</div>
          ) : step === 0 ? (
            <ProviderStep view={view} update={update} setView={setView} />
          ) : step === 1 ? (
            <SyncStep status={sync} onStatus={setSync} />
          ) : step === 2 ? (
            <ImportStep />
          ) : (
            <PreferencesStep view={view} update={update} />
          )}
        </div>

        <footer className="wz-foot">
          <button className="btn ghost" disabled={step === 0 || finishing} onClick={() => setStep((s) => Math.max(0, s - 1))}>
            Back
          </button>
          {step < last ? (
            <div className="wz-foot-right">
              <button className="btn ghost" onClick={() => setStep((s) => Math.min(last, s + 1))}>
                Skip
              </button>
              <button className="btn primary" onClick={() => setStep((s) => Math.min(last, s + 1))}>
                Next
              </button>
            </div>
          ) : (
            <button className="btn primary" disabled={finishing} onClick={finish}>
              {finishing ? "Finishing…" : "Finish"}
            </button>
          )}
        </footer>
      </main>
    </div>
  );
}

mount(<WelcomePage />);
