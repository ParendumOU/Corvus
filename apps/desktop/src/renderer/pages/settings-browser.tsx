import { useCallback, useEffect, useState, type CSSProperties } from "react";
import type { GroupColor } from "@corvus/shared";
import { CONTAINER_COLORS, type Container } from "../../shared/containers";
import { GROUP_COLOR_HEX } from "../../shared/ipc";
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

export function MediaSection({ view, update }: Props) {
  return (
    <Section id="media" title={t("Media")}>
      <Row
        label={t("Picture-in-picture when you switch tabs")}
        hint={t("A video playing with sound keeps playing in a small floating window when you go to another tab, and returns to its page when you come back.")}
      >
        <Toggle
          label={t("Picture-in-picture when you switch tabs")}
          checked={view.settings.media.autoPictureInPicture}
          onChange={(v) => update({ media: { autoPictureInPicture: v } })}
        />
      </Row>
    </Section>
  );
}

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

/** A container colour's name, in the interface language. */
function colorName(c: GroupColor): string {
  const names: Record<GroupColor, string> = {
    blue: t("Blue"),
    cyan: t("Turquoise"),
    green: t("Green"),
    yellow: t("Yellow"),
    orange: t("Orange"),
    red: t("Red"),
    pink: t("Pink"),
    purple: t("Purple"),
    grey: t("Grey"),
  };
  return names[c];
}

/** One container: its colour, an editable name and "Remove". */
function ContainerRow({ container, run }: { container: Container; run: (p: Promise<Container[]>) => void }) {
  const api = internalApi();
  const [name, setName] = useState(container.name);
  useEffect(() => setName(container.name), [container.name]);
  const save = (): void => {
    if (name.trim() && name.trim() !== container.name) run(api.call("containers.update", container.id, { name }));
    else setName(container.name);
  };
  const remove = (): void => {
    if (!window.confirm(t("Remove the “{name}” container? Its tabs close and its cookies and site data are deleted.", { name: container.name }))) return;
    run(api.call("containers.remove", container.id));
  };
  return (
    <div className="list-row container-row">
      <span className="container-dot" style={{ "--c-light": GROUP_COLOR_HEX[container.color].light, "--c-dark": GROUP_COLOR_HEX[container.color].dark } as CSSProperties} />
      <input
        className="input grow"
        aria-label={t("Container name")}
        value={name}
        maxLength={40}
        onChange={(e) => setName(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
      />
      <select
        className="input"
        aria-label={t("Colour")}
        value={container.color}
        onChange={(e) => run(api.call("containers.update", container.id, { color: e.target.value as GroupColor }))}
      >
        {CONTAINER_COLORS.map((c) => (
          <option key={c} value={c}>
            {colorName(c)}
          </option>
        ))}
      </select>
      <button className="btn small ghost danger" title={t("Remove")} onClick={remove}>
        <IconTrash size={13} />
        {t("Remove")}
      </button>
    </div>
  );
}

export function ContainersSection() {
  const api = internalApi();
  const [containers, setContainers] = useState<Container[] | null>(null);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(() => void api.call("containers.list").then(setContainers), [api]);
  useEffect(() => {
    reload();
    return api.onEvent((e) => {
      if (e.type === "settings-changed") reload();
    });
  }, [api, reload]);

  const run = (p: Promise<Container[]>): void => {
    setError(null);
    p.then(setContainers).catch((e: unknown) => setError(errorMessage(e)));
  };
  const add = (): void => {
    if (!name.trim()) return;
    const used = new Set(containers?.map((c) => c.color));
    const color = CONTAINER_COLORS.find((c) => !used.has(c)) ?? "grey";
    run(api.call("containers.add", name, color));
    setName("");
  };

  return (
    <Section
      id="containers"
      title={t("Containers")}
      description={t("Tabs in a container keep their own cookies and site data, so you can be signed in to two accounts of one site, or keep shopping and banking apart from everything else. Open one from the menu (New container tab), a link's menu or a tab's menu (Reopen in container). Extensions do not run in container tabs.")}
    >
      {containers && containers.length === 0 && (
        <Row label={t("No containers yet")}>
          <span className="muted">{t("Add one below.")}</span>
        </Row>
      )}
      {containers && containers.length > 0 && (
        <div className="list">
          {containers.map((c) => (
            <ContainerRow key={c.id} container={c} run={run} />
          ))}
        </div>
      )}
      <Row label={t("New container")}>
        <input
          className="input"
          placeholder={t("Name")}
          value={name}
          maxLength={40}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && add()}
        />
        <button className="btn small" disabled={!name.trim()} onClick={add}>
          {t("Add")}
        </button>
      </Row>
      {error && <div className="notice error">{error}</div>}
    </Section>
  );
}
