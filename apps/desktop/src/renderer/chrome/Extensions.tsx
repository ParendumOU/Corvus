import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ToolbarExtension } from "../../shared/ipc";
import { chromeApi } from "../common/api";
import { IconMore, IconPin, IconPuzzle } from "../common/icons";

import { t } from "../common/i18n";
/** Per-tab overrides and defaults of an extension action, as tracked by electron-chrome-extensions. */
interface ActionDetails {
  title?: string;
  text?: string;
  color?: string | number[];
  popup?: string;
  iconModified?: number;
}
interface ActionState extends ActionDetails {
  id: string;
  tabs: Record<string, ActionDetails>;
}
interface ActionsSnapshot {
  activeTabId?: number;
  actions: ActionState[];
}
interface AnchorRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Exposed in the chrome UI by electron-chrome-extensions' injectBrowserAction() (preload). */
interface BrowserActionBridge {
  getState(partition: string): Promise<ActionsSnapshot>;
  activate(
    partition: string,
    details: { eventType: "click"; extensionId: string; tabId: number; alignment: string; anchorRect: AnchorRect },
  ): Promise<void>;
  addEventListener(name: "update", listener: (state: ActionsSnapshot) => void): void;
  removeEventListener(name: "update", listener: (state: ActionsSnapshot) => void): void;
  addObserver(partition: string): void;
  removeObserver(partition: string): void;
}

declare global {
  interface Window {
    browserAction?: BrowserActionBridge;
  }
}

function cssColor(color: ActionDetails["color"]): string {
  if (Array.isArray(color) && color.length >= 3) return `rgba(${color[0]}, ${color[1]}, ${color[2]}, ${(color[3] ?? 255) / 255})`;
  return typeof color === "string" && color ? color : "#5f6368";
}

function anchorOf(el: Element): AnchorRect {
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.top, width: r.width, height: r.height };
}

function ExtensionIcon({ src, fallback, size = 16 }: { src: string; fallback: string; size?: number }) {
  const [current, setCurrent] = useState(src || fallback);
  useEffect(() => setCurrent(src || fallback), [src, fallback]);
  if (!current) return <IconPuzzle size={size} />;
  return (
    <img
      className="ext-icon-img"
      src={current}
      width={size}
      height={size}
      alt=""
      draggable={false}
      onError={() => setCurrent((c) => (c === fallback ? "" : fallback))}
    />
  );
}

