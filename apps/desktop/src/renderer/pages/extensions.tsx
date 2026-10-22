import { useCallback, useEffect, useState } from "react";
import type { ExtensionInfo } from "../../shared/ipc";
import { errorMessage, internalApi } from "../common/api";
import { IconPuzzle } from "../common/icons";
import { Toggle, formatTime } from "../common/ui";
import { PageShell, mount } from "./shell";

function ExtensionCard({ ext, run }: { ext: ExtensionInfo; run: (p: Promise<unknown>) => void }) {
  const api = internalApi();
  const [open, setOpen] = useState(false);
  return (
    <div className={`ext-card ${ext.enabled ? "" : "disabled"}`} id={`ext-${ext.id}`} data-extension-id={ext.id}>
      <div className="ext-head">
        <div className="ext-icon">{ext.iconUrl ? <img src={ext.iconUrl} alt="" /> : <IconPuzzle size={22} />}</div>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="ext-name">{ext.name}</div>
          <div className="muted small">
            Version {ext.version} · MV{ext.manifestVersion}
          </div>
        </div>
        <Toggle label={`Enable ${ext.name}`} checked={ext.enabled} onChange={(v) => run(api.call("extensions.setEnabled", ext.id, v))} />
      </div>
      <div className="ext-desc">{ext.description || "No description."}</div>
      {ext.errors.length > 0 && (
        <div className="notice error ext-errors">
          {ext.errors.length} error{ext.errors.length === 1 ? "" : "s"}: {ext.errors[ext.errors.length - 1]?.message}
        </div>
      )}
      {open && (
        <div className="ext-details">
          <div className="mono muted small">ID {ext.id}</div>
          <div className="mono muted small ext-path" title={ext.path}>
            {ext.path}
          </div>
          <h4>Permissions</h4>
          {ext.warnings.length === 0 ? (
            <div className="muted small">No special permissions.</div>
          ) : (
            <ul className="ext-list">
              {ext.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          )}
          {(ext.permissions.length > 0 || ext.hostPermissions.length > 0) && (
            <div className="mono muted small ext-perm-raw">{[...ext.permissions, ...ext.hostPermissions].join(", ")}</div>
          )}
          {ext.unsupported.length > 0 && (
            <div className="notice warn small">
              Not available in Corvus yet: {ext.unsupported.map((p) => `chrome.${p}`).join(", ")}. Features that rely on them may not work.
            </div>
          )}
          {ext.errors.length > 0 && (
            <>
              <h4>Errors</h4>
              <ul className="ext-list ext-error-list">
                {ext.errors
                  .slice()
                  .reverse()
                  .map((e, i) => (
                    <li key={`${e.at}-${i}`}>
                      <span className="muted small">
                        {formatTime(e.at)} · {e.source}
                      </span>
                      <div className="mono small">{e.message}</div>
                    </li>
                  ))}
              </ul>
              <button className="btn small ghost" onClick={() => run(api.call("extensions.clearErrors", ext.id))}>
                Clear errors
              </button>
            </>
          )}
        </div>
      )}
      <div className="ext-foot">
        <span className="pill">{ext.source === "webstore" ? "Chrome Web Store" : "Unpacked"}</span>
        <span style={{ flex: 1 }} />
        <button className="btn small ghost" onClick={() => setOpen(!open)}>
          {open ? "Hide details" : "Details"}
        </button>
        {ext.optionsUrl && (
          <button className="btn small ghost" disabled={!ext.enabled} onClick={() => run(api.call("extensions.openOptions", ext.id))}>
            Options
          </button>
        )}
        {ext.hasAction && ext.enabled && (
          <button className="btn small ghost" onClick={() => run(api.call("extensions.setPinned", ext.id, !ext.pinned))}>
            {ext.pinned ? "Unpin" : "Pin"}
          </button>
        )}
        <button
          className="btn small ghost danger"
          onClick={() => {
            if (confirm(`Remove “${ext.name}” from this profile?`)) run(api.call("extensions.remove", ext.id));
          }}
        >
          Remove
        </button>
      </div>
    </div>
  );
}

function ExtensionsPage() {
  const api = internalApi();
  const [list, setList] = useState<ExtensionInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [storeInput, setStoreInput] = useState("");
  const [busy, setBusy] = useState(false);
  const reload = useCallback(() => void api.call("extensions.list").then(setList), [api]);

  useEffect(() => {
    reload();
    return api.onEvent((event) => {
      if (event.type === "extensions-changed") reload();
    });
  }, [api, reload]);

  const run = (p: Promise<unknown>, done?: string): void => {
    setError(null);
    setStatus(null);
    setBusy(true);
    p.then(() => done && setStatus(done))
      .catch((e: unknown) => setError(errorMessage(e)))
      .finally(() => {
        setBusy(false);
        reload();
      });
  };

  const install = (): void => {
    if (!storeInput.trim()) return;
    run(
      api.call("extensions.installFromStore", storeInput).then((ext) => {
        if (ext) setStoreInput("");
        return ext;
      }),
    );
  };

  return (
    <PageShell
      title="Extensions"
      active="extensions"
      toolbar={
        <>
          <button className="btn small" disabled={busy} onClick={() => run(api.call("extensions.loadUnpacked"))}>
            Load unpacked
          </button>
          <button
            className="btn small"
            disabled={busy}
            onClick={() =>
              run(
                api.call("extensions.checkUpdates").then((r) => {
                  setStatus(r.updated.length > 0 ? `Updated ${r.updated.length} extension(s).` : `Checked ${r.checked} extension(s), all up to date.`);
                }),
              )
            }
          >
            Update
          </button>
          <a className="btn small primary" href="https://chromewebstore.google.com/" target="_blank" rel="noreferrer" style={{ textDecoration: "none" }}>
            Open Chrome Web Store
          </a>
        </>
      }
    >
      <div className="notice">
        Extensions are installed per profile. Use “Add to Corvus” on the Chrome Web Store, paste a store link or extension ID below, or
        load an unpacked folder that contains a <code>manifest.json</code>. Some Chrome APIs are not available yet; each card lists the
        ones an extension asks for but cannot use.
      </div>
      <form
        className="ext-install"
        onSubmit={(e) => {
          e.preventDefault();
          install();
        }}
      >
        <input
          className="input"
          placeholder="Chrome Web Store link or extension ID"
          value={storeInput}
          onChange={(e) => setStoreInput(e.target.value)}
          spellCheck={false}
        />
        <button className="btn small primary" type="submit" disabled={busy || !storeInput.trim()}>
          {busy ? "Working…" : "Install"}
        </button>
      </form>
      {error && <div className="notice error">{error}</div>}
      {status && <div className="notice">{status}</div>}
      {list && list.length === 0 && (
        <div className="card">
          <div className="empty">No extensions installed in this profile.</div>
        </div>
      )}
      <div className="ext-grid">
        {list?.map((ext) => (
          <ExtensionCard key={ext.id} ext={ext} run={(p) => run(p)} />
        ))}
      </div>
    </PageShell>
  );
}

mount(<ExtensionsPage />);
