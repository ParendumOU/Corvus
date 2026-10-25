import { useState, type CSSProperties, type DragEvent, type MouseEvent } from "react";
import type { TabGroup } from "@corvus/shared";
import { GROUP_COLOR_HEX, type TabView, type WindowState } from "../../shared/ipc";
import { computeDropTarget, type TabStripState } from "../../shared/tab-strip";
import { buildStripRows } from "../../shared/tab-strip-view";
import { chromeApi } from "../common/api";
import { IconChevronDown, IconChevronRight, IconClose, IconPlus, IconSparkle, IconVolume } from "../common/icons";
import { Favicon } from "../common/ui";
import { formatMemory } from "../../shared/tab-sleep";

import { t as tx } from "../common/i18n";
/** A tab's hover text: its title, then who drives it, whether it sleeps, or what memory it uses. */
function tabTooltip(tab: TabView): string {
  const lines = [tab.title || tab.url];
  if (tab.container) lines.push(tx("Container: {name}", { name: tab.container.name }));
  if (tab.inSplit) lines.push(tx("In split view: shows with the other tabs of the split"));
  if (tab.agentControlled) lines.push(tx("Controlled by an AI agent"));
  if (tab.sleeping) lines.push(tx("Sleeping to save memory: it wakes up where it was"));
  else if (tab.memoryKB) lines.push(tx("Memory: {memoryKB}", { memoryKB: formatMemory(tab.memoryKB) }));
  return lines.join("\n");
}

/** A container tab's coloured line under its icon. */
function ContainerMark({ tab }: { tab: TabView }) {
  if (!tab.container) return null;
  const hex = GROUP_COLOR_HEX[tab.container.color];
  return <span className="tab-container-mark" style={{ "--c-light": hex.light, "--c-dark": hex.dark } as CSSProperties} />;
}

const TAB_MIME = "application/x-corvus-tab";
const GROUP_MIME = "application/x-corvus-group";

type DropHint = { id: string; side: "before" | "after" } | null;

function toStrip(state: WindowState): TabStripState {
  return {
    tabs: state.tabs.map((t) => ({ id: t.id, pinned: t.pinned, ...(t.groupId ? { groupId: t.groupId } : {}) })),
    groups: state.groups,
    activeId: state.activeTabId,
  };
}

function groupColor(group: TabGroup | undefined, dark: boolean): string | undefined {
  return group ? GROUP_COLOR_HEX[group.color][dark ? "dark" : "light"] : undefined;
}

export function TabStrip(props: {
  state: WindowState;
  orientation?: "horizontal" | "vertical";
  onEditGroup: (groupId: string, rect: DOMRect) => void;
  onOrganize?: () => void;
}) {
  if (props.orientation === "vertical") return <VerticalTabStrip {...props} />;
  return <HorizontalTabStrip {...props} />;
}

