import { useEffect, useState } from "react";
import type { AdblockView } from "../../shared/adblock";
import type { BookmarkImportResult, ConnectionTestResult, SyncStatus } from "../../shared/ipc";
import type { SettingsPatch, SettingsView, ThemeSource } from "../../shared/settings";
import { isLoopbackUrl } from "@corvus/shared";
import { errorMessage, internalApi } from "../common/api";
import { CorvusMark } from "../common/icons";
import "./welcome.css";
import { BrowserImportPanel } from "./settings-import";
import { mount } from "./shell";

import { t } from "../common/i18n";
const STEP_TITLES = [t("AI provider"), t("Sync"), t("Import"), t("Preferences")] as const;

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
          placeholder={isSet ? t("••••••••  (a key is saved)") : "sk-ant-…"}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") save();
          }}
        />
        <button className="btn small" disabled={!value.trim()} onClick={save}>
          {saved ? t("Saved") : t("Save key")}
        </button>
      </div>
      <p className="wz-hint">
        {persisted ? t("Stored encrypted in your OS keychain.") : t("No OS keychain here: the key is kept in memory until Corvus quits.")}
        {isSet && t(" A key is already saved.")}
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
        {state.busy ? t("Testing…") : t("Test connection")}
      </button>
      {state.result && <span className={`wz-pill ${state.result.ok ? "ok" : "bad"}`}>{state.result.detail}</span>}
    </div>
  );
}

