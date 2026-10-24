import { useEffect, useState, type CSSProperties, type MouseEvent, type ReactNode } from "react";
import type { AdblockBarState } from "../../shared/adblock";
import type { DownloadsSummary, PermissionPromptView, SiteInfo } from "../../shared/browser-ipc";
import { downloadActions, downloadProgress, downloadStatus, type DownloadAction, type DownloadRecord } from "../../shared/downloads";
import { PERMISSION_LABELS, type PermissionDecision } from "../../shared/permissions";
import type { WatchBarState } from "../../shared/watch-ipc";
import type { WorkspaceView } from "../../shared/workspace-ipc";
import type { PhoneShare } from "../../shared/phone-share";
import { chromeApi } from "../common/api";
import {
  IconAgent,
  IconBell,
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
    <div className="popover perm-prompt" role="dialog" aria-label="Permission request" style={placement(anchor)} onMouseDown={stop}>
      <button className="icon-btn popover-close" title="Dismiss" onClick={() => void api.call("permissions.respond", prompt.id, "dismiss", false)}>
        <IconClose size={14} />
      </button>
      <div className="popover-title">
        <strong>{host}</strong> wants to
      </div>
      <ul className="perm-list">
        {prompt.kinds.map((kind) => (
          <li key={kind}>
            <PermissionIcon kind={kind} />
            <span>{PERMISSION_LABELS[kind].prompt}</span>
          </li>
        ))}
      </ul>
      {prompt.sources && (
        <div className="source-list" role="radiogroup" aria-label="What to share">
          {prompt.sources.map((s) => (
            <label key={s.id} className={source === s.id ? "on" : ""}>
              <input type="radio" name="source" checked={source === s.id} onChange={() => setSource(s.id)} />
              <span className="muted small">{s.kind === "screen" ? "Screen" : "Window"}</span>
              <span className="source-name">{s.name}</span>
            </label>
          ))}
        </div>
      )}
      {prompt.agent && (
        <div className="perm-agent">
          <IconAgent size={15} />
          <span>An AI agent is driving this tab. Your answer applies to this page only.</span>
        </div>
      )}
      {prompt.rememberable && (
        <label className="perm-remember">
          <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
          Remember this decision for this site
        </label>
      )}
      <div className="popover-actions">
        <button className="btn" onClick={() => answer("block")}>
          Block
        </button>
        <button className="btn primary" onClick={() => answer("allow")}>
          Allow
        </button>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------------- site info

const DECISION_OPTIONS: Array<[PermissionDecision | "ask", string]> = [
  ["allow", "Allow"],
  ["block", "Block"],
  ["ask", "Ask (default)"],
];

export function SiteInfoPopover({ anchor, onClose }: { anchor: Anchor; onClose: () => void }) {
  const api = chromeApi();
  const [info, setInfo] = useState<SiteInfo | null>(null);
  useEffect(() => {
    void api.call("site.info").then(setInfo);
  }, [api]);
  if (!info) return null;

  const connection =
    info.scheme === "https"
      ? { icon: <IconLock size={15} />, title: "Connection is secure", detail: "Information you send to this site is private." }
      : info.scheme === "http"
        ? {
            icon: <IconWarning size={15} />,
            title: "Connection is not secure",
            detail: info.secure
              ? "This is a local address on your device."
              : "Don't enter sensitive information on this site. Sites without a secure connection cannot use permissions.",
          }
        : info.scheme === "file"
          ? { icon: <IconFile size={15} />, title: "This is a local file", detail: "" }
          : { icon: <IconFile size={15} />, title: info.host, detail: "" };

  return (
    <div className="popover site-info" role="dialog" aria-label="Site information" style={placement(anchor)} onMouseDown={stop}>
      <div className="popover-title site-host">{info.host}</div>
      <div className={`site-connection ${info.scheme === "http" ? "warn" : ""}`}>
        {connection.icon}
        <div>
          <div>{connection.title}</div>
          {connection.detail && <div className="muted small">{connection.detail}</div>}
        </div>
      </div>
      {info.agent && (
        <div className="perm-agent">
          <IconAgent size={15} />
          <span>An AI agent is driving this tab. Camera, microphone, location and screen capture are always blocked here.</span>
        </div>
      )}
      <div className="popover-section">Permissions</div>
      {info.permissions.length === 0 ? (
        <div className="muted small site-empty">No permissions have been allowed or blocked for this site.</div>
      ) : (
        <ul className="site-perms">
          {info.permissions.map((p) => (
            <li key={p.kind}>
              <PermissionIcon kind={p.kind} />
              <span className="grow">
                {PERMISSION_LABELS[p.kind].title}
                {p.temporary && <span className="muted small"> · this page only</span>}
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
          <span className="grow">Zoom {info.zoomPercent}%</span>
          <button
            className="btn small"
            onClick={() => {
              void api
                .call("zoom.step", 0)
                .then(() => api.call("site.info"))
                .then(setInfo);
            }}
          >
            Reset
          </button>
        </div>
      )}
      <div className="popover-actions">
        {info.permissions.length > 0 && (
          <button className="btn small ghost" onClick={() => void api.call("site.resetPermissions").then(setInfo)}>
            Reset permissions
          </button>
        )}
        <button
          className="btn small"
          onClick={() => {
            void api.call("tabs.openUrl", "corvus://settings/#site-permissions", "new-tab");
            onClose();
          }}
        >
          Site settings
        </button>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------------- zoom

export function ZoomPopover({ anchor, percent }: { anchor: Anchor; percent: number }) {
  const api = chromeApi();
  return (
    <div className="popover zoom-popover" role="dialog" aria-label="Zoom" style={{ ...placement(anchor), width: 260 }} onMouseDown={stop}>
      <span className="grow">Zoom: {percent}%</span>
      <button className="icon-btn" title="Zoom out (Ctrl+-)" onClick={() => void api.call("zoom.step", -1)}>
        <IconMinus size={15} />
      </button>
      <button className="icon-btn" title="Zoom in (Ctrl++)" onClick={() => void api.call("zoom.step", 1)}>
        <IconPlus size={15} />
      </button>
      <button className="btn small" onClick={() => void api.call("zoom.step", 0)}>
        Reset
      </button>
    </div>
  );
}

// ------------------------------------------------------------------------- downloads

const ACTION_UI: Record<DownloadAction, { title: string; icon: ReactNode } | null> = {
  pause: { title: "Pause", icon: <IconPause size={14} /> },
  resume: { title: "Resume", icon: <IconPlay size={14} /> },
  cancel: { title: "Cancel", icon: <IconClose size={14} /> },
  open: null,
  show: { title: "Show in folder", icon: <IconFolder size={14} /> },
  remove: { title: "Remove from list", icon: <IconTrash size={14} /> },
  keep: null,
  discard: null,
  retry: { title: "Retry", icon: <IconReload size={14} /> },
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
            <button className="btn small danger" onClick={() => act("discard")}>
              Discard
            </button>
            <button className="btn small" onClick={() => act("keep")}>
              Keep anyway
            </button>
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
      <span className="grow">Corvus is not your default browser.</span>
      <button className="btn small primary" data-default-browser="make" onClick={() => void api.call("defaultBrowser.answer", "make")}>
        Make default
      </button>
      <button className="btn small ghost" data-default-browser="later" onClick={() => void api.call("defaultBrowser.answer", "later")}>
        Not now
      </button>
      <button className="btn small ghost" data-default-browser="never" onClick={() => void api.call("defaultBrowser.answer", "never")}>
        Don't ask again
      </button>
    </div>
  );
}

/** Download links in the text just copied: one click puts them in the link grabber. */
export function CopiedLinksChip({ count }: { count: number }) {
  const api = chromeApi();
  if (count <= 0) return null;
  return (
    <span className="copied-links-chip">
      <button className="copied-links-main" title="Download links copied: add them to the link grabber" onClick={() => void api.call("grabber.grabCopied")}>
        <IconSparkle size={14} />
        {count === 1 ? "1 link" : `${count} links`}
      </button>
      <button className="copied-links-ai" title="Download with AI: Corvus finds the real files behind these links and queues them" onClick={() => void api.call("grabber.downloadCopiedWithAi")}>
        <IconAgent size={13} />
        AI
      </button>
      <button className="copied-links-close" title="Dismiss" aria-label="Dismiss copied links" onClick={() => void api.call("grabber.dismissCopied")}>
        <IconClose size={12} />
      </button>
    </span>
  );
}

export function DownloadsButton({ summary, onOpen }: { summary: DownloadsSummary; onOpen: (rect: DOMRect) => void }) {
  if (summary.recent.length === 0) return null;
  const ring = summary.active > 0 && summary.progress !== null ? summary.progress : null;
  return (
    <button
      className={`icon-btn downloads-btn ${summary.active > 0 ? "active" : ""} ${summary.attention ? "attention" : ""}`}
      title={summary.active > 0 ? `Downloads (${summary.active} in progress)` : "Downloads"}
      style={ring !== null ? ({ "--progress": `${Math.round(ring * 360)}deg` } as CSSProperties) : undefined}
      onClick={(e) => onOpen(e.currentTarget.getBoundingClientRect())}
    >
      <IconDownload size={17} />
    </button>
  );
}

export function DownloadsBubble({ summary, anchor, onClose }: { summary: DownloadsSummary; anchor: Anchor; onClose: () => void }) {
  const api = chromeApi();
  return (
    <div className="popover downloads-bubble" role="dialog" aria-label="Recent downloads" style={placement(anchor)} onMouseDown={stop}>
      <div className="popover-title">Recent downloads</div>
      {summary.recent.length === 0 ? (
        <div className="muted small site-empty">No downloads yet.</div>
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
        >
          Show all downloads
        </button>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------------- shield (ad blocker)

// ------------------------------------------------------------------------- watched pages

export function WatchesButton({ watches, onOpen }: { watches: WatchBarState; onOpen: () => void }) {
  if (watches.total === 0) return null;
  const title = watches.unseen > 0 ? `${watches.unseen} watched page(s) changed` : `Watching ${watches.total} page(s)`;
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
    <button className="icon-btn workspaces-btn" title="Workspaces" aria-label="Workspaces" onClick={(e) => onOpen(e.currentTarget.getBoundingClientRect())}>
      <IconFolder size={17} />
    </button>
  );
}

const tabsLabel = (n: number): string => `${n} tab${n === 1 ? "" : "s"}`;

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
    <div className="popover workspaces-popover" role="dialog" aria-label="Workspaces" style={placement(anchor)} onMouseDown={stop}>
      <div className="popover-title">Workspaces</div>
      <div className="ws-save">
        <input
          className="input"
          placeholder="Name this window's tabs…"
          value={name}
          maxLength={80}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && save()}
        />
        <button
          className="btn small primary ws-save-btn"
          disabled={!canSave}
          title={saveCount > 0 ? "Save every tab in this window as a workspace" : "No pages to save in this window yet"}
          onClick={save}
        >
          {saveCount > 0 ? `Save ${tabsLabel(saveCount)}` : "Save"}
        </button>
      </div>
      {list && list.length === 0 && (
        <div className="muted small ws-empty">No saved workspaces yet. Save this window's tabs above, or right-click a tab group and choose “Save group as workspace”.</div>
      )}
      {list && list.length > 0 && <div className="muted small ws-hint">Click a workspace to open its tabs here as a tab group.</div>}
      {list && list.length > 0 && (
        <ul className="ws-list">
          {list.map((w) =>
            confirming === w.id ? (
              <li key={w.id} className="ws-row ws-confirm">
                <span className="ws-confirm-text">Delete “{w.name}”?</span>
                <button className="btn small danger" onClick={() => remove(w.id)}>
                  Delete
                </button>
                <button className="btn small ghost" onClick={() => setConfirming(null)}>
                  Cancel
                </button>
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
                    title={w.openGroupId ? "Show its tab group" : "Open in this window as a tab group"}
                    onClick={() => open(w.id)}
                  >
                    <span className="ws-name">{w.name}</span>
                    <span className="muted small">
                      {updated === w.id ? "Updated with the group's tabs" : tabsLabel(w.tabCount)}
                      {w.openGroupId && updated !== w.id ? " · open in this window" : ""}
                    </span>
                  </button>
                )}
                <div className="ws-actions">
                  {w.openGroupId && (
                    <button className="icon-btn ws-update" title="Update: save the group's current tabs to this workspace" onClick={() => update(w)}>
                      <IconReload size={14} />
                    </button>
                  )}
                  <button
                    className="icon-btn ws-rename"
                    title="Rename"
                    onClick={() => {
                      setEditing(w.id);
                      setDraft(w.name);
                    }}
                  >
                    <IconEdit size={14} />
                  </button>
                  <button className="icon-btn ws-del" title="Delete workspace" onClick={() => setConfirming(w.id)}>
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
    ? "Ad blocker off"
    : state.allowed
      ? `Ad blocker paused on ${state.host}`
      : `${state.blocked} blocked on this page`;
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
    <div className="popover shield-popover" role="dialog" aria-label="Ad blocker" style={placement(anchor)} onMouseDown={stop}>
      <div className="shield-head">
        <div className={`shield-emblem ${state.active ? "on" : "off"}`}>
          <IconShield size={22} />
        </div>
        <div className="grow">
          <div className="shield-count-big">{state.active ? state.blocked : "—"}</div>
          <div className="muted small">{state.active ? "blocked on this page" : state.enabled ? "paused on this site" : "ad blocker is off"}</div>
        </div>
      </div>
      <label className="shield-row">
        <span className="grow">
          Don’t block on <strong>{site}</strong>
        </span>
        <input
          type="checkbox"
          checked={state.allowed}
          disabled={!state.enabled || state.host === ""}
          onChange={(e) => void api.call("adblock.pauseSite", e.target.checked)}
        />
      </label>
      <label className="shield-row" title="Its cookies and stored data are deleted when you close its last tab">
        <span className="grow">Forget this site when I close it</span>
        <input
          type="checkbox"
          checked={state.forgetOnClose === true}
          disabled={state.host === ""}
          onChange={(e) => void api.call("adblock.forgetOnClose", e.target.checked)}
        />
      </label>
      <label className="shield-row">
        <span className="grow">Block ads and trackers (all sites)</span>
        <input type="checkbox" checked={state.enabled} onChange={(e) => void api.call("adblock.setEnabled", e.target.checked)} />
      </label>
      {state.skippingYouTubeAds && (
        <div className="shield-stats muted small" data-youtube-fallback>
          YouTube stopped playing when its ads were removed, so for a couple of hours Corvus skips them instead.
          <button className="btn small ghost" data-youtube-block-again onClick={() => void api.call("adblock.youtubeBlockAgain")}>
            Remove them again
          </button>
        </div>
      )}
      <div className="shield-stats muted small">{state.total} requests blocked this session</div>
      <div className="popover-actions">
        <button
          className="btn small"
          disabled={!state.active}
          title="Choose something on this page to hide on this site from now on"
          onClick={() => {
            onClose();
            void api.call("adblock.pickElement");
          }}
        >
          Hide an element…
        </button>
        <button
          className="btn small"
          onClick={() => {
            void api.call("tabs.openUrl", "corvus://settings/#adblock", "new-tab");
            onClose();
          }}
        >
          Ad blocker settings
        </button>
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
    <div className="popover share-popover" role="dialog" aria-label="Send to your phone" style={placement(anchor)} onMouseDown={stop}>
      <div className="share-head">
        <strong>Send to your phone</strong>
        <span className="muted small share-title">{share.title || share.url}</span>
      </div>
      <img className="share-qr" alt={`QR code for ${share.url}`} src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(share.qrSvg)}`} />
      <div className="muted small share-hint">Scan it with your phone's camera to open the page there.</div>
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
              {toPhone[p.id] === "sent" ? `Sent to ${p.name}` : toPhone[p.id] === "sending" ? "Sending…" : `Send to ${p.name}`}
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
          {copied ? "Copied" : "Copy link"}
        </button>
        {share.telegram ? (
          <button className="btn small primary" disabled={sent === "sending" || sent === "sent"} onClick={sendTelegram}>
            {sent === "sent" ? "Sent to Telegram" : sent === "sending" ? "Sending…" : "Send to Telegram"}
          </button>
        ) : (
          <button
            className="btn small ghost"
            title="Link your own Telegram bot to send pages there and receive links back"
            onClick={() => {
              void api.call("tabs.openUrl", "corvus://settings/#phone", "new-tab");
              onClose();
            }}
          >
            Set up Telegram
          </button>
        )}
      </div>
      {sent !== "idle" && sent !== "sending" && sent !== "sent" && <div className="share-error small">{sent}</div>}
    </div>
  );
}