function HorizontalTabStrip({
  state,
  onEditGroup,
  onOrganize,
}: {
  state: WindowState;
  onEditGroup: (groupId: string, rect: DOMRect) => void;
  onOrganize?: () => void;
}) {
  const [hint, setHint] = useState<DropHint>(null);
  const api = chromeApi();
  const groupsById = new Map(state.groups.map((g) => [g.id, g]));
  const mac = state.platform === "darwin";

  const sideOf = (e: DragEvent<HTMLElement>): "before" | "after" => {
    const rect = e.currentTarget.getBoundingClientRect();
    return e.clientX < rect.left + rect.width / 2 ? "before" : "after";
  };

  const onTabDragOver = (e: DragEvent<HTMLDivElement>, tab: TabView): void => {
    if (!e.dataTransfer.types.includes(TAB_MIME) && !e.dataTransfer.types.includes(GROUP_MIME)) return;
    e.preventDefault();
    e.stopPropagation();
    const side = sideOf(e);
    if (hint?.id !== tab.id || hint.side !== side) setHint({ id: tab.id, side });
  };

  const onTabDrop = (e: DragEvent<HTMLDivElement>, tab: TabView): void => {
    e.preventDefault();
    e.stopPropagation();
    setHint(null);
    const side = sideOf(e);
    const draggedTab = e.dataTransfer.getData(TAB_MIME);
    const draggedGroup = e.dataTransfer.getData(GROUP_MIME);
    if (draggedTab && draggedTab !== tab.id) {
      const target = computeDropTarget(toStrip(state), draggedTab, tab.id, side);
      if (target) void api.call("tabs.move", draggedTab, target.toIndex, target.groupId);
    } else if (draggedGroup && tab.groupId !== draggedGroup) {
      const over = state.tabs.findIndex((t) => t.id === tab.id);
      const before = state.tabs.slice(0, over + (side === "after" ? 1 : 0)).filter((t) => t.groupId !== draggedGroup).length;
      void api.call("groups.move", draggedGroup, before);
    }
  };

  const onStripDrop = (e: DragEvent<HTMLDivElement>): void => {
    e.preventDefault();
    setHint(null);
    const draggedTab = e.dataTransfer.getData(TAB_MIME);
    const draggedGroup = e.dataTransfer.getData(GROUP_MIME);
    if (draggedTab) void api.call("tabs.move", draggedTab, state.tabs.length, null);
    else if (draggedGroup) void api.call("groups.move", draggedGroup, state.tabs.length);
  };

  const onChipDrop = (e: DragEvent<HTMLDivElement>, group: TabGroup): void => {
    e.preventDefault();
    e.stopPropagation();
    setHint(null);
    const draggedTab = e.dataTransfer.getData(TAB_MIME);
    if (!draggedTab) return;
    const from = state.tabs.findIndex((t) => t.id === draggedTab);
    let first = state.tabs.findIndex((t) => t.groupId === group.id);
    if (from !== -1 && from < first) first -= 1;
    void api.call("tabs.move", draggedTab, Math.max(0, first), group.id);
  };

  const working = new Set(state.agentGroups);
  const items: JSX.Element[] = [];
  let lastGroup: string | undefined;
  for (const tab of state.tabs) {
    const group = tab.groupId ? groupsById.get(tab.groupId) : undefined;
    if (group && group.id !== lastGroup) {
      const color = groupColor(group, state.dark);
      items.push(
        <div
          key={`group-${group.id}`}
          data-group-id={group.id}
          className={`group-chip ${group.collapsed ? "collapsed" : ""} ${group.title ? "" : "untitled"} ${working.has(group.id) ? "agent-working" : ""}`}
          style={{ "--group-color": color } as CSSProperties}
          draggable
          title={working.has(group.id) ? tx("Corvus is working in these tabs") : group.title || tx("Unnamed group")}
          onDragStart={(e) => {
            e.dataTransfer.setData(GROUP_MIME, group.id);
            e.dataTransfer.effectAllowed = "move";
          }}
          onDragOver={(e) => {
            if (e.dataTransfer.types.includes(TAB_MIME)) e.preventDefault();
          }}
          onDrop={(e) => onChipDrop(e, group)}
          onClick={() => void api.call("groups.update", group.id, { collapsed: !group.collapsed })}
          onContextMenu={(e) => {
            e.preventDefault();
            onEditGroup(group.id, e.currentTarget.getBoundingClientRect());
          }}
        >
          {group.title || ""}
        </div>,
      );
    }
    lastGroup = group?.id;
    if (group?.collapsed && !tab.active) continue;
    items.push(
      <Tab
        key={tab.id}
        tab={tab}
        color={groupColor(group, state.dark)}
        hint={hint?.id === tab.id ? hint.side : null}
        onDragOver={(e) => onTabDragOver(e, tab)}
        onDrop={(e) => onTabDrop(e, tab)}
      />,
    );
  }

  return (
    <div
      className={`tab-strip ${mac ? "mac" : "wco"}`}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes(TAB_MIME) || e.dataTransfer.types.includes(GROUP_MIME)) e.preventDefault();
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setHint(null);
      }}
      onDrop={onStripDrop}
      onDoubleClick={(e) => {
        if (e.target === e.currentTarget) void api.call("tabs.create");
      }}
    >
      <div className="tabs" role="tablist">
        {items}
        <button className="icon-btn new-tab-btn" title={tx("New tab (Ctrl+T)")} onClick={() => void api.call("tabs.create")}>
          <IconPlus size={16} />
        </button>
      </div>
      <div className="strip-drag" />
      {onOrganize && state.tabs.length > 1 && (
        <button className="icon-btn organize-btn" title={tx("Organize tabs (Ctrl+Shift+O)")} onClick={onOrganize}>
          <IconSparkle size={15} />
        </button>
      )}
    </div>
  );
}

