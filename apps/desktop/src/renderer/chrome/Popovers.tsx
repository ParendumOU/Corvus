import { useEffect, useState, type CSSProperties, type MouseEvent, type ReactNode } from "react";
import type { AdblockBarState } from "../../shared/adblock";
import type { DownloadsSummary, PermissionPromptView, QueueSummary, SiteInfo } from "../../shared/browser-ipc";
import { downloadActions, downloadProgress, downloadStatus, type DownloadAction, type DownloadRecord } from "../../shared/downloads";
import { PERMISSION_LABELS, type PermissionDecision } from "../../shared/permissions";
import type { WatchBarState } from "../../shared/watch-ipc";
import type { WorkspaceView } from "../../shared/workspace-ipc";
import type { PhoneShare } from "../../shared/phone-share";
import { chromeApi } from "../common/api";
import {
  IconAgent,
  IconBell,
  IconCheck,
  IconClose,
  IconDownload,
  IconEdit,
  IconFile,
  IconFolder,
  IconLock,
  IconMinus,
  IconPause,
  IconPlay,
  IconPlus,
  IconReload,
  IconShield,
  IconSparkle,
  IconTrash,
  IconWarning,
} from "../common/icons";
import { PermissionIcon, displayOrigin } from "../common/permission-icon";
import "./popovers.css";

import { t } from "../common/i18n";
export interface Anchor {
  left: number;
  top: number;
  /** Align the popover's right edge here instead of its left edge. */
  right?: number;
}

const POPOVER_WIDTH = 340;

function placement(anchor: Anchor): CSSProperties {
  if (anchor.right !== undefined) return { top: anchor.top, left: Math.max(8, anchor.right - POPOVER_WIDTH) };
  return { top: anchor.top, left: Math.max(8, Math.min(anchor.left, window.innerWidth - POPOVER_WIDTH - 8)) };
}

const stop = (e: MouseEvent): void => e.stopPropagation();

// ------------------------------------------------------------------------- permission prompt

