import { useCallback, useEffect, useState, type CSSProperties } from "react";
import type { GroupColor } from "@corvus/shared";
import { CONTAINER_COLORS, type Container } from "../../shared/containers";
import type { TelegramStatus } from "../../shared/phone-share";
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
  const saved = d.archivePasswords.join("\n");
  const [passwords, setPasswords] = useState(saved);
  useEffect(() => setPasswords(saved), [saved]);
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
      <Row label={t("Offer copied download links")} hint={t("When text you copy has download links, a button in the toolbar adds them to the link grabber. Corvus reads the clipboard every second or so while this is on.")}>
        <Toggle label={t("Offer copied download links")} checked={d.watchClipboard} onChange={(v) => update({ downloads: { watchClipboard: v } })} />
      </Row>
      <Row
        label={t("Extract archives when a package finishes")}
        hint={t("Joins split files and extracts RAR, 7z and ZIP archives, multi-part ones too, into the package's folder. Passwords are tried in order: the ones found next to the links, the package name, then your list below.")}
      >
        <Toggle label={t("Extract archives when a package finishes")} checked={d.extractArchives} onChange={(v) => update({ downloads: { extractArchives: v } })} />
      </Row>
      <Row label={t("Delete archives after extracting")} hint={t("Only once an archive extracted without errors.")}>
        <Toggle label={t("Delete archives after extracting")} checked={d.deleteArchives} onChange={(v) => update({ downloads: { deleteArchives: v } })} />
      </Row>
      <Row label={t("Archive passwords")} hint={t("One per line. A password you type for a package is added here when it works.")}>
        <textarea
          className="input mono"
          rows={4}
          value={passwords}
          spellCheck={false}
          data-archive-passwords
          style={{ width: 320, height: "auto", padding: "8px 10px", resize: "vertical" }}
          onChange={(e) => setPasswords(e.target.value)}
          onBlur={() => passwords !== d.archivePasswords.join("\n") && update({ downloads: { archivePasswords: passwords.split("\n") } })}
        />
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

/** "Send to your phone": a QR code always; Telegram through the person's own bot, when linked. */
export function PhoneSection({ view, update }: Props) {
  const api = internalApi();
  const [status, setStatus] = useState<TelegramStatus | null>(null);
  const [token, setToken] = useState("");
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void api.call("phone.status").then(setStatus);
  }, [api]);
  const connect = (): void => {
    setBusy(true);
    setMessage(null);
    void api
      .call("phone.connect", token.trim() || undefined)
      .then((r) => {
        setStatus(r.status);
        setMessage({ ok: r.ok, text: r.message });
        if (r.ok) setToken("");
      })
      .catch((e: unknown) => setMessage({ ok: false, text: errorMessage(e) }))
      .finally(() => setBusy(false));
  };
  const disconnect = (): void => {
    setMessage(null);
    void api.call("phone.disconnect").then(setStatus);
  };
  return (
    <Section
      id="phone"
      title={t("Send to your phone")}
      description={t("“Send to your phone…” in a tab's or a link's menu shows the page as a QR code to scan with your phone's camera. Link your own Telegram bot to send pages there too, and to open links you send to it from your phone.")}
    >
      <Row
        label={t("Telegram bot token")}
        hint={t("Create a bot with @BotFather in Telegram, paste its token here, send /start to your bot, then click Connect. The token stays in this device's keychain.")}
      >
        <input
          className="input"
          type="password"
          autoComplete="off"
          placeholder={status?.hasToken ? t("Saved (paste a new one to replace it)") : "123456:ABC-DEF…"}
          value={token}
          onChange={(e) => setToken(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && connect()}
        />
        <button className="btn small primary" disabled={busy || (!token.trim() && !status?.hasToken)} onClick={connect}>
          {busy ? t("Connecting…") : t("Connect")}
        </button>
      </Row>
      {message && <div className={`notice ${message.ok ? "" : "error"}`}>{message.text}</div>}
      {status?.hasToken && (
        <Row label={t("Linked chat")} {...(status.bot ? { hint: t("Bot: {bot}", { bot: status.bot }) } : {})}>
          <span className={status.linked ? "pill ok" : "muted"}>{status.linked ? status.chatName : t("Not linked yet")}</span>
          <button className="btn small ghost danger" onClick={disconnect}>
            {t("Disconnect")}
          </button>
        </Row>
      )}
      <Row label={t("Open links you send to the bot")} hint={t("Links that arrive from your linked chat open as background tabs in Corvus, about every 30 seconds. Messages from anyone else are ignored.")}>
        <Toggle
          label={t("Open links you send to the bot")}
          checked={view.settings.phone.receiveLinks}
          disabled={!status?.linked}
          onChange={(v) => update({ phone: { receiveLinks: v } })}
        />
      </Row>
    </Section>
  );
}
