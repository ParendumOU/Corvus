import { isLoopbackUrl, type PhoneServerAddress } from "@corvus/shared";
import { useState } from "react";
import type { NetworkHelp, ServerCheck, SyncMode, SyncStatus } from "../../shared/ipc";
import { errorMessage, internalApi } from "../common/api";
import { t } from "../common/i18n";
import { Row } from "./shell";

/** Where self-hosting the sync server is explained (Docker, VPS, NAS). */
export const SELF_HOST_GUIDE = "https://github.com/ParendumOU/Corvus/blob/main/services/sync-server/README.md";

function when(ms: number): string {
  return new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export function addressLabel(a: PhoneServerAddress): string {
  return a.kind === "tailscale" ? t("{address} (Tailscale)", { address: a.address }) : `${a.address} (${a.adapter})`;
}

/** Said right before Corvus first listens on the network, where Windows asks about it. */
export function WindowsPromptNote({ platform }: { platform: string }) {
  if (platform !== "win32") return null;
  return <div className="notice">{t("Windows will ask to let Corvus reach your network: allow Private networks so your phone can sync.")}</div>;
}

/** An own server's address with "Check". */
function ServerAddress({ value, onChange }: { value: string; onChange: (url: string) => void }) {
  const api = internalApi();
  const [check, setCheck] = useState<ServerCheck | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <>
      <div className="field-row">
        <input
          className="input"
          value={value}
          onChange={(e) => {
            onChange(e.target.value);
            setCheck(null);
          }}
          placeholder="https://sync.example.org"
          spellCheck={false}
        />
        <button
          className="btn small"
          disabled={busy || !value.trim()}
          onClick={() => {
            setBusy(true);
            api
              .call("sync.checkServer", value)
              .then(setCheck)
              .catch((e: unknown) => setCheck({ ok: false, serverUrl: null, message: errorMessage(e) }))
              .finally(() => setBusy(false));
          }}
        >
          {busy ? t("Checking…") : t("Check")}
        </button>
      </div>
      {check && <div className={`notice ${check.ok ? "" : "warn"}`}>{check.message}</div>}
    </>
  );
}

/** Setup: sync through this computer (default) or the person's own server. */
export function ServerChoice({
  status,
  mode,
  onMode,
  serverUrl,
  onServerUrl,
}: {
  status: SyncStatus;
  mode: SyncMode;
  onMode: (m: SyncMode) => void;
  serverUrl: string;
  onServerUrl: (url: string) => void;
}) {
  return (
    <>
      <Row label={t("Where your data syncs")} hint={t("Always end-to-end encrypted: the server only stores data it cannot read.")} />
      <div className="stack sync-choice" role="radiogroup" aria-label={t("Where your data syncs")}>
        <label className="radio-option">
          <input type="radio" name="sync-mode" checked={mode === "local"} onChange={() => onMode("local")} />
          <span className="radio-text">
            <strong>{t("This computer (recommended)")}</strong>
            <span className="muted small">{t("Nothing to set up. Your phone and other computers sync with this computer when they are on the same Wi-Fi (or Tailscale) and Corvus is open here.")}</span>
          </span>
        </label>
        <label className="radio-option">
          <input type="radio" name="sync-mode" checked={mode === "custom"} onChange={() => onMode("custom")} />
          <span className="radio-text">
            <strong>{t("Your own server")}</strong>
            <span className="muted small">
              {t("A Corvus sync server you run (Docker on a VPS, a NAS or another computer), so devices sync from anywhere.")}{" "}
              <a href={SELF_HOST_GUIDE} target="_blank" rel="noreferrer">
                {t("How to set one up")}
              </a>
            </span>
          </span>
        </label>
        {mode === "custom" && <ServerAddress value={serverUrl} onChange={onServerUrl} />}
        {mode === "local" && <WindowsPromptNote platform={status.platform} />}
      </div>
    </>
  );
}

