import { useCallback, useEffect, useMemo, useState, type DragEvent } from "react";
import type { Bookmark } from "@corvus/shared";
import { BAR_FOLDER_ID, BOOKMARK_DRAG_MIME, OTHER_FOLDER_ID, ROOT_IDS, bookmarkUrlFromInput, childrenOf, isDescendant, pathTo } from "../../shared/bookmark-tree";
import { errorMessage, internalApi } from "../common/api";
import { IconChevronDown, IconChevronRight, IconEdit, IconFolder, IconPlus, IconTrash } from "../common/icons";
import { Favicon, hostOf } from "../common/ui";
import "./bookmarks.css";
import { PageShell, mount } from "./shell";

import { t } from "../common/i18n";
const VIEW_KEY = "corvus.bookmarks.view";

type View = "table" | "grid";
/** Where a dragged bookmark lands relative to the one under the pointer. */
type DropAt = { id: string; where: "before" | "after" | "into" };

/** The two root folders keep English names in the data; they are shown in the person's language. */
function folderTitle(b: { id: string; title: string }): string {
  if (b.id === BAR_FOLDER_ID) return t("Bookmarks bar");
  if (b.id === OTHER_FOLDER_ID) return t("Other bookmarks");
  return b.title;
}

function readView(): View {
  try {
    return localStorage.getItem(VIEW_KEY) === "grid" ? "grid" : "table";
  } catch {
    return "table";
  }
}

/** Before or after the item, or into it when it is a folder and the pointer is in its middle. */
function dropPosition(e: DragEvent<HTMLElement>, item: Bookmark, horizontal: boolean): DropAt["where"] {
  const r = e.currentTarget.getBoundingClientRect();
  const at = horizontal ? (e.clientX - r.left) / r.width : (e.clientY - r.top) / r.height;
  if (item.kind === "folder" && at > 0.28 && at < 0.72) return "into";
  return at < 0.5 ? "before" : "after";
}

function FolderTree({
  list,
  parentId,
  selected,
  depth,
  expanded,
  toggle,
  select,
  onDropInto,
}: {
  list: Bookmark[];
  parentId: string | null;
  selected: string;
  depth: number;
  expanded: Set<string>;
  toggle: (id: string) => void;
  select: (id: string) => void;
  onDropInto: (folderId: string, e: DragEvent) => void;
}) {
  const [over, setOver] = useState<string | null>(null);
  const folders = childrenOf(list, parentId).filter((b) => b.kind === "folder");
  return (
    <>
      {folders.map((f) => {
        const hasChildren = childrenOf(list, f.id).some((b) => b.kind === "folder");
        const open = expanded.has(f.id);
        return (
          <div key={f.id}>
            <button
              className={`${selected === f.id ? "active" : ""} ${over === f.id ? "drop-target" : ""}`}
              style={{ paddingLeft: 14 + depth * 14 }}
              onClick={() => select(f.id)}
              onDragOver={(e) => {
                if (e.dataTransfer.types.includes(BOOKMARK_DRAG_MIME)) {
                  e.preventDefault();
                  setOver(f.id);
                }
              }}
              onDragLeave={() => setOver(null)}
              onDrop={(e) => {
                setOver(null);
                onDropInto(f.id, e);
              }}
            >
              <span
                style={{ display: "inline-flex", width: 16, visibility: hasChildren ? "visible" : "hidden" }}
                onClick={(e) => {
                  e.stopPropagation();
                  toggle(f.id);
                }}
              >
                {open ? <IconChevronDown size={14} /> : <IconChevronRight size={14} />}
              </span>
              <IconFolder size={15} />
              <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{folderTitle(f)}</span>
            </button>
            {open && hasChildren && (
              <FolderTree list={list} parentId={f.id} selected={selected} depth={depth + 1} expanded={expanded} toggle={toggle} select={select} onDropInto={onDropInto} />
            )}
          </div>
        );
      })}
    </>
  );
}