function Tab({
  tab,
  color,
  hint,
  onDragOver,
  onDrop,
}: {
  tab: TabView;
  color: string | undefined;
  hint: "before" | "after" | null;
  onDragOver: (e: DragEvent<HTMLDivElement>) => void;
  onDrop: (e: DragEvent<HTMLDivElement>) => void;
}) {
  const api = chromeApi();
  const close = (e: MouseEvent): void => {
    e.stopPropagation();
    void api.call("tabs.close", tab.id);
  };
  const classes = [
    "tab",
    tab.active ? "active" : "",
    tab.pinned ? "pinned" : "",
    color ? "grouped" : "",
    tab.agentControlled ? "agent" : "",
    tab.sleeping ? "sleeping" : "",
    tab.inSplit ? "in-split" : "",
    hint ? `drop-${hint}` : "",
  ].join(" ");

  return (
    <div
      className={classes}
      role="tab"
      aria-selected={tab.active}
      title={tabTooltip(tab)}
      style={{ "--group-color": color } as CSSProperties}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(TAB_MIME, tab.id);
        e.dataTransfer.effectAllowed = "move";
      }}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onMouseDown={(e) => {
        if (e.button === 0) void api.call("tabs.activate", tab.id);
      }}
      onAuxClick={(e) => {
        if (e.button === 1) close(e);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        void api.call("ui.tabMenu", tab.id, e.clientX, e.clientY);
      }}
    >
      <span className="tab-icon">
        {tab.loading ? <span className="spinner" /> : <Favicon url={tab.url} src={tab.faviconUrl} />}
        <ContainerMark tab={tab} />
      </span>
      {!tab.pinned && <span className="tab-title">{tab.title || tab.url}</span>}
      {tab.audible && <IconVolume size={14} className="tab-audio" />}
      {tab.agentControlled && <span className="ai-badge">{tx("AI")}</span>}
      {!tab.pinned && (
        <button className="tab-close" title={tx("Close tab")} onMouseDown={(e) => e.stopPropagation()} onClick={close}>
          <IconClose size={24} />
        </button>
      )}
    </div>
  );
}

// --------------------------------------------------------------- vertical sidebar

function VerticalTabStrip({
  state,
  onEditGroup,
}: {
  state: WindowState;
  onEditGroup: (groupId: string, rect: DOMRect) => void;
}) {
  const api = chromeApi();
  const [hint, setHint] = useState<DropHint>(null);
  const collapsed = state.sidebarCollapsed;
  const pinned = state.tabs.filter((t) => t.pinned);
  const rows = buildStripRows(
    state.tabs.filter((t) => !t.pinned).map((t) => ({ id: t.id, pinned: t.pinned, ...(t.groupId ? { groupId: t.groupId } : {}), active: t.active })),
    state.groups,
  );
  const tabById = new Map(state.tabs.map((t) => [t.id, t]));

  const sideOf = (e: DragEvent<HTMLElement>): "before" | "after" => {
    const rect = e.currentTarget.getBoundingClientRect();
    return e.clientY < rect.top + rect.height / 2 ? "before" : "after";
  };
  const onTabDragOver = (e: DragEvent<HTMLElement>, id: string): void => {
    if (!e.dataTransfer.types.includes(TAB_MIME)) return;
    e.preventDefault();
    e.stopPropagation();
    const side = sideOf(e);
    if (hint?.id !== id || hint.side !== side) setHint({ id, side });
  };
  const onTabDrop = (e: DragEvent<HTMLElement>, overId: string): void => {
    e.preventDefault();
    e.stopPropagation();
    setHint(null);
    const dragged = e.dataTransfer.getData(TAB_MIME);
    if (!dragged || dragged === overId) return;
    const target = computeDropTarget(toStrip(state), dragged, overId, sideOf(e));
    if (target) void api.call("tabs.move", dragged, target.toIndex, target.groupId);
  };

  return (
    <div
      className={`v-tabs ${collapsed ? "collapsed" : ""}`}
      role="tablist"
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes(TAB_MIME)) e.preventDefault();
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setHint(null);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setHint(null);
        const dragged = e.dataTransfer.getData(TAB_MIME);
        if (dragged) void api.call("tabs.move", dragged, state.tabs.length, null);
      }}
    >
      {pinned.length > 0 && (
        <div className="v-pinned">
          {pinned.map((tab) => (
            <VTab key={tab.id} tab={tab} dark={state.dark} hint={hint?.id === tab.id ? hint.side : null} onDragOver={onTabDragOver} onDrop={onTabDrop} />
          ))}
        </div>
      )}
      {rows.map((row) => {
        if (row.type === "group") {
          const color = groupColor(row.group, state.dark);
          const count = row.members.length;
          return (
            <div
              key={`g-${row.group.id}`}
              data-group-id={row.group.id}
              className={`v-group ${row.group.collapsed ? "collapsed" : ""}`}
              style={{ "--group-color": color } as CSSProperties}
              title={row.group.title || tx("Unnamed group")}
              onClick={() => void api.call("groups.update", row.group.id, { collapsed: !row.group.collapsed })}
              onContextMenu={(e) => {
                e.preventDefault();
                onEditGroup(row.group.id, e.currentTarget.getBoundingClientRect());
              }}
            >
              <span className="v-group-caret">{row.group.collapsed ? <IconChevronRight size={14} /> : <IconChevronDown size={14} />}</span>
              <span className="v-group-dot" />
              <span className="v-group-title">{row.group.title || tx("Group")}</span>
              <span className="v-group-count">{count}</span>
            </div>
          );
        }
        const tab = tabById.get(row.tab.id);
        if (!tab) return null;
        return (
          <VTab
            key={tab.id}
            tab={tab}
            dark={state.dark}
            grouped={Boolean(row.group)}
            color={groupColor(row.group, state.dark)}
            hint={hint?.id === tab.id ? hint.side : null}
            onDragOver={onTabDragOver}
            onDrop={onTabDrop}
          />
        );
      })}
      <button className="v-newtab" title={tx("New tab (Ctrl+T)")} onClick={() => void api.call("tabs.create")}>
        <IconPlus size={16} />
        {!collapsed && <span>{tx("New tab")}</span>}
      </button>
    </div>
  );
}