/** Sync on: where the chain lives, what reaches it, and moving it to the other kind of server. */
export function WhereItSyncs({ status, onStatus }: { status: SyncStatus; onStatus: (s: SyncStatus) => void }) {
  const api = internalApi();
  const [target, setTarget] = useState(isLoopbackUrl(status.customServerUrl) ? "" : status.customServerUrl);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const local = status.localServer;
  const move = (to: { mode: "local" } | { mode: "custom"; serverUrl: string }): void => {
    const question =
      to.mode === "local"
        ? t("Move your sync chain to this computer? Corvus uploads this computer's data to it (encrypted) and tells your other devices to follow.")
        : t("Move your sync chain to {url}? Corvus uploads this computer's data there (encrypted) and tells your other devices to follow.", { url: to.serverUrl });
    if (!confirm(question)) return;
    setBusy(true);
    setError(null);
    api
      .call("sync.moveChain", to)
      .then(onStatus)
      .catch((e: unknown) => setError(errorMessage(e)))
      .finally(() => setBusy(false));
  };

  return (
    <>
      <Row
        label={t("Where your data syncs")}
        hint={status.mode === "local" ? t("The sync server built into Corvus, on this computer. Other devices sync while Corvus is open here.") : t("Your own sync server.")}
      >
        <span className="pill ok">{status.mode === "local" ? t("This computer") : t("Your own server")}</span>
      </Row>
      {status.mode === "custom" && (
        <Row label={t("Server")}>
          <code className="mono">{status.serverUrl}</code>
        </Row>
      )}
      {status.mode === "local" && local && (
        <div className="stack sync-local">
          {local.error && <div className="notice error">{t("The sync server on this computer is not running: {error}", { error: local.error })}</div>}
          {local.running && local.addresses.length > 0 && (
            <div className="small">
              {t("Your other devices reach it at:")}
              <ul className="address-list sync-addresses">
                {local.addresses.map((a) => (
                  <li key={a.url}>
                    <code className="mono">{new URL(a.url).host}</code>
                    <span className="muted">{a.kind === "tailscale" ? "Tailscale" : a.adapter}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {local.running && local.addresses.length === 0 && <div className="notice warn">{t("This computer is not connected to a network, so your other devices cannot reach it now.")}</div>}
          {local.lastClient && <span className="muted small">{t("Last reached by another device ({address}) {when}.", { address: local.lastClient.address, when: when(local.lastClient.at) })}</span>}
        </div>
      )}
      {status.mode === "custom" && local?.retiringUntil && (
        <div className="notice">{t("This computer keeps answering devices that have not moved yet until {when}.", { when: when(local.retiringUntil) })}</div>
      )}
      {status.notice && <div className="notice">{status.notice}</div>}
      {status.mode === "local" ? (
        <>
          <Row label={t("Move to your own server")} hint={t("To sync from anywhere. Your devices follow; the data stays end-to-end encrypted.")} />
          <div className="stack">
            <ServerAddress value={target} onChange={setTarget} />
            <div className="inline">
              <button className="btn small" disabled={busy || !target.trim()} onClick={() => move({ mode: "custom", serverUrl: target })}>
                {busy ? t("Moving…") : t("Move to this server")}
              </button>
            </div>
          </div>
        </>
      ) : (
        <Row label={t("Move to this computer")} hint={t("No server to run: this computer keeps your synced data. Your devices follow.")}>
          <button className="btn small" disabled={busy} onClick={() => move({ mode: "local" })}>
            {busy ? t("Moving…") : t("Move to this computer")}
          </button>
        </Row>
      )}
      {status.mode === "custom" && <WindowsPromptNote platform={status.platform} />}
      {error && <div className="notice error">{error}</div>}
    </>
  );
}

/**
 * Under the pairing code: what to do when the phone cannot reach this computer. Checks what Corvus
 * can see without admin rights (Windows: a Public network, a firewall rule blocking Corvus) and
 * opens the system page to fix it; otherwise exact steps.
 */
export function NetworkHelpPanel({ status, port, shownAt }: { status: SyncStatus; port: string; shownAt: number }) {
  const api = internalApi();
  const [help, setHelp] = useState<NetworkHelp | null>(null);
  const [open, setOpen] = useState(false);
  const reached = status.localServer?.lastClient && status.localServer.lastClient.at >= shownAt;
  const open_ = (which: "network" | "firewall"): void => {
    void api.call("sync.openNetworkSettings", which);
  };
  if (reached) return <div className="notice ok">{t("Your phone reached this computer.")}</div>;
  return (
    <div className="stack">
      {!open ? (
        <button
          className="btn small ghost"
          onClick={() => {
            setOpen(true);
            void api.call("sync.networkHelp").then(setHelp);
          }}
        >
          {t("Phone cannot connect?")}
        </button>
      ) : (
        <div className="notice pair-network">
          {help?.publicNetwork && (
            <p>
              <strong>{t("Windows treats this network as Public and keeps your phone out.")}</strong>{" "}
              {t("Make it Private: Settings, Network & internet, Wi-Fi (or Ethernet), your network, Private network.")}{" "}
              <button className="btn small" onClick={() => open_("network")}>
                {t("Open network settings")}
              </button>
            </p>
          )}
          {help?.firewallBlocks && (
            <p>
              <strong>{t("Windows Firewall blocks Corvus (Cancel was chosen when Windows asked).")}</strong>{" "}
              {t("Allow it: Allow an app through firewall, Change settings, tick Corvus under Private.")}{" "}
              <button className="btn small" onClick={() => open_("firewall")}>
                {t("Open firewall settings")}
              </button>
            </p>
          )}
          <ul>
            <li>{t("Phone and computer on the same Wi-Fi. A guest Wi-Fi often keeps devices apart: use your main one.")}</li>
            <li>{t("This computer awake, with Corvus open.")}</li>
            {status.platform === "darwin" && <li>{t("If the macOS firewall is on: System Settings, Network, Firewall, Options: allow Corvus.")}</li>}
            {status.platform === "linux" && <li>{t("If a firewall is on (for example ufw), allow TCP port {port}.", { port })}</li>}
            {status.platform === "win32" && help && !help.publicNetwork && !help.firewallBlocks && <li>{t("Windows lets Corvus through on this network. Another security program may block port {port}.", { port })}</li>}
            <li>{t("Some routers keep devices apart (AP or client isolation): turn it off in the router, or use Tailscale.")}</li>
          </ul>
        </div>
      )}
    </div>
  );
}