/** Where the folder is: each step opens it, and takes a dragged bookmark. */
function Breadcrumbs({ crumbs, onOpen, onDropInto }: { crumbs: Bookmark[]; onOpen: (id: string) => void; onDropInto: (folderId: string, e: DragEvent) => void }) {
  const [over, setOver] = useState<string | null>(null);
  return (
    <nav className="bm-crumbs" aria-label={t("Folder path")}>
      {crumbs.map((c, i) => {
        const last = i === crumbs.length - 1;
        return (
          <span key={c.id} className="bm-crumb-wrap">
            {i > 0 && <IconChevronRight size={13} />}
            <button
              className={`bm-crumb ${last ? "current" : ""} ${over === c.id ? "drop-target" : ""}`}
              aria-current={last ? "page" : undefined}
              onClick={() => onOpen(c.id)}
              onDragOver={(e) => {
                if (!last && e.dataTransfer.types.includes(BOOKMARK_DRAG_MIME)) {
                  e.preventDefault();
                  setOver(c.id);
                }
              }}
              onDragLeave={() => setOver(null)}
              onDrop={(e) => {
                setOver(null);
                onDropInto(c.id, e);
              }}
            >
              {i === 0 && <IconFolder size={14} />}
              {folderTitle(c)}
            </button>
          </span>
        );
      })}
    </nav>
  );
}