function VTab({
  tab,
  dark,
  grouped,
  color,
  hint,
  onDragOver,
  onDrop,
}: {
  tab: TabView;
  dark: boolean;
  grouped?: boolean;
  color?: string | undefined;
  hint: "before" | "after" | null;
  onDragOver: (e: DragEvent<HTMLElement>, id: string) => void;
  onDrop: (e: DragEvent<HTMLElement>, id: string) => void;
}) {
  const api = chromeApi();
  const close = (e: MouseEvent): void => {
    e.stopPropagation();
    void api.call("tabs.close", tab.id);
  };
  const classes = [
    "v-tab",
    tab.active ? "active" : "",
    tab.pinned ? "pinned" : "",
    grouped ? "grouped" : "",
    tab.agentControlled ? "agent" : "",
    tab.sleeping ? "sleeping" : "",
    tab.inSplit ? "in-split" : "",
    hint ? `drop-${hint}` : "",
  ].join(" ");
  return (
    <div
      className={classes}
      role="tab"
      aria-selected={tab.active}
      title={tabTooltip(tab)}
      style={{ "--group-color": color } as CSSProperties}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(TAB_MIME, tab.id);
        e.dataTransfer.effectAllowed = "move";
      }}
      onDragOver={(e) => onDragOver(e, tab.id)}
      onDrop={(e) => onDrop(e, tab.id)}
      onMouseDown={(e) => {
        if (e.button === 0) void api.call("tabs.activate", tab.id);
      }}
      onAuxClick={(e) => {
        if (e.button === 1) close(e);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        void api.call("ui.tabMenu", tab.id, e.clientX, e.clientY);
      }}
    >
      <span className="tab-icon">
        {tab.loading ? <span className="spinner" /> : <Favicon url={tab.url} src={tab.faviconUrl} />}
        <ContainerMark tab={tab} />
      </span>
      {!tab.pinned && <span className="v-tab-title">{tab.title || tab.url}</span>}
      {tab.audible && <IconVolume size={13} className="tab-audio" />}
      {tab.agentControlled && <span className="ai-badge">{tx("AI")}</span>}
      {!tab.pinned && (
        <button className="tab-close" title={tx("Close tab")} onMouseDown={(e) => e.stopPropagation()} onClick={close}>
          <IconClose size={24} />
        </button>
      )}
    </div>
  );
}
