import { useCallback, useEffect, useState } from "react";
import { PERMISSION_LABELS, type PermissionDecision, type PermissionKind, type SitePermissionEntry } from "../../shared/permissions";
import type { SettingsPatch, SettingsView, StartupMode } from "../../shared/settings";
import { errorMessage, internalApi } from "../common/api";
import { t } from "../common/i18n";
import { IconTrash } from "../common/icons";
import { PermissionIcon, displayOrigin } from "../common/permission-icon";
import { Toggle } from "../common/ui";
import "./settings-browser.css";
import { Row, Section } from "./shell";

type Props = { view: SettingsView; update: (p: SettingsPatch) => void };

export function StartupSection({ view, update }: Props) {
  const mode = view.settings.startup.mode;
  const options: Array<[StartupMode, string]> = [
    ["restore", t("Continue where you left off")],
    ["newtab", t("Open the New Tab page")],
  ];
  return (
    <Section id="startup" title={t("On startup")}>
      <Row label={t("When Corvus starts")} hint={t("Windows, tabs and tab groups are saved continuously, so they also come back after a crash.")}>
        <div className="segmented startup-mode">
          {options.map(([value, label]) => (
            <button key={value} className={value === mode ? "on" : ""} onClick={() => update({ startup: { mode: value } })}>
              {label}
            </button>
          ))}
        </div>
      </Row>
    </Section>
  );
}

const SLEEP_AFTER_MINUTES = [15, 30, 60, 120, 240];

export function MemorySection({ view, update }: Props) {
  const m = view.settings.memory;
  return (
    <Section
      id="memory"
      title={t("Memory")}
      description={t("Tabs you have not looked at for a while go to sleep: their page is unloaded to free memory and comes back where it was, with its history and what you typed in forms, as soon as you return. Hover a tab to see the memory it uses.")}
    >
      <Row label={t("Sleeping tabs")} hint={t("Pinned tabs, tabs playing sound, tabs an AI agent is using and pages where you typed something stay awake.")}>
        <Toggle label={t("Sleeping tabs")} checked={m.sleepTabs} onChange={(v) => update({ memory: { sleepTabs: v } })} />
      </Row>
      <Row label={t("Sleep after")}>
        <select
          className="input"
          value={m.sleepAfterMinutes}
          disabled={!m.sleepTabs}
          onChange={(e) => update({ memory: { sleepAfterMinutes: Number(e.target.value) } })}
        >
          {[...new Set([...SLEEP_AFTER_MINUTES, m.sleepAfterMinutes])]
            .sort((a, b) => a - b)
            .map((minutes) => (
              <option key={minutes} value={minutes}>
                {minutes < 60 ? t("{n} minutes", { n: minutes }) : t("{n} hours", { n: minutes / 60 })}
              </option>
            ))}
        </select>
      </Row>
    </Section>
  );
}

export function DownloadsSection({ view, update, setView }: Props & { setView: (v: SettingsView) => void }) {
  const d = view.settings.downloads;
  const [error, setError] = useState<string | null>(null);
  return (
    <Section id="downloads" title={t("Downloads")} description={t("Programs requested by AI-agent tabs are always held back until you keep them.")}>
      <Row label={t("Location")} hint={d.directory ? undefined : "Your system Downloads folder."}>
        <code className="mono">{d.directory || t("Downloads")}</code>
        <button
          className="btn small"
          onClick={() => {
            setError(null);
            internalApi()
              .call("downloads.chooseDirectory")
              .then((v) => v && setView(v))
              .catch((e: unknown) => setError(errorMessage(e)));
          }}
        >
          {t("Change…")}
        </button>
        {d.directory && (
          <button className="btn small ghost" onClick={() => update({ downloads: { directory: "" } })}>
            {t("Use default")}
          </button>
        )}
      </Row>
      <Row label={t("Ask where to save each file before downloading")}>
        <Toggle label={t("Ask where to save each file")} checked={d.askWhereToSave} onChange={(v) => update({ downloads: { askWhereToSave: v } })} />
      </Row>
      {error && <div className="notice error">{error}</div>}
    </Section>
  );
}

export function SitePermissionsSection() {
  const api = internalApi();
  const [entries, setEntries] = useState<SitePermissionEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(() => void api.call("sitePermissions.list").then(setEntries), [api]);
  useEffect(() => {
    reload();
    return api.onEvent((e) => {
      if (e.type === "site-permissions-changed") reload();
    });
  }, [api, reload]);

  const run = (p: Promise<SitePermissionEntry[]>): void => {
    setError(null);
    p.then(setEntries).catch((e: unknown) => setError(errorMessage(e)));
  };

  return (
    <Section
      id="site-permissions"
      title={t("Site permissions")}
      description={t("Decisions you asked Corvus to remember, per site, for this profile. Sites without an entry ask again. Non-secure (http) sites get no permissions; AI-agent tabs never get camera, microphone, location or screen capture.")}
    >
      {entries && entries.length === 0 && <div className="empty small">{t("No site has remembered permissions yet.")}</div>}
      {entries?.map((entry) => (
        <div key={entry.origin} className="site-entry">
          <div className="site-entry-head">
            <strong className="grow">{displayOrigin(entry.origin)}</strong>
            <button className="btn small ghost danger" onClick={() => run(api.call("sitePermissions.reset", entry.origin))}>
              <IconTrash size={13} />
              {t("Reset")}
            </button>
          </div>
          {(Object.entries(entry.permissions) as Array<[PermissionKind, PermissionDecision]>).map(([kind, decision]) => (
            <div key={kind} className="site-entry-row">
              <PermissionIcon kind={kind} size={15} />
              <span className="grow">{t(PERMISSION_LABELS[kind].title)}</span>
              <span className={`pill ${decision === "allow" ? "ok" : "bad"}`}>{decision === "allow" ? t("Allowed") : t("Blocked")}</span>
              <button className="btn small ghost" title={t("Revoke")} onClick={() => run(api.call("sitePermissions.set", entry.origin, kind, null))}>
                {t("Revoke")}
              </button>
            </div>
          ))}
        </div>
      ))}
      {error && <div className="notice error">{error}</div>}
    </Section>
  );
}
