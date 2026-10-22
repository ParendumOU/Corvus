import { useCallback, useEffect, useState } from "react";
import type { SyncDeviceView, SyncStatus } from "../../shared/ipc";
import { errorMessage, internalApi } from "../common/api";
import "./devices.css";
import { PageShell, mount } from "./shell";

function when(ms: number): string {
  if (!ms) return "never";
  return new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

const PLATFORMS: Record<string, string> = { darwin: "macOS", win32: "Windows", linux: "Linux" };

function platformLabel(platform: string): string {
  return PLATFORMS[platform] ?? platform;
}

function RenameThisDevice({ current, onRenamed }: { current: SyncDeviceView; onRenamed: (list: SyncDeviceView[]) => void }) {
  const api = internalApi();
  const [name, setName] = useState(current.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setName(current.name), [current.name]);

  const dirty = name.trim() !== "" && name.trim() !== current.name;
  const save = (): void => {
    setBusy(true);
    setError(null);
    api
      .call("sync.renameDevice", name.trim())
      .then(onRenamed)
      .catch((e: unknown) => setError(errorMessage(e)))
      .finally(() => setBusy(false));
  };

  return (
    <div className="device-rename">
      <label className="device-rename-label">Name of this device</label>
      <div className="device-rename-row">
        <input
          className="input"
          value={name}
          maxLength={64}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && dirty && !busy) save();
          }}
        />
        <button className="btn small primary" disabled={!dirty || busy} onClick={save}>
          {busy ? "Saving…" : "Rename"}
        </button>
      </div>
      {error && <div className="notice error">{error}</div>}
    </div>
  );
}

function DevicesPage() {
  const api = internalApi();
  const [status, setStatus] = useState<SyncStatus | null>(null);
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

  useEffect(() => {
    let alive = true;
    void api.call("sync.status").then((s) => {
      if (!alive) return;
      setStatus(s);
      if (s.enabled) reload();
    });
    return () => {
      alive = false;
    };
  }, [api, reload]);

  const revoke = (d: SyncDeviceView): void => {
    if (!confirm(`Revoke “${d.name}”? It can no longer sync until it is re-paired with your recovery phrase, and its open tabs disappear from your other devices.`)) return;
    api
      .call("sync.removeDevice", d.id)
      .then(setDevices)
      .catch((e: unknown) => setError(errorMessage(e)));
  };

  const current = devices?.find((d) => d.current);

  return (
    <PageShell title="Devices" active="devices" toolbar={status?.enabled ? <button className="btn small ghost" onClick={reload}>Refresh</button> : undefined}>
      <div className="devices-page">
        {!status?.available && <div className="notice warn">Sync is not available in this build.</div>}
        {status?.available && !status.enabled && (
          <div className="notice">
            Sync is off for this profile. Turn it on in <a href="corvus://settings#sync">Settings → Sync</a> to manage your devices.
          </div>
        )}
        {status?.enabled && (
          <>
            <p className="devices-intro">
              Every device signed in to this sync chain. Revoking a device blocks it from syncing until it is re-paired with the recovery phrase.
            </p>
            {current && <RenameThisDevice current={current} onRenamed={setDevices} />}
            {error && <div className="notice error">{error}</div>}
            {devices && (
              <div className="device-list">
                {devices.map((d) => (
                  <div key={d.id} className="device-row">
                    <div className="device-info">
                      <div className="device-name">
                        {d.name} {d.current && <span className="pill ok">This device</span>}
                      </div>
                      <div className="device-sub">
                        {platformLabel(d.platform)} · last seen {when(d.lastSeen)}
                      </div>
                    </div>
                    {!d.current && (
                      <button className="btn small ghost danger" onClick={() => revoke(d)}>
                        Revoke
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </PageShell>
  );
}

mount(<DevicesPage />);
