import { useCallback, useEffect, useState, type ReactNode } from "react";
import type { ExtensionSuggestion } from "../../shared/extension-suggestions";
import { SYNC_INTERVALS_MINUTES, type SyncDeviceView, type SyncStatus } from "../../shared/ipc";
import { errorMessage, internalApi } from "../common/api";
import { IconCopy } from "../common/icons";
import { Toggle } from "../common/ui";
import { Row, Section } from "./shell";

const WIPE_WORD = "DELETE";

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

function PhraseGrid({ phrase }: { phrase: string }) {
  return (
    <div className="phrase-grid">
      {phrase.split(" ").map((w, i) => (
        <span key={i}>
          <i>{i + 1}</i>
          {w}
        </span>
      ))}
    </div>
  );
}

function when(ms: number): string {
  return new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function SetupForm({ status, onStatus }: { status: SyncStatus; onStatus: (s: SyncStatus) => void }) {
  const api = internalApi();
  const [phrase, setPhrase] = useState("");
  const [generated, setGenerated] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [serverUrl, setServerUrl] = useState(status.serverUrl);
  const [deviceName, setDeviceName] = useState(status.deviceName);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const enable = (p: string): void => {
    setBusy(true);
    setError(null);
    api
      .call("sync.enable", { serverUrl, phrase: p, deviceName })
      .then(onStatus)
      .catch((e: unknown) => setError(errorMessage(e)))
      .finally(() => setBusy(false));
  };

  return (
    <>
      <Row label="Sync server" hint="Self-host it with `docker compose up -d sync-server`.">
        <input className="input" value={serverUrl} onChange={(e) => setServerUrl(e.target.value)} placeholder="http://localhost:8797" />
      </Row>
      <Row label="Device name" hint="Shown to your other devices.">
        <input className="input" value={deviceName} onChange={(e) => setDeviceName(e.target.value)} />
      </Row>
      <Row label="Start a new sync chain" hint="Creates a 24-word recovery phrase. Anyone with it can read your synced data.">
        <button
          className="btn small"
          onClick={() => {
            setError(null);
            api
              .call("sync.generatePhrase")
              .then((p) => {
                setGenerated(p);
                setSaved(false);
              })
              .catch((e: unknown) => setError(errorMessage(e)));
          }}
        >
          Generate phrase
        </button>
      </Row>
      {generated && (
        <>
          <PhraseGrid phrase={generated} />
          <div className="stack">
            <label className="inline">
              <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} /> I wrote this phrase down somewhere safe
            </label>
            <div className="inline">
              <CopyButton text={generated} label="Copy phrase" />
              <button className="btn small primary" disabled={!saved || busy} onClick={() => enable(generated)}>
                Turn on sync
              </button>
            </div>
          </div>
        </>
      )}
      <Row label="Join an existing chain" hint="Enter the recovery phrase from another device. This profile takes the name and data of the synced profile.">
        <span />
      </Row>
      <div className="stack">
        <textarea className="input" rows={3} value={phrase} onChange={(e) => setPhrase(e.target.value)} placeholder="24 words separated by spaces" spellCheck={false} />
        <div className="inline">
          <button className="btn small primary" disabled={!phrase.trim() || busy} onClick={() => enable(phrase)}>
            {busy ? "Joining…" : "Join and sync"}
          </button>
        </div>
      </div>
      {error && <div className="notice error">{error}</div>}
    </>
  );
}