function ProviderStep({ view, update, setView }: { view: SettingsView; update: (p: SettingsPatch) => void; setView: (v: SettingsView) => void }) {
  const ai = view.settings.ai;
  return (
    <div className="wz-step">
      <p className="wz-lead">{t("Corvus writes cited answers with a small model. Pick where that model runs — you can change this later in Settings.")}</p>
      <label className="wz-field">
        <span>{t("AI provider")}</span>
        <select className="input" value={ai.provider} onChange={(e) => update({ ai: { provider: e.target.value as typeof ai.provider } })}>
          <option value="anthropic-api">{t("Anthropic API (your key)")}</option>
          <option value="claude-code-cli">{t("Claude Code CLI (local login)")}</option>
          <option value="local">{t("Local model — Ollama / OpenAI-compatible (offline)")}</option>
        </select>
      </label>

      {ai.provider === "anthropic-api" && (
        <label className="wz-field">
          <span>{t("Anthropic API key")}</span>
          <SecretField isSet={view.secrets.anthropicApiKey} persisted={view.secretsPersisted} onSaved={setView} />
        </label>
      )}

      {ai.provider === "claude-code-cli" && (
        <label className="wz-field">
          <span>{t("Claude CLI path")}</span>
          <input
            className="input"
            defaultValue={ai.claudeCliPath}
            placeholder={t("claude")}
            onBlur={(e) => update({ ai: { claudeCliPath: e.target.value.trim() || "claude" } })}
          />
          <p className="wz-hint">{t("Uses your local Claude Code login. Personal use only — distributed builds must use an API key.")}</p>
        </label>
      )}

      {ai.provider === "local" && (
        <>
          <label className="wz-field">
            <span>{t("Local API")}</span>
            <select className="input" value={ai.localApi} onChange={(e) => update({ ai: { localApi: e.target.value === "openai" ? "openai" : "ollama" } })}>
              <option value="ollama">{t("Ollama")}</option>
              <option value="openai">{t("OpenAI-compatible")}</option>
            </select>
          </label>
          <label className="wz-field">
            <span>{t("Base URL")}</span>
            <input
              className="input"
              defaultValue={ai.localBaseUrl}
              placeholder={t("http://localhost:11434")}
              onBlur={(e) => update({ ai: { localBaseUrl: e.target.value.trim() } })}
            />
          </label>
        </>
      )}

      <label className="wz-field">
        <span>{t("Model")}</span>
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
  const [ownServer, setOwnServer] = useState(false);
  const [serverUrl, setServerUrl] = useState("");
  const [deviceName, setDeviceName] = useState("");
  const [generated, setGenerated] = useState<string | null>(null);
  const [savedPhrase, setSavedPhrase] = useState(false);
  const [joinPhrase, setJoinPhrase] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (status) {
      setServerUrl((v) => v || (isLoopbackUrl(status.customServerUrl) ? "" : status.customServerUrl));
      setDeviceName((v) => v || status.deviceName);
    }
  }, [status]);

  if (!status) return <div className="wz-step">{t("Loading…")}</div>;
  if (!status.available) {
    return (
      <div className="wz-step">
        <div className="wz-notice warn">{t("Sync is not available in this build. You can skip this step.")}</div>
      </div>
    );
  }
  if (status.enabled) {
    return (
      <div className="wz-step">
        <div className="wz-notice ok">{t("Sync is on for this profile. Device “{deviceName}”.", { deviceName: status.deviceName })}</div>
        <p className="wz-hint">{t("Manage it any time in Settings → Sync.")}</p>
      </div>
    );
  }

  const enable = (phrase: string): void => {
    setBusy(true);
    setError(null);
    api
      .call("sync.enable", ownServer ? { mode: "custom", serverUrl, phrase, deviceName } : { mode: "local", phrase, deviceName })
      .then(onStatus)
      .catch((e: unknown) => setError(errorMessage(e)))
      .finally(() => setBusy(false));
  };

  return (
    <div className="wz-step">
      <p className="wz-lead">
        {t("Sync your bookmarks, history, tabs and more with your phone and other computers. Nothing to set up: this computer keeps the synced data, end-to-end encrypted, and your devices sync with it on the same Wi-Fi. A 24-word recovery phrase is the key. Skip this and set it up later if you prefer.")}
      </p>
      {ownServer ? (
        <label className="wz-field">
          <span>{t("Your own sync server")}</span>
          <input className="input" value={serverUrl} onChange={(e) => setServerUrl(e.target.value)} placeholder="https://sync.example.org" />
        </label>
      ) : (
        status.platform === "win32" && <div className="wz-notice">{t("Windows will ask to let Corvus reach your network: allow Private networks so your phone can sync.")}</div>
      )}
      <button className="btn small ghost" onClick={() => setOwnServer((v) => !v)}>
        {ownServer ? t("Use this computer instead (recommended)") : t("I run my own sync server")}
      </button>
      <label className="wz-field">
        <span>{t("Device name")}</span>
        <input className="input" value={deviceName} onChange={(e) => setDeviceName(e.target.value)} />
      </label>

      <div className="wz-two">
        <div className="wz-card">
          <h3>{t("Start a new chain")}</h3>
          <p className="wz-hint">{t("Creates a fresh 24-word phrase. Anyone with it can read your synced data.")}</p>
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
          >{t("Generate phrase")}</button>
          {generated && (
            <>
              <PhraseGrid phrase={generated} />
              <label className="wz-check">
                <input type="checkbox" checked={savedPhrase} onChange={(e) => setSavedPhrase(e.target.checked)} />{" "}{t("I wrote this phrase down somewhere safe")}</label>
              <button className="btn small primary" disabled={!savedPhrase || busy} onClick={() => enable(generated)}>{t("Turn on sync")}</button>
            </>
          )}
        </div>

        <div className="wz-card">
          <h3>{t("Join an existing chain")}</h3>
          <p className="wz-hint">{t("Paste the pairing code from your other computer (Settings, Sync, Pair a device), or type the recovery phrase. This profile takes the synced data.")}</p>
          <textarea
            className="input"
            rows={3}
            value={joinPhrase}
            onChange={(e) => setJoinPhrase(e.target.value)}
            placeholder={t("Pairing code, or 24 words separated by spaces")}
            spellCheck={false}
          />
          <button className="btn small primary" disabled={!joinPhrase.trim() || busy} onClick={() => enable(joinPhrase)}>
            {busy ? t("Joining…") : t("Join and sync")}
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
      <p className="wz-lead">{t("Bring your bookmarks and history over from another browser on this computer. Its files are only read, never changed; if it is open, close it first.")}</p>
      <BrowserImportPanel />
      <p className="wz-hint">{t("Using a browser from another computer? Export its bookmarks to HTML there (Chrome, Edge, Firefox, Safari and Brave all can) and pick the file here.")}</p>
      <button className="btn small" disabled={busy} onClick={run}>
        {busy ? t("Importing…") : t("Choose a bookmarks file…")}
      </button>
      {result && !result.canceled && (
        <div className={`wz-notice ${result.imported > 0 ? "ok" : "warn"}`}>
          {result.imported > 0
            ? result.folders > 0 ? t("Imported {imported} bookmark(s) in {folders} folder(s) from {source}.", { imported: result.imported, folders: result.folders, source: result.source ?? "" }) : t("Imported {imported} bookmark(s) from {source}.", { imported: result.imported, source: result.source ?? "" })
            : t("No bookmarks found in {source}.", { source: result.source ?? "" })}
        </div>
      )}
      {error && <div className="wz-notice error">{error}</div>}
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
      <p className="wz-lead">{t("A few defaults to finish. All of these live in Settings afterwards.")}</p>
      <label className="wz-field">
        <span>{t("Default search")}</span>
        <select className="input" value={ai.retriever} onChange={(e) => update({ ai: { retriever: e.target.value as typeof ai.retriever } })}>
          <option value="searxng">{t("SearXNG (self-hosted)")}</option>
          <option value="brave">{t("Brave Search API")}</option>
          <option value="duckduckgo">{t("DuckDuckGo")}</option>
        </select>
      </label>
      <label className="wz-field">
        <span>{t("Theme")}</span>
        <select className="input" value={view.settings.appearance.theme} onChange={(e) => update({ appearance: { theme: e.target.value as ThemeSource } })}>
          <option value="system">{t("Match system")}</option>
          <option value="light">{t("Light")}</option>
          <option value="dark">{t("Dark")}</option>
        </select>
      </label>
      <label className="wz-toggle">
        <input
          type="checkbox"
          checked={adblock?.enabled ?? true}
          disabled={!adblock}
          onChange={(e) => void api.call("adblock.setEnabled", e.target.checked).then(setAdblock)}
        />
        <span>{t("Block ads and trackers")}</span>
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
          <span>{t("Corvus")}</span>
        </div>
        <ol className="wz-steps">
          {STEP_TITLES.map((title, i) => (
            <li key={title} className={i === step ? "active" : i < step ? "done" : ""}>
              <i>{i + 1}</i>
              <span>{title}</span>
            </li>
          ))}
        </ol>
        <button className="wz-skip" onClick={finish} disabled={finishing}>{t("Skip setup")}</button>
      </aside>

      <main className="wz-main">
        <header className="wz-head">
          <h1>{step === 0 ? t("Welcome to Corvus") : STEP_TITLES[step]}</h1>
          <p className="wz-sub">{t("Step")}{" "}{step + 1}{" "}{t("of")}{" "}{STEP_TITLES.length}</p>
        </header>

        <div className="wz-content">
          {!view ? (
            <div className="wz-step">{t("Loading…")}</div>
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
          <button className="btn ghost" disabled={step === 0 || finishing} onClick={() => setStep((s) => Math.max(0, s - 1))}>{t("Back")}</button>
          {step < last ? (
            <div className="wz-foot-right">
              <button className="btn ghost" onClick={() => setStep((s) => Math.min(last, s + 1))}>{t("Skip")}</button>
              <button className="btn primary" onClick={() => setStep((s) => Math.min(last, s + 1))}>{t("Next")}</button>
            </div>
          ) : (
            <button className="btn primary" disabled={finishing} onClick={finish}>
              {finishing ? t("Finishing…") : t("Finish")}
            </button>
          )}
        </footer>
      </main>
    </div>
  );
}

mount(<WelcomePage />);