/** Pinned extension actions plus the puzzle menu (all extensions, pin/unpin, manage). */
export function ExtensionsToolbar({
  partition,
  tabId,
  onOpenChange,
}: {
  partition: string;
  tabId: number;
  onOpenChange: (open: boolean) => void;
}) {
  const api = chromeApi();
  const [items, setItems] = useState<ToolbarExtension[]>([]);
  const [actions, setActions] = useState<Map<string, ActionState>>(new Map());
  const [menu, setMenu] = useState<{ right: number; top: number } | null>(null);
  const puzzleRef = useRef<HTMLButtonElement>(null);

  const refresh = useCallback(() => void api.call("extensions.toolbar").then(setItems), [api]);

  useEffect(() => {
    refresh();
    return api.onCommand((command) => {
      if (command.type === "extensions-changed") refresh();
      else if (command.type === "close-overlays") setMenu(null);
      else if (command.type === "activate-extension") {
        // The pinned button, else the extensions menu button, anchors the popup.
        const button = document.querySelector(`.ext-action[data-extension-id="${CSS.escape(command.extensionId)}"]`) ?? puzzleRef.current;
        if (button) activateRef.current(command.extensionId, anchorOf(button));
      }
    });
  }, [api, refresh]);

  useEffect(() => {
    const bridge = window.browserAction;
    if (!bridge) return;
    const onUpdate = (snapshot: ActionsSnapshot): void => setActions(new Map(snapshot.actions.map((a) => [a.id, a])));
    bridge.addEventListener("update", onUpdate);
    bridge.addObserver(partition);
    void bridge.getState(partition).then(onUpdate);
    return () => {
      bridge.removeEventListener("update", onUpdate);
      bridge.removeObserver(partition);
    };
  }, [partition]);

  useEffect(() => onOpenChange(menu !== null), [menu, onOpenChange]);

  const activate = (id: string, anchor: AnchorRect): void => {
    void window.browserAction?.activate(partition, { eventType: "click", extensionId: id, tabId, alignment: "bottom left", anchorRect: anchor });
  };
  // The command listener above is set up once; it activates with the current tab through this.
  const activateRef = useRef(activate);
  activateRef.current = activate;
  const openMenu = (id: string, x: number, y: number): void => void api.call("extensions.menu", id, x, y);
  const openUrl = (url: string): void => {
    setMenu(null);
    void api.call("tabs.openUrl", url, "new-tab");
  };

  const pinned = items.filter((i) => i.pinned && i.hasAction);

  return (
    <>
      <div className="ext-pinned">
        {pinned.map((item) => {
          const action = actions.get(item.id);
          const perTab = action?.tabs[String(tabId)] ?? {};
          const text = perTab.text ?? action?.text;
          const iconModified = perTab.iconModified ?? action?.iconModified;
          const query = new URLSearchParams({ tabId: String(tabId), partition, ...(iconModified ? { t: String(iconModified) } : {}) });
          return (
            <button
              key={item.id}
              className="icon-btn ext-action"
              data-extension-id={item.id}
              title={perTab.title ?? action?.title ?? item.name}
              onClick={(e) => activate(item.id, anchorOf(e.currentTarget))}
              onContextMenu={(e) => {
                e.preventDefault();
                openMenu(item.id, e.clientX, e.clientY);
              }}
            >
              <ExtensionIcon src={action ?`crx://extension-icon/${item.id}/32/2?${query.toString()}` : ""} fallback={item.iconUrl} />
              {text && (
                <span className="ext-badge" style={{ background: cssColor(perTab.color ?? action?.color) }}>
                  {text}
                </span>
              )}
            </button>
          );
        })}
      </div>
      <button
        ref={puzzleRef}
        className={`icon-btn ext-puzzle ${menu ? "active" : ""}`}
        title={t("Extensions")}
        onClick={(e) => {
          if (menu) {
            setMenu(null);
            return;
          }
          const r = e.currentTarget.getBoundingClientRect();
          refresh();
          setMenu({ right: Math.max(8, window.innerWidth - r.right), top: r.bottom + 4 });
        }}
      >
        <IconPuzzle size={16} />
      </button>
      {menu &&
        createPortal(
          <>
            <div className="ext-menu-backdrop" onMouseDown={() => setMenu(null)} />
            <div className="ext-menu" role="menu" style={{ right: menu.right, top: menu.top }}>
              <div className="ext-menu-head">{t("Extensions")}</div>
              {items.length === 0 && <div className="ext-menu-empty">{t("No extensions are enabled in this profile.")}</div>}
              {items.map((item) => (
                <div key={item.id} className="ext-menu-row" data-extension-id={item.id}>
                  <button
                    className="ext-menu-main"
                    title={item.hasAction ? t("Open {name}", { name: item.name }) : item.name}
                    onClick={(e) => {
                      const anchor = puzzleRef.current ? anchorOf(puzzleRef.current) : anchorOf(e.currentTarget);
                      setMenu(null);
                      if (item.hasAction) activate(item.id, anchor);
                      else openMenu(item.id, anchor.x, anchor.y + anchor.height);
                    }}
                  >
                    <ExtensionIcon src="" fallback={item.iconUrl} />
                    <span>{item.name}</span>
                  </button>
                  <button
                    className={`icon-btn ext-pin ${item.pinned ? "on" : ""}`}
                    title={item.pinned ? t("Unpin from toolbar") : t("Pin to toolbar")}
                    aria-pressed={item.pinned}
                    disabled={!item.hasAction}
                    onClick={() => void api.call("extensions.setPinned", item.id, !item.pinned).then(refresh)}
                  >
                    <IconPin size={14} />
                  </button>
                  <button
                    className="icon-btn"
                    title={t("More actions")}
                    onClick={(e) => {
                      const r = e.currentTarget.getBoundingClientRect();
                      openMenu(item.id, r.left, r.bottom);
                    }}
                  >
                    <IconMore size={14} />
                  </button>
                </div>
              ))}
              <div className="ext-menu-sep" />
              <button className="menu-row" onClick={() => openUrl("corvus://extensions/")}>{t("Manage extensions")}</button>
              <button className="menu-row" onClick={() => openUrl("https://chromewebstore.google.com/")}>{t("Chrome Web Store")}</button>
            </div>
          </>,
          document.body,
        )}
    </>
  );
}
