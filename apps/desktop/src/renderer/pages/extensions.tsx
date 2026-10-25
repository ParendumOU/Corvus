import { useCallback, useEffect, useState } from "react";
import type { ExtensionInfo } from "../../shared/ipc";
import { errorMessage, internalApi } from "../common/api";
import { IconPuzzle } from "../common/icons";
import { Toggle, formatTime } from "../common/ui";
import { PageShell, mount } from "./shell";

import { t } from "../common/i18n";
function ExtensionCard({ ext, run }: { ext: ExtensionInfo; run: (p: Promise<unknown>) => void }) {
  const api = internalApi();
  const [open, setOpen] = useState(false);
  return (
    <div className={`ext-card ${ext.enabled ? "" : "disabled"}`} id={`ext-${ext.id}`} data-extension-id={ext.id}>
      <div className="ext-head">
        <div className="ext-icon">{ext.iconUrl ? <img src={ext.iconUrl} alt="" /> : <IconPuzzle size={22} />}</div>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="ext-name">{ext.name}</div>
          <div className="muted small">{t("Version {version} · MV{manifestVersion}", { version: ext.version, manifestVersion: ext.manifestVersion })}</div>
        </div>
        <Toggle label={t("Enable {name}", { name: ext.name })} checked={ext.enabled} onChange={(v) => run(api.call("extensions.setEnabled", ext.id, v))} />
      </div>
      <div className="ext-desc">{ext.description || t("No description.")}</div>
      {ext.errors.length > 0 && (
        <div className="notice error ext-errors">{ext.errors.length === 1 ? t("1 error") : t("{length} errors", { length: ext.errors.length })}: {ext.errors[ext.errors.length - 1]?.message}
        </div>
      )}
      {open && (
        <div className="ext-details">
          <div className="mono muted small">{t("ID")}{" "}{ext.id}</div>
          <div className="mono muted small ext-path" title={ext.path}>
            {ext.path}
          </div>
          <h4>{t("Permissions")}</h4>
          {ext.warnings.length === 0 ? (
            <div className="muted small">{t("No special permissions.")}</div>
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
            <div className="notice warn small">{t("Not available in Corvus yet: {v}. Features that rely on them may not work.", { v: ext.unsupported.map((p) => `chrome.${p}`).join(", ") })}</div>
          )}
          {ext.errors.length > 0 && (
            <>
              <h4>{t("Errors")}</h4>
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
              <button className="btn small ghost" onClick={() => run(api.call("extensions.clearErrors", ext.id))}>{t("Clear errors")}</button>
            </>
          )}
        </div>
      )}
      <div className="ext-foot">
        <span className="pill">{ext.source === "webstore" ? t("Chrome Web Store") : t("Unpacked")}</span>
        <span style={{ flex: 1 }} />
        <button className="btn small ghost" onClick={() => setOpen(!open)}>
          {open ? t("Hide details") : t("Details")}
        </button>
        {ext.optionsUrl && (
          <button className="btn small ghost" disabled={!ext.enabled} onClick={() => run(api.call("extensions.openOptions", ext.id))}>{t("Options")}</button>
        )}
        {ext.hasAction && ext.enabled && (
          <button className="btn small ghost" onClick={() => run(api.call("extensions.setPinned", ext.id, !ext.pinned))}>
            {ext.pinned ? t("Unpin") : t("Pin")}
          </button>
        )}
        <button
          className="btn small ghost danger"
          onClick={() => {
            if (confirm(t("Remove “{name}” from this profile?", { name: ext.name }))) run(api.call("extensions.remove", ext.id));
          }}
        >{t("Remove")}</button>
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
      title={t("Extensions")}
      active="extensions"
      toolbar={
        <>
          <button className="btn small" disabled={busy} onClick={() => run(api.call("extensions.loadUnpacked"))}>{t("Load unpacked")}</button>
          <button
            className="btn small"
            disabled={busy}
            onClick={() =>
              run(
                api.call("extensions.checkUpdates").then((r) => {
                  setStatus(r.updated.length > 0 ? t("Updated {length} extension(s).", { length: r.updated.length }) : t("Checked {checked} extension(s), all up to date.", { checked: r.checked }));
                }),
              )
            }
          >{t("Update")}</button>
          <a className="btn small primary" href="https://chromewebstore.google.com/" target="_blank" rel="noreferrer" style={{ textDecoration: "none" }}>{t("Open Chrome Web Store")}</a>
        </>
      }
    >
      <div className="notice">{t("Extensions are installed per profile. Use “Add to Corvus” on the Chrome Web Store, paste a store link or extension ID below, or load an unpacked folder that contains a")}{" "}<code>manifest.json</code>{t(". Some Chrome APIs are not available yet; each card lists the ones an extension asks for but cannot use.")}</div>
      <form
        className="ext-install"
        onSubmit={(e) => {
          e.preventDefault();
          install();
        }}
      >
        <input
          className="input"
          placeholder={t("Chrome Web Store link or extension ID")}
          value={storeInput}
          onChange={(e) => setStoreInput(e.target.value)}
          spellCheck={false}
        />
        <button className="btn small primary" type="submit" disabled={busy || !storeInput.trim()}>
          {busy ? t("Working…") : t("Install")}
        </button>
      </form>
      {error && <div className="notice error">{error}</div>}
      {status && <div className="notice">{status}</div>}
      {list && list.length === 0 && (
        <div className="card">
          <div className="empty">{t("No extensions installed in this profile.")}</div>
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