export function PermissionPrompt({ prompt, anchor }: { prompt: PermissionPromptView; anchor: Anchor }) {
  const api = chromeApi();
  const [remember, setRemember] = useState(true);
  const [source, setSource] = useState(prompt.sources?.[0]?.id);
  const answer = (response: "allow" | "block"): void => {
    void api.call("permissions.respond", prompt.id, response, prompt.rememberable && remember, response === "allow" ? source : undefined);
  };
  const host = displayOrigin(prompt.origin);

  return (
    <div className="popover perm-prompt" role="dialog" aria-label={t("Permission request")} style={placement(anchor)} onMouseDown={stop}>
      <button className="icon-btn popover-close" title={t("Dismiss")} onClick={() => void api.call("permissions.respond", prompt.id, "dismiss", false)}>
        <IconClose size={14} />
      </button>
      <div className="popover-title">
        <strong>{host}</strong>{" "}{t("wants to")}</div>
      <ul className="perm-list">
        {prompt.kinds.map((kind) => (
          <li key={kind}>
            <PermissionIcon kind={kind} />
            <span>{t(PERMISSION_LABELS[kind].prompt)}</span>
          </li>
        ))}
      </ul>
      {prompt.sources && (
        <div className="source-list" role="radiogroup" aria-label={t("What to share")}>
          {prompt.sources.map((s) => (
            <label key={s.id} className={source === s.id ? "on" : ""}>
              <input type="radio" name="source" checked={source === s.id} onChange={() => setSource(s.id)} />
              <span className="muted small">{s.kind === "screen" ? t("Screen") : t("Window")}</span>
              <span className="source-name">{s.name}</span>
            </label>
          ))}
        </div>
      )}
      {prompt.agent && (
        <div className="perm-agent">
          <IconAgent size={15} />
          <span>{t("An AI agent is driving this tab. Your answer applies to this page only.")}</span>
        </div>
      )}
      {prompt.rememberable && (
        <label className="perm-remember">
          <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />{t("Remember this decision for this site")}</label>
      )}
      <div className="popover-actions">
        <button className="btn" onClick={() => answer("block")}>{t("Block")}</button>
        <button className="btn primary" onClick={() => answer("allow")}>{t("Allow")}</button>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------------- site info

const DECISION_OPTIONS: Array<[PermissionDecision | "ask", string]> = [
  ["allow", t("Allow")],
  ["block", t("Block")],
  ["ask", t("Ask (default)")],
];

export function SiteInfoPopover({ anchor, onClose }: { anchor: Anchor; onClose: () => void }) {
  const api = chromeApi();
  const [info, setInfo] = useState<SiteInfo | null>(null);
  useEffect(() => {
    void api.call("site.info").then(setInfo);
  }, [api]);
  if (!info) return null;

  const connection = info.certError
    ? {
        icon: <IconWarning size={15} />,
        title: t("Connection is not secure"),
        detail: t("The certificate of this site is not valid ({code}). Don't enter passwords or other sensitive information here.", { code: info.certError }),
      }
    : info.scheme === "https"
      ? { icon: <IconLock size={15} />, title: t("Connection is secure"), detail: t("Information you send to this site is private.") }
      : info.scheme === "http"
        ? {
            icon: <IconWarning size={15} />,
            title: t("Connection is not secure"),
            detail: info.secure
              ? t("This is a local address on your device.")
              : t("Don't enter sensitive information on this site. Sites without a secure connection cannot use permissions."),
          }
        : info.scheme === "file"
          ? { icon: <IconFile size={15} />, title: t("This is a local file"), detail: "" }
          : { icon: <IconFile size={15} />, title: info.host, detail: "" };

  return (
    <div className="popover site-info" role="dialog" aria-label={t("Site information")} style={placement(anchor)} onMouseDown={stop}>
      <div className="popover-title site-host">{info.host}</div>
      <div className={`site-connection ${info.scheme === "http" || info.certError ? "warn" : ""}`}>
        {connection.icon}
        <div>
          <div>{connection.title}</div>
          {connection.detail && <div className="muted small">{connection.detail}</div>}
        </div>
      </div>
      {info.certAccepted && (
        <div className="site-cert-accepted">
          <span className="muted small">{t("You chose to go on to this site despite its certificate, for this session.")}</span>
          <button
            className="btn small"
            onClick={() => {
              void api.call("site.restoreCertWarnings").then(onClose);
            }}
          >{t("Turn on warnings again")}</button>
        </div>
      )}
      {info.agent && (
        <div className="perm-agent">
          <IconAgent size={15} />
          <span>{t("An AI agent is driving this tab. Camera, microphone, location and screen capture are always blocked here.")}</span>
        </div>
      )}
      <div className="popover-section">{t("Permissions")}</div>
      {info.permissions.length === 0 ? (
        <div className="muted small site-empty">{t("No permissions have been allowed or blocked for this site.")}</div>
      ) : (
        <ul className="site-perms">
          {info.permissions.map((p) => (
            <li key={p.kind}>
              <PermissionIcon kind={p.kind} />
              <span className="grow">
                {t(PERMISSION_LABELS[p.kind].title)}
                {p.temporary && <span className="muted small">{" "}{t("· this page only")}</span>}
              </span>
              <select
                className="input"
                value={p.decision}
                onChange={(e) => {
                  const value = e.target.value;
                  void api.call("site.setPermission", p.kind, value === "ask" ? null : (value as PermissionDecision)).then(setInfo);
                }}
              >
                {DECISION_OPTIONS.map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </li>
          ))}
        </ul>
      )}
      {info.zoomPercent !== 100 && (
        <div className="site-zoom">
          <span className="grow">{t("Zoom {zoomPercent}%", { zoomPercent: info.zoomPercent })}</span>
          <button
            className="btn small"
            onClick={() => {
              void api
                .call("zoom.step", 0)
                .then(() => api.call("site.info"))
                .then(setInfo);
            }}
          >{t("Reset")}</button>
        </div>
      )}
      <div className="popover-actions">
        {info.permissions.length > 0 && (
          <button className="btn small ghost" onClick={() => void api.call("site.resetPermissions").then(setInfo)}>{t("Reset permissions")}</button>
        )}
        <button
          className="btn small"
          onClick={() => {
            void api.call("tabs.openUrl", "corvus://settings/#site-permissions", "new-tab");
            onClose();
          }}
        >{t("Site settings")}</button>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------------- zoom

export function ZoomPopover({ anchor, percent }: { anchor: Anchor; percent: number }) {
  const api = chromeApi();
  return (
    <div className="popover zoom-popover" role="dialog" aria-label={t("Zoom")} style={{ ...placement(anchor), width: 260 }} onMouseDown={stop}>
      <span className="grow">{t("Zoom: {percent}%", { percent })}</span>
      <button className="icon-btn" title={t("Zoom out (Ctrl+-)")} onClick={() => void api.call("zoom.step", -1)}>
        <IconMinus size={15} />
      </button>
      <button className="icon-btn" title={t("Zoom in (Ctrl++)")} onClick={() => void api.call("zoom.step", 1)}>
        <IconPlus size={15} />
      </button>
      <button className="btn small" onClick={() => void api.call("zoom.step", 0)}>{t("Reset")}</button>
    </div>
  );
}

// ------------------------------------------------------------------------- downloads

const ACTION_UI: Record<DownloadAction, { title: string; icon: ReactNode } | null> = {
  pause: { title: t("Pause"), icon: <IconPause size={14} /> },
  resume: { title: t("Resume"), icon: <IconPlay size={14} /> },
  cancel: { title: t("Cancel"), icon: <IconClose size={14} /> },
  open: null,
  show: { title: t("Show in folder"), icon: <IconFolder size={14} /> },
  remove: { title: t("Remove from list"), icon: <IconTrash size={14} /> },
  keep: null,
  discard: null,
  retry: { title: t("Retry"), icon: <IconReload size={14} /> },
};

function DownloadRow({ d }: { d: DownloadRecord }) {
  const api = chromeApi();
  const act = (action: DownloadAction): void => void api.call("downloads.action", d.id, action);
  const progress = downloadProgress(d);
  const actions = downloadActions(d);
  return (
    <li className={`dl-row ${d.state}`}>
      <span className="dl-icon">{d.state === "blocked" ? <IconWarning size={18} /> : <IconFile size={18} />}</span>
      <div className="grow">
        <button className="dl-name" disabled={d.state !== "completed"} title={d.savePath || d.url} onClick={() => act("open")}>
          {d.filename}
        </button>
        <div className="dl-status">{downloadStatus(d)}</div>
        {(d.state === "progressing" || d.state === "paused") && (
          <div className="dl-bar">
            <span style={{ width: progress === null ? "100%" : `${Math.round(progress * 100)}%` }} className={progress === null ? "indeterminate" : ""} />
          </div>
        )}
        {d.state === "blocked" && (
          <div className="dl-confirm">
            <button className="btn small danger" onClick={() => act("discard")}>{t("Discard")}</button>
            <button className="btn small" onClick={() => act("keep")}>{t("Keep anyway")}</button>
          </div>
        )}
      </div>
      <div className="dl-actions">
        {actions.map((a) => {
          const ui = ACTION_UI[a];
          return ui ? (
            <button key={a} className="icon-btn" title={ui.title} onClick={() => act(a)}>
              {ui.icon}
            </button>
          ) : null;
        })}
      </div>
    </li>
  );
}

/** Once per launch while Corvus is not the default browser: Make default, Not now, Don't ask again. */
export function DefaultBrowserBar() {
  const api = chromeApi();
  return (
    <div className="default-browser-bar" role="status" data-default-browser-bar>
      <span className="grow">{t("Corvus is not your default browser.")}</span>
      <button className="btn small primary" data-default-browser="make" onClick={() => void api.call("defaultBrowser.answer", "make")}>{t("Make default")}</button>
      <button className="btn small ghost" data-default-browser="later" onClick={() => void api.call("defaultBrowser.answer", "later")}>{t("Not now")}</button>
      <button className="btn small ghost" data-default-browser="never" onClick={() => void api.call("defaultBrowser.answer", "never")}>{t("Don't ask again")}</button>
    </div>
  );
}

/** Download links in the text just copied: download them, look at them in the link grabber, or ask the AI. */
export function CopiedLinksChip({ count }: { count: number }) {
  const api = chromeApi();
  if (count <= 0) return null;
  return (
    <span className="copied-links-chip">
      <button className="copied-links-main" title={t("Download links copied: add them to the link grabber")} onClick={() => void api.call("grabber.grabCopied")}>
        <IconSparkle size={14} />
        {count === 1 ? t("1 link") : t("{count} links", { count })}
      </button>
      <button className="copied-links-queue" data-copied-queue title={t("Download them now with Corvus's download queue")} onClick={() => void api.call("grabber.queueCopied")}>
        <IconDownload size={13} />
        {t("Download")}
      </button>
      <button className="copied-links-ai" title={t("Download with AI: Corvus finds the real files behind these links and queues them")} onClick={() => void api.call("grabber.downloadCopiedWithAi")}>
        <IconAgent size={13} />{t("AI")}</button>
      <button className="copied-links-close" title={t("Dismiss")} aria-label={t("Dismiss copied links")} onClick={() => void api.call("grabber.dismissCopied")}>
        <IconClose size={12} />
      </button>
    </span>
  );
}

/**
 * The toolbar's downloads button. `pulse` grows by one each time a download starts: the icon bounces
 * and rings ripple out from it (the keyed elements remount, which restarts their animation).
 */
export function DownloadsButton({ summary, pulse, onOpen }: { summary: DownloadsSummary; pulse: number; onOpen: (rect: DOMRect) => void }) {
  const queue = summary.queue;
  if (summary.recent.length === 0 && !queue) return null;
  const active = summary.active + (queue?.running ?? 0);
  const ring = summary.active > 0 && summary.progress !== null ? summary.progress : queue && queue.running > 0 ? queue.progress : null;
  const attention = summary.attention || (queue?.attention ?? 0) > 0;
  // A green check once downloads finish, until the person looks at them (not while others run or wait for them).
  const done = summary.finished > 0 && active === 0 && !attention;
  const title =
    active > 0
      ? t("Downloads ({active} in progress)", { active })
      : done
        ? summary.finished === 1
          ? t("Download finished")
          : t("{count} downloads finished", { count: summary.finished })
        : t("Downloads");
  return (
    <button
      className={`icon-btn downloads-btn ${active > 0 ? "active" : ""} ${attention ? "attention" : ""} ${done ? "done" : ""}`}
      data-downloads-button
      title={title}
      aria-label={title}
      style={ring !== null ? ({ "--progress": `${Math.round(ring * 360)}deg` } as CSSProperties) : undefined}
      onClick={(e) => onOpen(e.currentTarget.getBoundingClientRect())}
    >
      {pulse > 0 && <span key={`ring-${pulse}`} className="downloads-pulse" aria-hidden="true" data-downloads-pulse />}
      <span key={`icon-${pulse}`} className={`downloads-icon ${pulse > 0 ? "bump" : ""}`}>
        <IconDownload size={17} />
      </span>
      {done && (
        <span className="downloads-done" aria-hidden="true">
          <IconCheck size={9} />
        </span>
      )}
    </button>
  );
}

/** The download queue in the downloads bubble: files left, progress, files that need the person. */
function QueueRow({ queue, onOpen }: { queue: QueueSummary; onOpen: () => void }) {
  const api = chromeApi();
  const parts = [queue.left === 1 ? t("1 file left") : t("{n} files left", { n: queue.left })];
  if (queue.running > 0 && queue.progress !== null) parts.push(`${Math.floor(queue.progress * 100)}%`);
  return (
    <button
      className={`dl-queue-row ${queue.attention > 0 ? "attention" : ""}`}
      data-bubble-queue
      onClick={() => {
        void api.call("downloads.openPage");
        onOpen();
      }}
    >
      <span className="grow">
        <strong>{t("Download queue")}</strong>
        <span className="muted small">{parts.join(" · ")}</span>
      </span>
      {queue.attention > 0 && <span className="pill">{queue.attention === 1 ? t("1 needs you") : t("{n} need you", { n: queue.attention })}</span>}
    </button>
  );
}

/**
 * The downloads bubble. Opened by itself when a download finishes (`autoCloseMs`), it closes after
 * that delay unless the pointer goes over it or it is clicked; then it stays like an opened one.
 */
export function DownloadsBubble({ summary, anchor, autoCloseMs, onClose }: { summary: DownloadsSummary; anchor: Anchor; autoCloseMs?: number; onClose: () => void }) {
  const api = chromeApi();
  const [held, setHeld] = useState(false);
  // Looking at the bubble counts as having seen the finished downloads, also ones that end while it is
  // open. One that opened by itself counts only once the person points at it or clicks it.
  const looked = !autoCloseMs || held;
  useEffect(() => {
    if (looked && summary.finished > 0) void api.call("downloads.markSeen");
  }, [api, looked, summary.finished]);
  useEffect(() => {
    if (!autoCloseMs || held) return;
    const timer = setTimeout(onClose, autoCloseMs);
    return () => clearTimeout(timer);
  }, [autoCloseMs, held, onClose]);
  return (
    <div
      className="popover downloads-bubble"
      role="dialog"
      aria-label={t("Recent downloads")}
      style={placement(anchor)}
      data-downloads-bubble={autoCloseMs ? "auto" : "open"}
      onMouseEnter={() => setHeld(true)}
      onMouseDown={(e) => {
        stop(e);
        setHeld(true);
      }}
    >
      <div className="popover-title">{t("Recent downloads")}</div>
      {summary.queue && <QueueRow queue={summary.queue} onOpen={onClose} />}
      {summary.recent.length === 0 && summary.queue ? null : summary.recent.length === 0 ? (
        <div className="muted small site-empty">{t("No downloads yet.")}</div>
      ) : (
        <ul className="dl-list">
          {summary.recent.map((d) => (
            <DownloadRow key={d.id} d={d} />
          ))}
        </ul>
      )}
      <div className="popover-actions">
        <button
          className="btn small"
          onClick={() => {
            void api.call("downloads.openPage");
            onClose();
          }}
        >{t("Show all downloads")}</button>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------------- shield (ad blocker)

// ------------------------------------------------------------------------- watched pages

export function WatchesButton({ watches, onOpen }: { watches: WatchBarState; onOpen: () => void }) {
  if (watches.total === 0) return null;
  const title = watches.unseen > 0 ? t("{unseen} watched page(s) changed", { unseen: watches.unseen }) : t("Watching {total} page(s)", { total: watches.total });
  return (
    <button className={`icon-btn watches-btn ${watches.unseen > 0 ? "attention" : ""}`} title={title} aria-label={title} onClick={onOpen}>
      <IconBell size={17} />
      {watches.unseen > 0 && <span className="watches-dot">{watches.unseen > 9 ? "9+" : watches.unseen}</span>}
    </button>
  );
}

// ------------------------------------------------------------------------- workspaces

export function WorkspacesButton({ onOpen }: { onOpen: (rect: DOMRect) => void }) {
  return (
    <button className="icon-btn workspaces-btn" title={t("Workspaces")} aria-label={t("Workspaces")} onClick={(e) => onOpen(e.currentTarget.getBoundingClientRect())}>
      <IconFolder size={17} />
    </button>
  );
}

const tabsLabel = (n: number): string => (n === 1 ? t("1 tab") : t("{n} tabs", { n }));

/**
 * Saved workspaces. Clicking one opens its tabs in this window as one tab group named after it (or
 * shows that group if it is already open here). Saving takes this window's tabs; a single tab group
 * is saved from its right-click menu.
 */
export function WorkspacesPopover({ anchor, saveCount, onClose }: { anchor: Anchor; saveCount: number; onClose: () => void }) {
  const api = chromeApi();
  const [list, setList] = useState<WorkspaceView[] | null>(null);
  const [name, setName] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [confirming, setConfirming] = useState<string | null>(null);
  const [updated, setUpdated] = useState<string | null>(null);
  useEffect(() => {
    void api.call("workspaces.list").then(setList);
  }, [api]);
  useEffect(() => {
    if (!updated) return;
    const timer = setTimeout(() => setUpdated(null), 1800);
    return () => clearTimeout(timer);
  }, [updated]);

  const canSave = name.trim() !== "" && saveCount > 0;
  const save = (): void => {
    if (!canSave) return;
    void api.call("workspaces.saveCurrent", name.trim()).then((l) => {
      setList(l);
      setName("");
    });
  };
  const open = (id: string): void => {
    void api.call("workspaces.open", id);
    onClose();
  };
  const update = (w: WorkspaceView): void => {
    if (!w.openGroupId) return;
    void api.call("workspaces.saveGroup", w.openGroupId).then((l) => {
      setList(l);
      setUpdated(w.id);
    });
  };
  const commitRename = (id: string): void => {
    const trimmed = draft.trim();
    setEditing(null);
    if (trimmed) void api.call("workspaces.rename", id, trimmed).then(setList);
  };
  const remove = (id: string): void => {
    void api.call("workspaces.remove", id).then((l) => {
      setList(l);
      setConfirming(null);
    });
  };

  return (
    <div className="popover workspaces-popover" role="dialog" aria-label={t("Workspaces")} style={placement(anchor)} onMouseDown={stop}>
      <div className="popover-title">{t("Workspaces")}</div>
      <div className="ws-save">
        <input
          className="input"
          placeholder={t("Name this window's tabs…")}
          value={name}
          maxLength={80}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && save()}
        />
        <button
          className="btn small primary ws-save-btn"
          disabled={!canSave}
          title={saveCount > 0 ? t("Save every tab in this window as a workspace") : t("No pages to save in this window yet")}
          onClick={save}
        >
          {saveCount > 0 ? t("Save {saveCount}", { saveCount: tabsLabel(saveCount) }) : t("Save")}
        </button>
      </div>
      {list && list.length === 0 && (
        <div className="muted small ws-empty">{t("No saved workspaces yet. Save this window's tabs above, or right-click a tab group and choose “Save group as workspace”.")}</div>
      )}
      {list && list.length > 0 && <div className="muted small ws-hint">{t("Click a workspace to open its tabs here as a tab group.")}</div>}
      {list && list.length > 0 && (
        <ul className="ws-list">
          {list.map((w) =>
            confirming === w.id ? (
              <li key={w.id} className="ws-row ws-confirm">
                <span className="ws-confirm-text">{t("Delete “{name}”?", { name: w.name })}</span>
                <button className="btn small danger" onClick={() => remove(w.id)}>{t("Delete")}</button>
                <button className="btn small ghost" onClick={() => setConfirming(null)}>{t("Cancel")}</button>
              </li>
            ) : (
              <li key={w.id} className={`ws-row ${w.openGroupId ? "open" : ""}`}>
                {editing === w.id ? (
                  <div className="ws-main">
                    <input
                      className="input"
                      autoFocus
                      value={draft}
                      maxLength={80}
                      onChange={(e) => setDraft(e.target.value)}
                      onBlur={() => commitRename(w.id)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") commitRename(w.id);
                        else if (e.key === "Escape") setEditing(null);
                      }}
                    />
                  </div>
                ) : (
                  <button
                    className="ws-main ws-open"
                    title={w.openGroupId ? t("Show its tab group") : t("Open in this window as a tab group")}
                    onClick={() => open(w.id)}
                  >
                    <span className="ws-name">{w.name}</span>
                    <span className="muted small">
                      {updated === w.id ? t("Updated with the group's tabs") : tabsLabel(w.tabCount)}
                      {w.openGroupId && updated !== w.id ? t(" · open in this window") : ""}
                    </span>
                  </button>
                )}
                <div className="ws-actions">
                  {w.openGroupId && (
                    <button className="icon-btn ws-update" title={t("Update: save the group's current tabs to this workspace")} onClick={() => update(w)}>
                      <IconReload size={14} />
                    </button>
                  )}
                  <button
                    className="icon-btn ws-rename"
                    title={t("Rename")}
                    onClick={() => {
                      setEditing(w.id);
                      setDraft(w.name);
                    }}
                  >
                    <IconEdit size={14} />
                  </button>
                  <button className="icon-btn ws-del" title={t("Delete workspace")} onClick={() => setConfirming(w.id)}>
                    <IconTrash size={14} />
                  </button>
                </div>
              </li>
            ),
          )}
        </ul>
      )}
    </div>
  );
}

export function AdblockButton({ state, onOpen }: { state: AdblockBarState; onOpen: (rect: DOMRect) => void }) {
  const off = !state.enabled || state.allowed;
  const title = !state.enabled
    ? t("Ad blocker off")
    : state.allowed
      ? t("Ad blocker paused on {host}", { host: state.host })
      : t("{blocked} blocked on this page", { blocked: state.blocked });
  return (
    <button
      className={`icon-btn shield-btn ${off ? "off" : ""} ${state.blocked > 0 && !off ? "active" : ""}`}
      title={title}
      aria-label={title}
      onClick={(e) => onOpen(e.currentTarget.getBoundingClientRect())}
    >
      <IconShield size={17} />
      {!off && state.blocked > 0 && <span className="shield-count">{state.blocked > 999 ? "999+" : state.blocked}</span>}
    </button>
  );
}

export function AdblockPopover({ state, anchor, onClose }: { state: AdblockBarState; anchor: Anchor; onClose: () => void }) {
  const api = chromeApi();
  const site = state.host || "this page";
  return (
    <div className="popover shield-popover" role="dialog" aria-label={t("Ad blocker")} style={placement(anchor)} onMouseDown={stop}>
      <div className="shield-head">
        <div className={`shield-emblem ${state.active ? "on" : "off"}`}>
          <IconShield size={22} />
        </div>
        <div className="grow">
          <div className="shield-count-big">{state.active ? state.blocked : "—"}</div>
          <div className="muted small">{state.active ? t("blocked on this page") : state.enabled ? t("paused on this site") : t("ad blocker is off")}</div>
        </div>
      </div>
      <label className="shield-row">
        <span className="grow">{t("Don’t block on")}{" "}<strong>{site}</strong>
        </span>
        <input
          type="checkbox"
          checked={state.allowed}
          disabled={!state.enabled || state.host === ""}
          onChange={(e) => void api.call("adblock.pauseSite", e.target.checked)}
        />
      </label>
      <label className="shield-row" title={t("Its cookies and stored data are deleted when you close its last tab")}>
        <span className="grow">{t("Forget this site when I close it")}</span>
        <input
          type="checkbox"
          checked={state.forgetOnClose === true}
          disabled={state.host === ""}
          onChange={(e) => void api.call("adblock.forgetOnClose", e.target.checked)}
        />
      </label>
      {state.cookieBanner && (
        <div className="shield-stats small" data-cookie-banner={state.cookieBanner.outcome}>
          {state.cookieBanner.outcome === "rejected"
            ? state.cookieBanner.cmp
              ? t("Cookie banner rejected ({cmp})", { cmp: state.cookieBanner.cmp })
              : t("Cookie banner rejected")
            : state.cookieBanner.cmp
              ? t("Cookie banner hidden ({cmp})", { cmp: state.cookieBanner.cmp })
              : t("Cookie banner hidden")}
        </div>
      )}
      <label className="shield-row" title={t("Corvus stops answering this site’s cookie banner, so you can choose yourself")}>
        <span className="grow">{t("Allow cookie banner on this site")}</span>
        <input
          type="checkbox"
          data-allow-cookie-banner
          checked={state.consentAllowed}
          disabled={!state.cookieConsent || state.host === ""}
          onChange={(e) => void api.call("adblock.allowCookieBanner", e.target.checked)}
        />
      </label>
      <label className="shield-row">
        <span className="grow">{t("Block ads and trackers (all sites)")}</span>
        <input type="checkbox" checked={state.enabled} onChange={(e) => void api.call("adblock.setEnabled", e.target.checked)} />
      </label>
      {state.skippingYouTubeAds && (
        <div className="shield-stats muted small" data-youtube-fallback>{t("YouTube stopped playing when its ads were removed, so for a couple of hours Corvus skips them instead.")}<button className="btn small ghost" data-youtube-block-again onClick={() => void api.call("adblock.youtubeBlockAgain")}>{t("Remove them again")}</button>
        </div>
      )}
      <div className="shield-stats muted small">{state.total}{" "}{t("requests blocked this session")}</div>
      {state.cookieConsent && <div className="shield-stats muted small" data-banners-handled>{state.bannersHandled}{" "}{t("cookie banners rejected this session")}</div>}
      <div className="popover-actions">
        <button
          className="btn small"
          disabled={!state.active}
          title={t("Choose something on this page to hide on this site from now on")}
          onClick={() => {
            onClose();
            void api.call("adblock.pickElement");
          }}
        >{t("Hide an element…")}</button>
        <button
          className="btn small"
          onClick={() => {
            void api.call("tabs.openUrl", "corvus://settings/#adblock", "new-tab");
            onClose();
          }}
        >{t("Ad blocker settings")}</button>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------------- send to your phone

/** "Send to your phone": a QR code to scan, the link to copy, and Telegram when a chat is linked. */
export function SharePopover({ share, anchor, onClose }: { share: PhoneShare; anchor: Anchor; onClose: () => void }) {
  const api = chromeApi();
  const [sent, setSent] = useState<"idle" | "sending" | "sent" | string>("idle");
  const [copied, setCopied] = useState(false);
  const [toPhone, setToPhone] = useState<Record<string, "sending" | "sent" | string>>({});
  const sendToPhone = (id: string): void => {
    setToPhone((s) => ({ ...s, [id]: "sending" }));
    api.call("share.device", id, share.url, share.title).then(
      () => setToPhone((s) => ({ ...s, [id]: "sent" })),
      (err: unknown) => setToPhone((s) => ({ ...s, [id]: err instanceof Error ? err.message : String(err) })),
    );
  };
  const phoneError = Object.values(toPhone).find((v) => v !== "sending" && v !== "sent");
  const sendTelegram = (): void => {
    setSent("sending");
    api.call("share.telegram", share.url, share.title).then(
      () => setSent("sent"),
      (err: unknown) => setSent(err instanceof Error ? err.message : String(err)),
    );
  };
  return (
    <div className="popover share-popover" role="dialog" aria-label={t("Send to your phone")} style={placement(anchor)} onMouseDown={stop}>
      <div className="share-head">
        <strong>{t("Send to your phone")}</strong>
        <span className="muted small share-title">{share.title || share.url}</span>
      </div>
      <img className="share-qr" alt={t("QR code for {url}", { url: share.url })} src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(share.qrSvg)}`} />
      <div className="muted small share-hint">{t("Scan it with your phone's camera to open the page there.")}</div>
      {share.phones.length > 0 && (
        <div className="popover-actions share-phones">
          {share.phones.map((p) => (
            <button
              key={p.id}
              className="btn small primary"
              data-share-phone={p.name}
              disabled={toPhone[p.id] === "sending" || toPhone[p.id] === "sent"}
              onClick={() => sendToPhone(p.id)}
            >
              {toPhone[p.id] === "sent" ? t("Sent to {name}", { name: p.name }) : toPhone[p.id] === "sending" ? t("Sending…") : t("Send to {name}", { name: p.name })}
            </button>
          ))}
        </div>
      )}
      {phoneError && <div className="share-error small">{phoneError}</div>}
      <div className="popover-actions">
        <button
          className="btn small"
          onClick={() => {
            void api.call("share.copy", share.url);
            setCopied(true);
          }}
        >
          {copied ? t("Copied") : t("Copy link")}
        </button>
        {share.telegram ? (
          <button className="btn small primary" disabled={sent === "sending" || sent === "sent"} onClick={sendTelegram}>
            {sent === "sent" ? t("Sent to Telegram") : sent === "sending" ? t("Sending…") : t("Send to Telegram")}
          </button>
        ) : (
          <button
            className="btn small ghost"
            title={t("Link your own Telegram bot to send pages there and receive links back")}
            onClick={() => {
              void api.call("tabs.openUrl", "corvus://settings/#phone", "new-tab");
              onClose();
            }}
          >{t("Set up Telegram")}</button>
        )}
      </div>
      {sent !== "idle" && sent !== "sending" && sent !== "sent" && <div className="share-error small">{sent}</div>}
    </div>
  );
}
