import {
  Component,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import type { Bookmark, GroupColor } from "@corvus/shared";
import { BAR_FOLDER_ID, BOOKMARK_DRAG_MIME, dropMoveIndex } from "../../shared/bookmark-tree";
import { GROUP_COLOR_HEX, type WindowState } from "../../shared/ipc";
import type { PhoneShare } from "../../shared/phone-share";
import { isNewTabUrl } from "../../shared/internal-urls";
import { GROUP_COLORS } from "../../shared/tab-strip";
import { isWorkspaceTabUrl } from "../../shared/workspaces";
import { chromeApi } from "../common/api";
import { IconGlobe, IconLock, IconBack, IconChevronRight, IconClose, IconFolder, IconForward, IconHome, IconMenu, IconReload, IconSparkle } from "../common/icons";
import { DialogBars, DialogModal } from "./Dialogs";
import { Favicon, setFaviconProfile } from "../common/ui";
import { CommandBar } from "./CommandBar";
import { ExtensionsToolbar } from "./Extensions";
import { FindBar } from "./FindBar";
import { barMenuIcons } from "./menu-icons";
import { Omnibox, PAGE_DRAG_MIME, type OmniboxHandle } from "./Omnibox";
import { Organizer } from "./Organizer";
import {
  AdblockButton,
  AdblockPopover,
  SharePopover,
  CopiedLinksChip,
  DefaultBrowserBar,
  DownloadsBubble,
  DownloadsButton,
  PermissionPrompt,
  SiteInfoPopover,
  WatchesButton,
  WorkspacesButton,
  WorkspacesPopover,
  ZoomPopover,
  type Anchor,
} from "./Popovers";
import { TabStrip } from "./TabStrip";

import { t as tx } from "../common/i18n";
interface GroupEditorState {
  groupId: string;
  /** Where to show it; without one it goes under the group's chip. */
  anchor?: Anchor;
}

type PopoverState = { kind: "site" | "zoom" | "downloads" | "adblock" | "workspaces"; anchor: Anchor } | { kind: "share"; anchor: Anchor; share: PhoneShare } | null;

function omniboxAnchor(): Anchor {
  const rect = document.querySelector(".omnibox")?.getBoundingClientRect();
  return { left: rect?.left ?? 120, top: (rect?.bottom ?? 80) + 6 };
}

function downloadsAnchor(): Anchor {
  const rect = document.querySelector(".downloads-btn")?.getBoundingClientRect();
  return { left: 0, top: (rect?.bottom ?? 80) + 6, right: rect?.right ?? window.innerWidth - 8 };
}

function workspacesAnchor(): Anchor {
  const rect = document.querySelector(".workspaces-btn")?.getBoundingClientRect();
  return { left: 0, top: (rect?.bottom ?? 80) + 6, right: rect?.right ?? window.innerWidth - 8 };
}

export function App() {
  const api = chromeApi();
  const [state, setState] = useState<WindowState | null>(null);
  const [omniOpen, setOmniOpen] = useState(false);
  const [editor, setEditor] = useState<GroupEditorState | null>(null);
  const [popover, setPopover] = useState<PopoverState>(null);
  const [findFocus, setFindFocus] = useState(0);
  const [organizer, setOrganizer] = useState(false);
  const [palette, setPalette] = useState(false);
  const [listenToken, setListenToken] = useState(0);
  const findFocusHandled = useRef(0);
  const barRef = useRef<HTMLDivElement>(null);
  const omniRef = useRef<OmniboxHandle>(null);
  // A focus request that arrives before the omnibox exists (the UI renders once state is in).
  const pendingOmniFocus = useRef<boolean | null>(null);

  useEffect(() => {
    void api.call("state.get").then(setState);
    const offState = api.onState(setState);
    const offCommand = api.onCommand((command) => {
      if (command.type === "focus-omnibox") {
        if (omniRef.current) omniRef.current.focus(command.selectAll);
        else pendingOmniFocus.current = command.selectAll;
      } else if (command.type === "close-overlays") {
        setEditor(null);
        setPopover(null);
        setOrganizer(false);
        setPalette(false);
        omniRef.current?.close();
      } else if (command.type === "open-command-palette") {
        setPalette(true);
        if (command.listen) setListenToken((n) => n + 1);
      } else if (command.type === "find-focus") {
        setFindFocus((n) => n + 1);
      } else if (command.type === "open-organizer") {
        setOrganizer((open) => !open);
      } else if (command.type === "open-downloads") {
        setBubbleAuto(false);
        setPopover({ kind: "downloads", anchor: downloadsAnchor() });
      } else if (command.type === "open-share") {
        const rect = document.querySelector(".omnibox")?.getBoundingClientRect();
        setPopover({ kind: "share", share: command.share, anchor: { left: 0, top: (rect?.bottom ?? 80) + 6, right: rect?.right ?? window.innerWidth - 8 } });
      } else if (command.type === "open-workspaces") {
        setPopover({ kind: "workspaces", anchor: workspacesAnchor() });
      } else if (command.type === "edit-group") {
        // The chip of a group created just now is not on screen yet: the editor finds it once it is.
        setEditor({ groupId: command.groupId });
      }
    });
    return () => {
      offState();
      offCommand();
    };
  }, [api]);

  // First render of a window: a new tab page starts with the caret in the omnibox.
  const ready = state !== null;
  useEffect(() => {
    if (!state) return;
    const active = state.tabs.find((t) => t.id === state.activeTabId);
    const selectAll = pendingOmniFocus.current ?? (active && isNewTabUrl(active.url) ? true : null);
    pendingOmniFocus.current = null;
    if (selectAll !== null) omniRef.current?.focus(selectAll);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);

  useLayoutEffect(() => {
    const bar = barRef.current;
    if (!bar) return;
    const observer = new ResizeObserver(() => void api.call("ui.setChromeHeight", Math.ceil(bar.getBoundingClientRect().height)));
    observer.observe(bar);
    return () => observer.disconnect();
  }, [api, state !== null]);

  const prompt = state?.permissionPrompt ?? null;
  const [extMenuOpen, setExtMenuOpen] = useState(false);
  const modalOpen = editor !== null || popover !== null || prompt !== null || organizer || palette || Boolean(state?.dialog);
  const overlayOpen = modalOpen || omniOpen || extMenuOpen;
  useEffect(() => {
    void api.call("ui.setOverlay", overlayOpen);
  }, [api, overlayOpen]);

  // Popovers belong to the tab they were opened for.
  useEffect(() => setPopover((p) => (p?.kind === "downloads" ? p : null)), [state?.activeTabId]);

  const onOmniOpen = useCallback((open: boolean) => setOmniOpen(open), []);
  const [bubbleAuto, setBubbleAuto] = useState(false);
  const closePopover = useCallback(() => {
    setPopover(null);
    setBubbleAuto(false);
  }, []);

  // Downloads: the toolbar button pulses when one starts, and the bubble opens by itself for a few
  // seconds when one the person started finishes (not the agent's, and never over another overlay).
  const [downloadPulse, setDownloadPulse] = useState(0);
  const lastDownloads = useRef<Map<string, string> | null>(null);
  const overlayBusy = useRef(false);
  overlayBusy.current = overlayOpen;
  useEffect(() => {
    if (!state) return;
    const recent = state.downloads.recent;
    const before = lastDownloads.current;
    lastDownloads.current = new Map(recent.map((d) => [d.id, d.state]));
    if (!before) return; // the first state after launch: nothing in it is new
    if (recent.some((d) => !before.has(d.id) && d.state !== "cancelled")) setDownloadPulse((n) => n + 1);
    const finished = recent.some((d) => !d.agent && d.state === "completed" && before.get(d.id) !== "completed");
    if (finished && !overlayBusy.current) {
      setBubbleAuto(true);
      setPopover({ kind: "downloads", anchor: downloadsAnchor() });
    }
  }, [state?.downloads]);
  const closePalette = useCallback(() => {
    setPalette(false);
    setListenToken(0);
  }, []);

  if (!state) return null;
  setFaviconProfile(state.profile.id, state.faviconRevision);
  const active = state.tabs.find((t) => t.id === state.activeTabId);
  const mac = state.platform === "darwin";
  const vertical = state.tabLayout === "vertical";
  const below = (rect: DOMRect): Anchor => ({ left: rect.left, top: rect.bottom + 6 });
  const tabStrip = (
    <TabStrip
      state={state}
      orientation={vertical ? "vertical" : "horizontal"}
      onEditGroup={(groupId, rect) => setEditor({ groupId, anchor: below(rect) })}
      onOrganize={() => setOrganizer(true)}
    />
  );

  return (
    <div
      className={`chrome-root ${mac ? "mac" : ""} ${vertical ? "vertical" : ""} ${vertical && state.sidebarCollapsed ? "sidebar-collapsed" : ""} ${state.privateWindow ? "private-window" : ""} ${state.maximized ? "maximized" : ""}`}
      style={vertical ? ({ "--sidebar-w": `${state.sidebarCollapsed ? 52 : state.sidebarWidth}px` } as CSSProperties) : undefined}
    >
      <div id="chrome-bar" ref={barRef}>
        {vertical && (
          <div className={`v-topbar ${mac ? "mac" : "wco"}`}>
            <button
              className="icon-btn v-collapse"
              title={state.sidebarCollapsed ? tx("Expand sidebar") : tx("Collapse sidebar")}
              onClick={() => void api.call("ui.setSidebarCollapsed", !state.sidebarCollapsed)}
            >
              <IconChevronRight size={16} />
            </button>
            <span className="v-title">{active?.title || "Corvus"}</span>
          </div>
        )}
        {!vertical && tabStrip}
        <div className="toolbar">
          <button className="icon-btn" title={tx("Back (Alt+Left)")} disabled={!active?.canGoBack} onClick={() => active && void api.call("tabs.back", active.id)}>
            <IconBack size={17} />
          </button>
          <button
            className="icon-btn"
            title={tx("Forward (Alt+Right)")}
            disabled={!active?.canGoForward}
            onClick={() => active && void api.call("tabs.forward", active.id)}
          >
            <IconForward size={17} />
          </button>
          {active?.loading ? (
            <button className="icon-btn" title={tx("Stop")} onClick={() => void api.call("tabs.stop", active.id)}>
              <IconClose size={17} />
            </button>
          ) : (
            <button className="icon-btn" title={tx("Reload (Ctrl+R)")} disabled={!active} onClick={() => active && void api.call("tabs.reload", active.id)}>
              <IconReload size={16} />
            </button>
          )}
          {state.showHomeButton && (
            <button
              className="icon-btn"
              title={tx("Home (Alt+Home)")}
              disabled={!active}
              onClick={(e) => active && void api.call("tabs.home", active.id, e.ctrlKey || e.metaKey)}
              onAuxClick={(e) => e.button === 1 && active && void api.call("tabs.home", active.id, true)}
            >
              <IconHome size={17} />
            </button>
          )}
          <Omnibox
            ref={omniRef}
            tab={active}
            translate={state.translate}
            bookmarked={state.activeBookmarked}
            zoomPercent={state.zoomPercent}
            readerable={state.readerable}
            readerActive={state.readerActive}
            autofill={state.autofill}
            autoOpen={!modalOpen && !extMenuOpen}
            onOpenChange={onOmniOpen}
            onSiteInfo={(rect) => setPopover({ kind: "site", anchor: below(rect) })}
            onZoom={(rect) => setPopover({ kind: "zoom", anchor: below(rect) })}
          />
          <div className="toolbar-actions">
            <AdblockButton
              state={state.adblock}
              onOpen={(rect) => setPopover({ kind: "adblock", anchor: { left: 0, top: rect.bottom + 6, right: rect.right } })}
            />
            {state.connection && (
              <button
                className="connection-chip"
                data-connection-chip={state.connection.name}
                title={state.connection.rule ? tx("This site goes through {name} (a site rule)", { name: state.connection.name }) : tx("Going through {name}", { name: state.connection.name })}
                onClick={(e) => {
                  const r = e.currentTarget.getBoundingClientRect();
                  void api.call("ui.connectionMenu", r.left, r.bottom + 4);
                }}
              >
                <IconGlobe size={13} />
                <span>{state.connection.name}</span>
              </button>
            )}
            <CopiedLinksChip count={state.copiedLinks} />
            <DownloadsButton
              summary={state.downloads}
              pulse={downloadPulse}
              onOpen={(rect) => {
                setBubbleAuto(false);
                setPopover({ kind: "downloads", anchor: { left: 0, top: rect.bottom + 6, right: rect.right } });
              }}
            />
            <WatchesButton watches={state.watches} onOpen={() => void api.call("tabs.openUrl", "corvus://watches/", "new-tab")} />
            <WorkspacesButton onOpen={(rect) => setPopover({ kind: "workspaces", anchor: { left: 0, top: rect.bottom + 6, right: rect.right } })} />
            {state.split?.shown && (
              <button className="icon-btn split-exit-btn on" title={tx("Exit split view")} aria-pressed onClick={() => void api.call("split.exit")}>
                <IconClose size={16} />
              </button>
            )}
            <ExtensionsToolbar partition={state.partition} tabId={active?.webContentsId ?? -1} onOpenChange={setExtMenuOpen} />
            <button
              className={`icon-btn assist-btn ${state.assistOpen ? "on" : ""}`}
              title={
                state.agentsPaused
                  ? tx("Corvus Assist (agents paused)")
                  : state.mcpRunning
                    ? tx("Corvus Assist (Ctrl+Shift+A). AI agents can connect.")
                    : tx("Corvus Assist (Ctrl+Shift+A)")
              }
              aria-pressed={state.assistOpen}
              onClick={() => void api.call("assist.toggle")}
            >
              <IconSparkle size={17} />
              {state.agentsPaused ? <span className="assist-live paused" /> : state.agentActive ? <span className="assist-live" /> : null}
            </button>
            {state.privateWindow && (
              <span className="private-badge" data-private-badge title={tx("Private window: Corvus keeps no history, cookies or site data of it once it closes")}>
                <IconLock size={13} />
                {tx("Private")}
              </span>
            )}
            <button
              className="avatar-btn"
              title={tx("Profile: {name}", { name: state.profile.name })}
              style={{ background: state.profile.avatar ?? "var(--accent)" }}
              onClick={(e) => {
                const r = e.currentTarget.getBoundingClientRect();
                void api.call("ui.profileMenu", r.left, r.bottom + 4);
              }}
            >
              {state.profile.name.charAt(0).toUpperCase()}
            </button>
            <button
              className="icon-btn"
              title={tx("Customize and control Corvus")}
              onClick={(e) => {
                const r = e.currentTarget.getBoundingClientRect();
                void api.call("ui.appMenu", r.left, r.bottom + 4);
              }}
            >
              <IconMenu size={18} />
            </button>
          </div>
        </div>
        {state.showBookmarksBar && <BookmarksBar state={state} />}
        {state.defaultBrowserOffer && <DefaultBrowserBar />}
        {state.dialogBars.length > 0 && <DialogBars bars={state.dialogBars} />}
        {state.find && active && (
          <FindBar key={active.id} find={state.find} focusToken={findFocus} focusHandled={findFocusHandled} />
        )}
      </div>
      {vertical && (
        <aside className="v-sidebar">
          {tabStrip}
          {!state.sidebarCollapsed && <SidebarResize width={state.sidebarWidth} />}
        </aside>
      )}
      {overlayOpen && (
        <div
          className={`overlay-backdrop ${modalOpen ? "modal" : ""}`}
          onMouseDown={() => {
            setEditor(null);
            setPopover(null);
            setOrganizer(false);
            setPalette(false);
            omniRef.current?.close();
            if (prompt) void api.call("permissions.respond", prompt.id, "dismiss", false);
          }}
        />
      )}
      {palette && <DebugBoundary><CommandBar state={state} onClose={closePalette} listenToken={listenToken} onOrganize={() => { setPalette(false); setOrganizer(true); }} /></DebugBoundary>}
      {editor && <GroupEditor state={state} editor={editor} onClose={() => setEditor(null)} />}
      {prompt && <PermissionPrompt key={prompt.id} prompt={prompt} anchor={omniboxAnchor()} />}
      {state.dialog && <DialogModal key={state.dialog.id} view={state.dialog} />}
      {popover?.kind === "site" && <SiteInfoPopover anchor={popover.anchor} onClose={closePopover} />}
      {popover?.kind === "zoom" && <ZoomPopover anchor={popover.anchor} percent={state.zoomPercent} />}
      {organizer && <Organizer dark={state.dark} tabCount={state.tabs.length} onClose={() => setOrganizer(false)} />}
      {popover?.kind === "downloads" && <DownloadsBubble summary={state.downloads} anchor={popover.anchor} autoCloseMs={bubbleAuto ? 6000 : undefined} onClose={closePopover} />}
      {popover?.kind === "adblock" && <AdblockPopover state={state.adblock} anchor={popover.anchor} onClose={closePopover} />}
      {popover?.kind === "share" && <SharePopover share={popover.share} anchor={popover.anchor} onClose={closePopover} />}
      {popover?.kind === "workspaces" && (
        <WorkspacesPopover anchor={popover.anchor} saveCount={state.tabs.filter((t) => isWorkspaceTabUrl(t.url)).length} onClose={closePopover} />
      )}
    </div>
  );
}

/** Drag handle on the vertical sidebar's right edge; commits the new width (throttled) while dragging. */
function SidebarResize({ width }: { width: number }) {
  const api = chromeApi();
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = width;
    let last = 0;
    const onMove = (ev: PointerEvent): void => {
      const next = Math.max(180, Math.min(480, Math.round(startWidth + (ev.clientX - startX))));
      const now = Date.now();
      if (now - last < 40) return;
      last = now;
      void api.call("ui.setSidebarWidth", next);
    };
    const onUp = (ev: PointerEvent): void => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      void api.call("ui.setSidebarWidth", Math.max(180, Math.min(480, Math.round(startWidth + (ev.clientX - startX)))));
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };
  return <div className="sidebar-resize" onPointerDown={onPointerDown} title={tx("Drag to resize")} />;
}

class DebugBoundary extends Component<{ children: ReactNode }, { err: boolean }> {
  state = { err: false };
  static getDerivedStateFromError() {
    return { err: true };
  }
  componentDidCatch(error: Error) {
    console.error(`Command bar render error: ${error.message}`);
  }
  render() {
    return this.state.err ? null : this.props.children;
  }
}

/** Where a drag over the bookmarks bar lands. */
interface BarDrop {
  /** Before the bar's item at this index (the number shown: after the last one); with `into`, into that folder. */
  slot: number;
  into: boolean;
}

/**
 * Where a drop at `clientX` lands among the bar's `shown` items (the rest are under "»"): into a
 * folder when on its middle (with `intoFolders`, as on the bookmarks page), else before the first
 * item whose middle is right of it, else after the last one shown.
 */
function barDrop(bar: HTMLElement, clientX: number, shown: number, intoFolders: boolean): BarDrop {
  const items = [...bar.querySelectorAll<HTMLElement>("[data-bar-index]")].filter((el) => Number(el.dataset.barIndex) < shown);
  const folder = intoFolders
    ? items.find((el) => {
        if (el.dataset.barFolder === undefined) return false;
        const r = el.getBoundingClientRect();
        const at = (clientX - r.left) / r.width;
        return at > 0.28 && at < 0.72;
      })
    : undefined;
  if (folder) return { slot: Number(folder.dataset.barIndex), into: true };
  const hit = items.find((el) => {
    const r = el.getBoundingClientRect();
    return clientX < r.left + r.width / 2;
  });
  return { slot: hit ? Number(hit.dataset.barIndex) : shown, into: false };
}

/** The page a drop carries: the site chip's `{ url, title }`, else the first link of a uri-list. */
function droppedPage(data: DataTransfer): { url: string; title: string } | null {
  try {
    const page = JSON.parse(data.getData(PAGE_DRAG_MIME) || "null") as { url?: unknown; title?: unknown } | null;
    if (page && typeof page.url === "string") return { url: page.url, title: typeof page.title === "string" ? page.title : "" };
  } catch {
    // Not ours: read it as a link.
  }
  const url = data.getData("text/uri-list").split(/\r?\n/).find((line) => line.trim() && !line.startsWith("#"));
  return url ? { url: url.trim(), title: "" } : null;
}

function BookmarksBar({ state }: { state: WindowState }) {
  const api = chromeApi();
  const [drop, setDrop] = useState<BarDrop | null>(null);
  /** The bar's own item being dragged along it (a drag from the bookmarks page has none). */
  const [dragging, setDragging] = useState<string | null>(null);
  const count = state.bookmarksBar.length;
  // Items that do not fit stay laid out but hidden; "»" lists them, and All bookmarks stays put.
  const itemsRef = useRef<HTMLDivElement>(null);
  const [fits, setFits] = useState(count);
  useLayoutEffect(() => {
    const box = itemsRef.current;
    if (!box) return;
    const measure = (): void => {
      const limit = box.clientWidth;
      const items = [...box.querySelectorAll<HTMLElement>("[data-bar-index]")];
      const first = items.findIndex((el) => el.offsetLeft + el.offsetWidth > limit);
      setFits(first < 0 ? items.length : first);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(box);
    return () => observer.disconnect();
  }, [count, state.bookmarksBar]);
  const carriesPage = (e: DragEvent<HTMLElement>): boolean => e.dataTransfer.types.includes(PAGE_DRAG_MIME) || e.dataTransfer.types.includes("text/uri-list");
  const carriesBookmark = (e: DragEvent<HTMLElement>): boolean => e.dataTransfer.types.includes(BOOKMARK_DRAG_MIME);
  // Dropping an item back where it is changes nothing, so it shows no marker.
  const from = dragging === null ? -1 : state.bookmarksBar.findIndex((b) => b.id === dragging);
  const stays = (at: BarDrop): boolean => from >= 0 && (at.into ? at.slot === from : at.slot === from || at.slot === from + 1);
  const shown = drop && !stays(drop) ? drop : null;
  const marker = (i: number): string => {
    if (!shown) return "";
    if (shown.into) return shown.slot === i ? "drop-into" : "";
    if (shown.slot === i && i < fits) return "drop-before";
    return shown.slot >= fits && i === fits - 1 ? "drop-after" : "";
  };
  const endDrag = (): void => {
    setDragging(null);
    setDrop(null);
  };
  /** A bookmark dropped on the bar: moved there with bookmarks.move, as the bookmarks page moves it. */
  const moveTo = (id: string, at: BarDrop): void => {
    if (!id || stays(at)) return;
    const folder = at.into ? state.bookmarksBar[at.slot] : undefined;
    const move = folder
      ? api.call("bookmarks.move", id, folder.id)
      : api.call("bookmarks.move", id, BAR_FOLDER_ID, dropMoveIndex(state.bookmarksBar, id, at.slot));
    // A bookmark that went away meanwhile, or a folder dropped into itself: nothing moves.
    void move.catch(() => undefined);
  };
  /** What every item shares: dragging it along the bar, its drop marker, hiding it under "»". */
  const itemProps = (b: Bookmark, i: number) => ({
    "data-bar-index": i,
    "data-bookmark-id": b.id,
    className: `bar-item ${marker(i)} ${dragging === b.id ? "dragging" : ""} ${i >= fits ? "bar-hidden" : ""}`,
    tabIndex: i >= fits ? -1 : undefined,
    draggable: true,
    onDragStart: (e: DragEvent<HTMLElement>) => {
      e.dataTransfer.setData(BOOKMARK_DRAG_MIME, b.id);
      // A bookmark also drags as its link (into a page, the address bar or another app).
      if (b.url) {
        e.dataTransfer.setData("text/uri-list", b.url);
        e.dataTransfer.setData("text/plain", b.url);
      }
      e.dataTransfer.effectAllowed = "copyMove";
      setDragging(b.id);
    },
    onDragEnd: endDrag,
    onContextMenu: (e: ReactMouseEvent<HTMLElement>) => {
      e.preventDefault();
      void api.call("ui.bookmarkMenu", b.id, e.clientX, e.clientY);
    },
  });
  return (
    <div
      className={`bookmarks-bar ${shown ? "dropping" : ""}`}
      onDragOver={(e) => {
        const moving = carriesBookmark(e);
        if (!moving && !carriesPage(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = moving ? "move" : "copy";
        const at = barDrop(e.currentTarget, e.clientX, fits, moving);
        if (drop?.slot !== at.slot || drop.into !== at.into) setDrop(at);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDrop(null);
      }}
      onDrop={(e) => {
        const moving = carriesBookmark(e);
        if (!moving && !carriesPage(e)) return;
        e.preventDefault();
        // Where it lands is read from the drop itself (the last dragover may not have rendered yet).
        const at = barDrop(e.currentTarget, e.clientX, fits, moving);
        endDrag();
        if (moving) return moveTo(e.dataTransfer.getData(BOOKMARK_DRAG_MIME), at);
        const page = droppedPage(e.dataTransfer);
        if (page) void api.call("bookmarks.addToBar", page.url, page.title, at.slot);
      }}
    >
      {count === 0 && <span className="bar-empty">{shown ? tx("Drop to bookmark this page") : tx("Bookmark pages with the star in the address bar, or drag the lock here.")}</span>}
      <div className="bar-items" ref={itemsRef}>
      {state.bookmarksBar.map((b, i) =>
        b.kind === "folder" ? (
          <button
            key={b.id}
            {...itemProps(b, i)}
            data-bar-folder=""
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              void api.call("ui.bookmarkFolderMenu", b.id, r.left, r.bottom + 2);
            }}
            // A middle click opens the folder's bookmarks in background tabs, as in Chrome.
            onAuxClick={(e) => e.button === 1 && void api.call("bookmarks.openFolder", b.id)}
          >
            <IconFolder size={14} />
            <span>{b.title}</span>
          </button>
        ) : (
          <button
            key={b.id}
            {...itemProps(b, i)}
            title={`${b.title}\n${b.url ?? ""}`}
            onClick={(e) => b.url && void api.call("tabs.openUrl", b.url, e.ctrlKey || e.metaKey ? "background-tab" : "current")}
            onAuxClick={(e) => e.button === 1 && b.url && void api.call("tabs.openUrl", b.url, "background-tab")}
          >
            <Favicon url={b.url ?? ""} size={14} />
            <span>{b.title || b.url}</span>
          </button>
        ),
      )}
      </div>
      {fits < count && (
        <button
          className="bar-item bar-more"
          title={tx("More bookmarks")}
          aria-label={tx("More bookmarks")}
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            const hidden = state.bookmarksBar.slice(fits).map((bookmark, i) => ({ bookmark, index: fits + i }));
            // The menu shows the icons the bar shows for them (drawn here: menu-icons.ts).
            void barMenuIcons(itemsRef.current, hidden)
              .catch((): Record<string, string> => ({}))
              .then((icons) => api.call("ui.bookmarkOverflowMenu", fits, r.left, r.bottom + 2, icons));
          }}
        >
          »
        </button>
      )}
      <button className="bar-item bar-all" onClick={() => void api.call("tabs.openUrl", "corvus://bookmarks/", "new-tab")}>
        <IconFolder size={14} />
        <span>{tx("All bookmarks")}</span>
      </button>
    </div>
  );
}