function DevicesList({ status }: { status: SyncStatus }) {
  const api = internalApi();
  const [devices, setDevices] = useState<SyncDeviceView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(() => {
    api
      .call("sync.devices")
      .then((d) => {
        setDevices(d);
        setError(null);
      })
      .catch((e: unknown) => setError(errorMessage(e)));
  }, [api]);
  useEffect(reload, [reload, status.lastSyncAt]);

  return (
    <>
      <Row label="Devices" hint="Every device signed in to this sync chain.">
        <button className="btn small ghost" onClick={reload}>
          Refresh
        </button>
      </Row>
      {error && <div className="notice warn">{error}</div>}
      {devices && (
        <div className="list sync-devices">
          {devices.map((d) => (
            <div key={d.id} className="list-row">
              <div className="grow">
                <div className="title">
                  {d.name} {d.current && <span className="pill ok">This device</span>}
                </div>
                <div className="sub">
                  {d.platform} · last seen {when(d.lastSeen)}
                </div>
              </div>
              {!d.current && (
                <button
                  className="btn small ghost danger"
                  onClick={() => {
                    if (!confirm(`Remove “${d.name}” from this sync chain? It stops syncing and its open tabs disappear from your other devices.`)) return;
                    api
                      .call("sync.removeDevice", d.id)
                      .then(setDevices)
                      .catch((e: unknown) => setError(errorMessage(e)));
                  }}
                >
                  Remove
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </>
  );
}

function ExtensionSuggestions({ status }: { status: SyncStatus }) {
  const api = internalApi();
  const [list, setList] = useState<ExtensionSuggestion[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void api.call("sync.extensionSuggestions").then(setList);
  }, [api, status.lastSyncAt]);

  if (list.length === 0) return null;
  const run = (id: string, p: Promise<ExtensionSuggestion[]>): void => {
    setBusy(id);
    setError(null);
    p.then(setList)
      .catch((e: unknown) => setError(errorMessage(e)))
      .finally(() => setBusy(null));
  };
  return (
    <>
      <Row label="Extensions from your other devices" hint="Installed elsewhere but not here. Nothing is installed without your click.">
        <span />
      </Row>
      <div className="list">
        {list.map((ext) => (
          <div key={ext.id} className="list-row">
            <div className="grow">
              <div className="title">{ext.name}</div>
              <div className="sub">On {ext.devices.join(", ")}</div>
            </div>
            <button className="btn small primary" disabled={busy !== null} onClick={() => run(ext.id, api.call("sync.installExtension", ext.id))}>
              {busy === ext.id ? "Installing…" : "Install"}
            </button>
            <button className="btn small ghost" disabled={busy !== null} onClick={() => run(ext.id, api.call("sync.dismissExtension", ext.id))}>
              Dismiss
            </button>
          </div>
        ))}
      </div>
      {error && <div className="notice error">{error}</div>}
    </>
  );
}

function RecoveryPhrase() {
  const api = internalApi();
  const [phrase, setPhrase] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      <Row label="Recovery phrase" hint="Needed to add a device. Anyone who sees it can read all your synced data.">
        {phrase ? (
          <>
            <CopyButton text={phrase} label="Copy phrase" />
            <button className="btn small ghost" onClick={() => setPhrase(null)}>
              Hide
            </button>
          </>
        ) : (
          <button
            className="btn small"
            onClick={() => {
              if (!confirm("Show the recovery phrase? Make sure nobody can see your screen.")) return;
              api
                .call("sync.revealPhrase")
                .then(setPhrase)
                .catch((e: unknown) => setError(errorMessage(e)));
            }}
          >
            Show recovery phrase
          </button>
        )}
      </Row>
      {phrase && <PhraseGrid phrase={phrase} />}
      {error && <div className="notice error">{error}</div>}
    </>
  );
}

function DangerZone({ onStatus }: { onStatus: (s: SyncStatus) => void }) {
  const api = internalApi();
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      <Row
        label={<span className="error-text">Delete sync chain</span>}
        hint="Deletes all synced data from the server and signs out every device. Local data on each device is kept."
      >
        <button className="btn small ghost danger" onClick={() => setOpen((o) => !o)}>
          {open ? "Cancel" : "Delete…"}
        </button>
      </Row>
      {open && (
        <div className="stack sync-wipe">
          <label className="small">
            Type <strong>{WIPE_WORD}</strong> to confirm.
          </label>
          <div className="inline">
            <input className="input" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={WIPE_WORD} spellCheck={false} />
            <button
              className="btn small danger"
              disabled={typed.trim() !== WIPE_WORD || busy}
              onClick={() => {
                setBusy(true);
                setError(null);
                api
                  .call("sync.wipe", typed)
                  .then(onStatus)
                  .catch((e: unknown) => setError(errorMessage(e)))
                  .finally(() => setBusy(false));
              }}
            >
              {busy ? "Deleting…" : "Delete chain and all synced data"}
            </button>
          </div>
          {error && <div className="notice error">{error}</div>}
        </div>
      )}
    </>
  );
}

function SyncOn({ status, onStatus }: { status: SyncStatus; onStatus: (s: SyncStatus) => void }) {
  const api = internalApi();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const act = (p: Promise<SyncStatus>): void => {
    setBusy(true);
    setError(null);
    p.then(onStatus)
      .catch((e: unknown) => setError(errorMessage(e)))
      .finally(() => setBusy(false));
  };
  const syncing = busy || status.syncing;

  return (
    <>
      <Row label="Status" hint={status.lastSyncAt ? `Last synced ${when(status.lastSyncAt)}` : "Not synced yet"}>
        <span className={`pill ${status.error ? "bad" : "ok"}`}>{syncing ? "Syncing…" : status.error ? "Error" : "On"}</span>
        <button className="btn small" disabled={syncing} onClick={() => act(api.call("sync.now"))}>
          Sync now
        </button>
        <button
          className="btn small ghost danger"
          disabled={busy}
          onClick={() => {
            if (confirm("Turn off sync on this device? This device leaves the chain. Synced data stays on the server and your other devices.")) {
              act(api.call("sync.disable"));
            }
          }}
        >
          Turn off
        </button>
      </Row>
      {status.error && <div className="notice error">{status.error}</div>}
      {error && <div className="notice error">{error}</div>}
      <Row label="Auto-sync" hint="Also syncs about 10 seconds after a change on this device.">
        <select
          className="input"
          value={status.intervalMinutes}
          onChange={(e) => act(api.call("sync.setOptions", { intervalMinutes: Number(e.target.value) }))}
        >
          {SYNC_INTERVALS_MINUTES.map((m) => (
            <option key={m} value={m}>
              Every {m} minute{m === 1 ? "" : "s"}
            </option>
          ))}
        </select>
      </Row>
      <Row
        label="What syncs"
        hint="Bookmarks, history, open tabs, the list of Web Store extensions, your reading list, watched pages and saved workspaces, this profile's name and color, appearance and AI search preferences. Never API keys, the MCP token or MCP settings."
      >
        <span />
      </Row>
      <Row label="Also sync the SearXNG URL" hint="Off by default because service URLs often point to this machine (localhost).">
        <Toggle label="Also sync the SearXNG URL" checked={status.syncServiceUrls} onChange={(v) => act(api.call("sync.setOptions", { syncServiceUrls: v }))} />
      </Row>
      <DevicesList status={status} />
      <Row label="Manage devices" hint="Rename this device or revoke another on a dedicated page.">
        <a className="btn small ghost" href="corvus://devices/">
          Open device manager
        </a>
      </Row>
      <ExtensionSuggestions status={status} />
      <RecoveryPhrase />
      <Row label="Sync chain">
        <code className="mono">{status.chainId}</code>
      </Row>
      <Row label="Server">
        <code className="mono">{status.serverUrl}</code>
      </Row>
      <DangerZone onStatus={onStatus} />
    </>
  );
}

export function SyncSection() {
  const api = internalApi();
  const [status, setStatus] = useState<SyncStatus | null>(null);

  useEffect(() => {
    let alive = true;
    const refresh = (): void => {
      void api.call("sync.status").then((s) => alive && setStatus(s));
    };
    refresh();
    const timer = setInterval(refresh, 5000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [api]);

  if (!status) return null;
  const body: ReactNode = !status.available ? (
    <div className="notice warn">{status.error ?? "Sync is not available in this build."}</div>
  ) : status.enabled ? (
    <SyncOn status={status} onStatus={setStatus} />
  ) : (
    <SetupForm status={status} onStatus={setStatus} />
  );

  return (
    <Section
      id="sync"
      title="Sync"
      description="End-to-end encrypted: the server only stores ciphertext. Each profile has its own sync chain."
    >
      {body}
    </Section>
  );
}
