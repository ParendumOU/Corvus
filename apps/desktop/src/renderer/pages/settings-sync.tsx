import { useCallback, useEffect, useState, type ReactNode } from "react";
import type { ExtensionSuggestion } from "../../shared/extension-suggestions";
import { SYNC_INTERVALS_MINUTES, type SyncDeviceView, type SyncStatus } from "../../shared/ipc";
import type { ConflictCollection, SyncConflictView } from "../../shared/sync-conflicts";
import { errorMessage, internalApi } from "../common/api";
import { t } from "../common/i18n";
import { IconCopy } from "../common/icons";
import { Toggle } from "../common/ui";
import { Row, Section } from "./shell";

const WIPE_WORD = "DELETE";

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
      <Row label={t("Sync server")} hint={t("Self-host it with `docker compose up -d sync-server`.")}>
        <input className="input" value={serverUrl} onChange={(e) => setServerUrl(e.target.value)} placeholder="http://localhost:8797" />
      </Row>
      <Row label={t("Device name")} hint={t("Shown to your other devices.")}>
        <input className="input" value={deviceName} onChange={(e) => setDeviceName(e.target.value)} />
      </Row>
      <Row label={t("Start a new sync chain")} hint={t("Creates a 24-word recovery phrase. Anyone with it can read your synced data.")}>
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
          {t("Generate phrase")}
        </button>
      </Row>
      {generated && (
        <>
          <PhraseGrid phrase={generated} />
          <div className="stack">
            <label className="inline">
              <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} /> {t("I wrote this phrase down somewhere safe")}
            </label>
            <div className="inline">
              <CopyButton text={generated} label={t("Copy phrase")} />
              <button className="btn small primary" disabled={!saved || busy} onClick={() => enable(generated)}>
                {t("Turn on sync")}
              </button>
            </div>
          </div>
        </>
      )}
      <Row label={t("Join an existing chain")} hint={t("Enter the recovery phrase from another device. This profile takes the name and data of the synced profile.")}>
        <span />
      </Row>
      <div className="stack">
        <textarea className="input" rows={3} value={phrase} onChange={(e) => setPhrase(e.target.value)} placeholder={t("24 words separated by spaces")} spellCheck={false} />
        <div className="inline">
          <button className="btn small primary" disabled={!phrase.trim() || busy} onClick={() => enable(phrase)}>
            {busy ? t("Joining…") : t("Join and sync")}
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
      <Row label={t("Devices")} hint={t("Every device signed in to this sync chain.")}>
        <button className="btn small ghost" onClick={reload}>
          {t("Refresh")}
        </button>
      </Row>
      {error && <div className="notice warn">{error}</div>}
      {devices && (
        <div className="list sync-devices">
          {devices.map((d) => (
            <div key={d.id} className="list-row">
              <div className="grow">
                <div className="title">
                  {d.name} {d.current && <span className="pill ok">{t("This device")}</span>}
                </div>
                <div className="sub">
                  {d.platform} · {t("last seen {when}", { when: when(d.lastSeen) })}
                </div>
              </div>
              {!d.current && (
                <button
                  className="btn small ghost danger"
                  onClick={() => {
                    if (!confirm(t("Remove “{name}” from this sync chain? It stops syncing and its open tabs disappear from your other devices.", { name: d.name }))) return;
                    api
                      .call("sync.removeDevice", d.id)
                      .then(setDevices)
                      .catch((e: unknown) => setError(errorMessage(e)));
                  }}
                >
                  {t("Remove")}
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
      <Row label={t("Extensions from your other devices")} hint={t("Installed elsewhere but not here. Nothing is installed without your click.")}>
        <span />
      </Row>
      <div className="list">
        {list.map((ext) => (
          <div key={ext.id} className="list-row">
            <div className="grow">
              <div className="title">{ext.name}</div>
              <div className="sub">{t("On {devices}", { devices: ext.devices.join(", ") })}</div>
            </div>
            <button className="btn small primary" disabled={busy !== null} onClick={() => run(ext.id, api.call("sync.installExtension", ext.id))}>
              {busy === ext.id ? t("Installing…") : t("Install")}
            </button>
            <button className="btn small ghost" disabled={busy !== null} onClick={() => run(ext.id, api.call("sync.dismissExtension", ext.id))}>
              {t("Dismiss")}
            </button>
          </div>
        ))}
      </div>
      {error && <div className="notice error">{error}</div>}
    </>
  );
}

function conflictKind(collection: ConflictCollection): string {
  switch (collection) {
    case "bookmarks":
      return t("Bookmark");
    case "settings":
      return t("Setting");
    case "reading":
      return t("Reading list");
    case "watches":
      return t("Watched page");
    case "workspaces":
      return t("Workspace");
    case "annotations":
      return t("Annotation");
  }
}

/**
 * Changes made on this device that a newer change from another device replaced (that one is in
 * use everywhere). "Use this device's version" brings it back as a new change.
 */
function SyncConflicts({ status }: { status: SyncStatus }) {
  const api = internalApi();
  const [list, setList] = useState<SyncConflictView[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void api.call("sync.conflicts").then(setList);
  }, [api, status.lastSyncAt, status.conflicts]);

  if (list.length === 0) return null;
  const resolve = (id: string, keep: "mine" | "theirs"): void => {
    setBusy(id);
    setError(null);
    api
      .call("sync.resolveConflict", id, keep)
      .then(setList)
      .catch((e: unknown) => setError(errorMessage(e)))
      .finally(() => setBusy(null));
  };
  return (
    <>
      <Row
        label={t("Changes replaced by another device")}
        hint={t("You changed these here while another device changed them too. The other device's newer change is in use; you can bring yours back.")}
      >
        <span className="pill">{list.length}</span>
      </Row>
      <div className="list">
        {list.map((c) => (
          <div key={c.id} className="list-row">
            <div className="grow">
              <div className="title">
                {conflictKind(c.collection)}: {c.name}
              </div>
              <div className="sub">
                {t("This device")}: {c.local ?? t("Deleted")}
              </div>
              <div className="sub">
                {t("In use")}: {c.remote ?? t("Deleted")} · {when(c.at)}
              </div>
            </div>
            <button className="btn small primary" disabled={busy !== null} onClick={() => resolve(c.id, "mine")}>
              {t("Use this device's version")}
            </button>
            <button className="btn small ghost" disabled={busy !== null} onClick={() => resolve(c.id, "theirs")}>
              {t("Keep the one in use")}
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
      <Row label={t("Recovery phrase")} hint={t("Needed to add a device. Anyone who sees it can read all your synced data.")}>
        {phrase ? (
          <>
            <CopyButton text={phrase} label={t("Copy phrase")} />
            <button className="btn small ghost" onClick={() => setPhrase(null)}>
              {t("Hide")}
            </button>
          </>
        ) : (
          <button
            className="btn small"
            onClick={() => {
              if (!confirm(t("Show the recovery phrase? Make sure nobody can see your screen."))) return;
              api
                .call("sync.revealPhrase")
                .then(setPhrase)
                .catch((e: unknown) => setError(errorMessage(e)));
            }}
          >
            {t("Show recovery phrase")}
          </button>
        )}
      </Row>
      {phrase && <PhraseGrid phrase={phrase} />}
      {error && <div className="notice error">{error}</div>}
    </>
  );
}

/** How long the pairing QR code stays on screen. */
const PAIRING_VISIBLE_MS = 120_000;

/** "Pair a phone": a QR code the Corvus mobile app scans to join this sync chain. */
function PairPhone() {
  const api = internalApi();
  const [pairing, setPairing] = useState<{ code: string; qrSvg: string; serverUrl: string; reachableFromPhone: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!pairing) return;
    const timer = setTimeout(() => setPairing(null), PAIRING_VISIBLE_MS);
    return () => clearTimeout(timer);
  }, [pairing]);
  return (
    <>
      <Row label={t("Pair a phone")} hint={t("Shows a QR code for the Corvus app on your phone, which then syncs with this profile.")}>
        {pairing ? (
          <button className="btn small ghost" onClick={() => setPairing(null)}>
            {t("Hide")}
          </button>
        ) : (
          <button
            className="btn small"
            onClick={() => {
              if (!confirm(t("Show the pairing code? It holds your recovery phrase: make sure nobody else can see your screen."))) return;
              setError(null);
              api
                .call("sync.pairingCode")
                .then(setPairing)
                .catch((e: unknown) => setError(errorMessage(e)));
            }}
          >
            {t("Pair a phone…")}
          </button>
        )}
      </Row>
      {pairing && (
        <div className="pair-phone">
          <img className="pair-qr" alt={t("Pairing code")} src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(pairing.qrSvg)}`} />
          <div className="pair-steps">
            <strong>{t("In the Corvus app on your phone, open Settings and choose “Pair with a computer”, then scan this code.")}</strong>
            <span className="muted small">{t("Anyone who scans it can read your synced data. It hides itself after two minutes.")}</span>
            <span className="muted small">{t("Sync server: {url}", { url: pairing.serverUrl })}</span>
            {!pairing.reachableFromPhone && (
              <div className="notice warn">
                {t("Your phone probably cannot reach this sync server address. Use one it can reach (on your network or on the internet) in the sync server setting, then show the code again.")}
              </div>
            )}
          </div>
        </div>
      )}
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
        label={<span className="error-text">{t("Delete sync chain")}</span>}
        hint={t("Deletes all synced data from the server and signs out every device. Local data on each device is kept.")}
      >
        <button className="btn small ghost danger" onClick={() => setOpen((o) => !o)}>
          {open ? t("Cancel") : t("Delete…")}
        </button>
      </Row>
      {open && (
        <div className="stack sync-wipe">
          <label className="small">
            {t("Type")} <strong>{WIPE_WORD}</strong> {t("to confirm.")}
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
              {busy ? t("Deleting…") : t("Delete chain and all synced data")}
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
      <Row label={t("Status")} hint={status.lastSyncAt ? t("Last synced {when}", { when: when(status.lastSyncAt) }) : t("Not synced yet")}>
        <span className={`pill ${status.error ? "bad" : "ok"}`}>{syncing ? t("Syncing…") : status.error ? t("Error") : t("On")}</span>
        <button className="btn small" disabled={syncing} onClick={() => act(api.call("sync.now"))}>
          {t("Sync now")}
        </button>
        <button
          className="btn small ghost danger"
          disabled={busy}
          onClick={() => {
            if (confirm(t("Turn off sync on this device? This device leaves the chain. Synced data stays on the server and your other devices."))) {
              act(api.call("sync.disable"));
            }
          }}
        >
          {t("Turn off")}
        </button>
      </Row>
      {status.error && <div className="notice error">{status.error}</div>}
      {error && <div className="notice error">{error}</div>}
      <SyncConflicts status={status} />
      <Row label={t("Auto-sync")} hint={t("Also syncs about 10 seconds after a change on this device.")}>
        <select
          className="input"
          value={status.intervalMinutes}
          onChange={(e) => act(api.call("sync.setOptions", { intervalMinutes: Number(e.target.value) }))}
        >
          {SYNC_INTERVALS_MINUTES.map((m) => (
            <option key={m} value={m}>
              {m === 1 ? t("Every minute") : t("Every {m} minutes", { m })}
            </option>
          ))}
        </select>
      </Row>
      <Row
        label={t("What syncs")}
        hint={t("Bookmarks, history, open tabs, the list of Web Store extensions, your reading list, watched pages, saved workspaces and annotations, this profile's name and color, appearance and AI search preferences, plus the categories below. Never API keys, the MCP token or MCP settings.")}
      >
        <span />
      </Row>
      <Row
        label={t("Workflows")}
        hint={t("Saved workflows, recorded or saved from agent runs, with their run counts. Secrets are never part of a workflow. Off: this device keeps its workflows but stops syncing them.")}
      >
        <Toggle label={t("Sync workflows")} checked={status.syncWorkflows} onChange={(v) => act(api.call("sync.setOptions", { syncWorkflows: v }))} />
      </Row>
      <Row
        label={t("Site memory")}
        hint={t("What Corvus learned about sites from successful agent runs, and what you told it to forget. Never typed values, passwords or codes. Whether this device learns stays its own switch. Off: this device keeps what it learned but stops syncing it.")}
      >
        <Toggle label={t("Sync site memory")} checked={status.syncSiteMemory} onChange={(v) => act(api.call("sync.setOptions", { syncSiteMemory: v }))} />
      </Row>
      <Row
        label={t("Command Bar history")}
        hint={t("Tasks you gave the agent and searches and addresses you typed in the Command Bar, its “Recent” list. Off: this device keeps its list but stops syncing it.")}
      >
        <Toggle label={t("Sync Command Bar history")} checked={status.syncCommandHistory} onChange={(v) => act(api.call("sync.setOptions", { syncCommandHistory: v }))} />
      </Row>
      <Row label={t("Also sync the SearXNG URL")} hint={t("Off by default because service URLs often point to this machine (localhost).")}>
        <Toggle label={t("Also sync the SearXNG URL")} checked={status.syncServiceUrls} onChange={(v) => act(api.call("sync.setOptions", { syncServiceUrls: v }))} />
      </Row>
      <DevicesList status={status} />
      <Row label={t("Manage devices")} hint={t("Rename this device or revoke another on a dedicated page.")}>
        <a className="btn small ghost" href="corvus://devices/">
          {t("Open device manager")}
        </a>
      </Row>
      <ExtensionSuggestions status={status} />
      <RecoveryPhrase />
      <PairPhone />
      <Row label={t("Sync chain")}>
        <code className="mono">{status.chainId}</code>
      </Row>
      <Row label={t("Server")}>
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
    <div className="notice warn">{status.error ?? t("Sync is not available in this build.")}</div>
  ) : status.enabled ? (
    <SyncOn status={status} onStatus={setStatus} />
  ) : (
    <SetupForm status={status} onStatus={setStatus} />
  );

  return (
    <Section
      id="sync"
      title={t("Sync")}
      description={t("End-to-end encrypted: the server only stores ciphertext. Each profile has its own sync chain.")}
    >
      {body}
    </Section>
  );
}