function GroupEditor({ state, editor, onClose }: { state: WindowState; editor: GroupEditorState; onClose: () => void }) {
  const api = chromeApi();
  const group = state.groups.find((g) => g.id === editor.groupId);
  const [title, setTitle] = useState(group?.title ?? "");
  const inputRef = useRef<HTMLInputElement>(null);
  const [workspaceName, setWorkspaceName] = useState<string | null>(null);
  const [anchor, setAnchor] = useState<Anchor | null>(editor.anchor ?? null);
  const workspaceId = group?.workspaceId;

  useLayoutEffect(() => {
    if (anchor || !group) return;
    const rect = document.querySelector(`[data-group-id="${CSS.escape(group.id)}"]`)?.getBoundingClientRect();
    setAnchor({ left: rect?.left ?? 80, top: (rect?.bottom ?? 36) + 6 });
  }, [anchor, group]);
  useEffect(() => {
    if (!workspaceId) {
      setWorkspaceName(null);
      return;
    }
    void api.call("workspaces.list").then((list) => setWorkspaceName(list.find((w) => w.id === workspaceId)?.name ?? null));
  }, [api, workspaceId]);

  // The caret goes to the name, and stays there when the chrome UI gets the keyboard a moment later
  // (a group made from the tab menu: the window focus lands after the editor opened).
  useEffect(() => {
    const focus = (): void => {
      inputRef.current?.focus();
      inputRef.current?.select();
    };
    focus();
    const frame = requestAnimationFrame(focus);
    window.addEventListener("focus", focus, { once: true });
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("focus", focus);
    };
  }, []);

  useEffect(() => {
    if (!group) onClose();
  }, [group, onClose]);
  if (!group) return null;

  const saveTitle = (): void => {
    if (title !== group.title) void api.call("groups.update", group.id, { title });
  };
  const setColor = (color: GroupColor): void => void api.call("groups.update", group.id, { color });
  const saveCount = state.tabs.filter((t) => t.groupId === group.id && isWorkspaceTabUrl(t.url)).length;
  // Placed before the first paint (layout effect above), so it never shows at the fallback spot.
  const left = Math.min(anchor?.left ?? 80, window.innerWidth - 270);

  return (
    <div className="group-editor" style={{ left, top: anchor?.top ?? 42 }} onMouseDown={(e) => e.stopPropagation()}>
      <input
        ref={inputRef}
        className="input"
        placeholder={tx("Name this group")}
        value={title}
        maxLength={80}
        onChange={(e) => setTitle(e.target.value)}
        onBlur={saveTitle}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === "Escape") {
            saveTitle();
            onClose();
          }
        }}
      />
      <div className="color-row">
        {GROUP_COLORS.map((c) => (
          <button
            key={c}
            className={`color-dot ${group.color === c ? "selected" : ""}`}
            title={c}
            style={{ "--dot": GROUP_COLOR_HEX[c][state.dark ? "dark" : "light"] } as CSSProperties}
            onClick={() => setColor(c)}
          />
        ))}
      </div>
      <div className="editor-actions">
        <button className="menu-row" onClick={() => {
          void api.call("groups.newTab", group.id);
          onClose();
        }}>{tx("New tab in group")}</button>
        <button
          className="menu-row ws-group-save"
          disabled={saveCount === 0}
          title={
            workspaceName
              ? tx("Save this group's current tabs to the workspace “{workspaceName}”", { workspaceName })
              : tx("Save this group's tabs as a workspace you can reopen later")
          }
          onClick={() => {
            saveTitle();
            void api.call("workspaces.saveGroup", group.id);
            onClose();
          }}
        >
          {workspaceName ? tx("Update workspace") : tx("Save group as workspace")}
          <span className="muted">{" "}{saveCount === 1 ? tx("· 1 tab") : tx("· {saveCount} tabs", { saveCount })}</span>
        </button>
        <button className="menu-row" onClick={() => {
          void api.call("groups.ungroup", group.id);
          onClose();
        }}>{tx("Ungroup")}</button>
        <button className="menu-row danger" onClick={() => {
          void api.call("groups.close", group.id);
          onClose();
        }}>{tx("Close group")}</button>
      </div>
    </div>
  );
}