function BookmarksPage() {
  const api = internalApi();
  const [list, setList] = useState<Bookmark[]>([]);
  const [folder, setFolder] = useState(BAR_FOLDER_ID);
  const [query, setQuery] = useState("");
  const [view, setViewState] = useState<View>(readView);
  const [editing, setEditing] = useState<{ id: string | "new-bookmark" | "new-folder"; title: string; url: string } | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set([BAR_FOLDER_ID]));
  const [dragging, setDragging] = useState<string | null>(null);
  const [dropAt, setDropAt] = useState<DropAt | null>(null);
  const [error, setError] = useState<string | null>(null);

  const setView = (v: View): void => {
    setViewState(v);
    try {
      localStorage.setItem(VIEW_KEY, v);
    } catch {
      // The choice lasts for this page only.
    }
  };

  const reload = useCallback(() => void api.call("bookmarks.list").then(setList), [api]);
  useEffect(() => {
    reload();
    return api.onEvent((e) => {
      if (e.type === "bookmarks-changed") reload();
    });
  }, [api, reload]);

  useEffect(() => {
    if (list.length > 0 && !list.some((b) => b.id === folder)) setFolder(BAR_FOLDER_ID);
  }, [list, folder]);

  const run = (p: Promise<unknown>): void => {
    setError(null);
    p.then(reload).catch((e: unknown) => setError(errorMessage(e)));
  };

  const items = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return childrenOf(list, folder);
    return list.filter((b) => b.kind === "bookmark" && `${b.title} ${b.url ?? ""}`.toLowerCase().includes(q));
  }, [list, folder, query]);

  const crumbs = pathTo(list, folder);
  const open = (id: string): void => {
    setFolder(id);
    setQuery("");
    setExpanded((s) => new Set([...s, ...pathTo(list, id).map((b) => b.id)]));
  };

  /** A dragged bookmark into a folder (not into itself or one of its own subfolders). */
  const moveInto = (folderId: string, e: DragEvent): void => {
    e.preventDefault();
    const id = e.dataTransfer.getData(BOOKMARK_DRAG_MIME);
    setDragging(null);
    if (!id || id === folderId || isDescendant(list, folderId, id)) return;
    run(api.call("bookmarks.move", id, folderId));
  };

  /** A drop on an item of the current folder: before it, after it, or into it (a folder). */
  const dropOn = (target: Bookmark, e: DragEvent<HTMLElement>, horizontal: boolean): void => {
    e.preventDefault();
    // Where it lands is read from the drop itself (the last dragover may not have rendered yet).
    const at = { id: target.id, where: dropPosition(e, target, horizontal) };
    setDropAt(null);
    setDragging(null);
    const id = e.dataTransfer.getData(BOOKMARK_DRAG_MIME);
    if (!id || id === target.id) return;
    if (at.where === "into") return moveInto(target.id, e);
    const siblings = childrenOf(list, folder).filter((x) => x.id !== id);
    const index = siblings.findIndex((x) => x.id === target.id) + (at.where === "after" ? 1 : 0);
    run(api.call("bookmarks.move", id, folder, index));
  };

  const saveEdit = (): void => {
    if (!editing) return;
    const { id, title, url } = editing;
    if (id === "new-folder") run(api.call("bookmarks.create", { parentId: folder, kind: "folder", title }));
    else if (id === "new-bookmark") {
      const address = bookmarkUrlFromInput(url);
      if (!address) return setError(t("Enter a URL"));
      run(api.call("bookmarks.create", { parentId: folder, kind: "bookmark", title, url: address }));
    } else {
      const node = list.find((b) => b.id === id);
      const address = node?.kind === "bookmark" ? bookmarkUrlFromInput(url) : null;
      run(api.call("bookmarks.update", id, { title, ...(address ? { url: address } : {}) }));
    }
    setEditing(null);
  };

  const editor = (kind: Bookmark["kind"]) =>
    editing && (
      <div className="bm-edit">
        {kind === "folder" ? <IconFolder size={16} /> : <IconPlus size={16} />}
        <input className="input" autoFocus placeholder={t("Name")} value={editing.title} onChange={(e) => setEditing({ ...editing, title: e.target.value })} onKeyDown={(e) => e.key === "Enter" && saveEdit()} />
        {kind === "bookmark" && (
          <input className="input" placeholder={t("URL")} value={editing.url} onChange={(e) => setEditing({ ...editing, url: e.target.value })} onKeyDown={(e) => e.key === "Enter" && saveEdit()} />
        )}
        <button className="btn small primary" onClick={saveEdit}>
          {t("Save")}
        </button>
        <button className="btn small ghost" onClick={() => setEditing(null)}>
          {t("Cancel")}
        </button>
      </div>
    );

  /** What every item shares: dragging, dropping, opening a folder with a double-click. */
  const itemProps = (b: Bookmark, horizontal: boolean) => ({
    "data-bookmark-id": b.id,
    draggable: !ROOT_IDS.has(b.id) && !query,
    onDragStart: (e: DragEvent<HTMLElement>) => {
      e.dataTransfer.setData(BOOKMARK_DRAG_MIME, b.id);
      e.dataTransfer.effectAllowed = "move";
      setDragging(b.id);
    },
    onDragEnd: () => {
      setDragging(null);
      setDropAt(null);
    },
    onDragOver: (e: DragEvent<HTMLElement>) => {
      if (query || !e.dataTransfer.types.includes(BOOKMARK_DRAG_MIME) || dragging === b.id) return;
      e.preventDefault();
      const where = dropPosition(e, b, horizontal);
      if (dropAt?.id !== b.id || dropAt.where !== where) setDropAt({ id: b.id, where });
    },
    onDrop: (e: DragEvent<HTMLElement>) => dropOn(b, e, horizontal),
    onDoubleClick: () => b.kind === "folder" && open(b.id),
  });
  const dropClass = (b: Bookmark): string =>
    `${dragging === b.id ? "dragging" : ""} ${dropAt?.id === b.id ? `drop-${dropAt.where}` : ""}`;

  const actions = (b: Bookmark) => (
    <div className="bm-actions">
      <button className="icon-btn" title={t("Edit")} onClick={() => setEditing({ id: b.id, title: b.title, url: b.url ?? "" })}>
        <IconEdit size={15} />
      </button>
      <button className="icon-btn" title={t("Delete")} onClick={() => run(api.call("bookmarks.remove", b.id))}>
        <IconTrash size={15} />
      </button>
    </div>
  );

  const folderCount = (id: string): number => childrenOf(list, id).length;

  return (
    <PageShell
      title={t("Bookmarks")}
      active="bookmarks"
      toolbar={<input className="input" placeholder={t("Search bookmarks")} value={query} onChange={(e) => setQuery(e.target.value)} />}
      sidebar={
        <div className="tree">
          <FolderTree
            list={list}
            parentId={null}
            selected={folder}
            depth={0}
            expanded={expanded}
            toggle={(id) =>
              setExpanded((s) => {
                const next = new Set(s);
                if (next.has(id)) next.delete(id);
                else next.add(id);
                return next;
              })
            }
            select={open}
            onDropInto={moveInto}
          />
        </div>
      }
    >
      <div className="bm-head">
        {query ? <div className="muted">{t("Results for “{query}”", { query })}</div> : <Breadcrumbs crumbs={crumbs} onOpen={open} onDropInto={moveInto} />}
        <div className="bm-head-actions">
          <div className="segmented bm-view" role="radiogroup" aria-label={t("View")}>
            <button className={view === "table" ? "on" : ""} role="radio" aria-checked={view === "table"} onClick={() => setView("table")}>
              {t("Table")}
            </button>
            <button className={view === "grid" ? "on" : ""} role="radio" aria-checked={view === "grid"} onClick={() => setView("grid")}>
              {t("Grid")}
            </button>
          </div>
          {!query && (
            <>
              <button className="btn small" onClick={() => setEditing({ id: "new-folder", title: "", url: "" })}>
                <IconFolder size={14} /> {t("New folder")}
              </button>
              <button className="btn small primary" onClick={() => setEditing({ id: "new-bookmark", title: "", url: "" })}>
                <IconPlus size={14} /> {t("Add bookmark")}
              </button>
            </>
          )}
        </div>
      </div>
      {error && <div className="notice error">{error}</div>}
      {(editing?.id === "new-folder" || editing?.id === "new-bookmark") && <div className="card">{editor(editing.id === "new-folder" ? "folder" : "bookmark")}</div>}

      {items.length === 0 && !editing ? (
        <div className="card">
          <div className="empty">{query ? t("No bookmarks match.") : t("This folder is empty.")}</div>
        </div>
      ) : view === "table" ? (
        <div className="card bm-table" role="table">
          <div className="bm-row bm-header" role="row">
            <span role="columnheader" />
            <span role="columnheader">{t("Name")}</span>
            <span role="columnheader">{t("Address")}</span>
            <span role="columnheader" />
          </div>
          {items.map((b) =>
            editing?.id === b.id ? (
              <div key={b.id} className="bm-row editing">
                {editor(b.kind)}
              </div>
            ) : (
              <div key={b.id} role="row" className={`bm-row ${dropClass(b)}`} {...itemProps(b, false)}>
                <span className="bm-grip" aria-hidden title={t("Drag to move")}>
                  ⋮⋮
                </span>
                <span className="bm-name">
                  {b.kind === "folder" ? <IconFolder size={16} /> : <Favicon url={b.url ?? ""} size={16} />}
                  {b.kind === "folder" ? (
                    <a
                      className="title"
                      href="#"
                      onClick={(e) => {
                        e.preventDefault();
                        open(b.id);
                      }}
                    >
                      {b.title}
                    </a>
                  ) : (
                    <a className="title" href={b.url} title={b.url}>
                      {b.title || b.url}
                    </a>
                  )}
                </span>
                <span className="bm-url muted" title={b.url}>
                  {b.kind === "folder" ? t("{n} items", { n: folderCount(b.id) }) : b.url}
                </span>
                {actions(b)}
              </div>
            ),
          )}
        </div>
      ) : (
        <div className="bm-grid">
          {items.map((b) =>
            editing?.id === b.id ? (
              <div key={b.id} className="bm-tile editing">
                {editor(b.kind)}
              </div>
            ) : (
              <div key={b.id} className={`bm-tile ${b.kind} ${dropClass(b)}`} {...itemProps(b, true)}>
                <a
                  className="bm-tile-main"
                  href={b.kind === "folder" ? "#" : b.url}
                  title={b.url ?? b.title}
                  onClick={(e) => {
                    if (b.kind === "folder") {
                      e.preventDefault();
                      open(b.id);
                    }
                  }}
                >
                  <span className="bm-tile-icon">{b.kind === "folder" ? <IconFolder size={22} /> : <Favicon url={b.url ?? ""} size={24} />}</span>
                  <span className="bm-tile-title">{b.title || b.url}</span>
                  <span className="bm-tile-sub muted">{b.kind === "folder" ? t("{n} items", { n: folderCount(b.id) }) : hostOf(b.url ?? "")}</span>
                </a>
                {actions(b)}
              </div>
            ),
          )}
        </div>
      )}
      <p className="muted small">{t("Drag to reorder; drop on a folder, a folder in the sidebar or a step of the path to move into it.")}</p>
    </PageShell>
  );
}

mount(<BookmarksPage />);
