import { useCallback, useEffect, useMemo, useState, type DragEvent } from "react";
import type { Bookmark } from "@corvus/shared";
import { BAR_FOLDER_ID, ROOT_IDS, childrenOf, pathTo } from "../../shared/bookmark-tree";
import { classifyOmnibox } from "../../shared/omnibox";
import { errorMessage, internalApi } from "../common/api";
import { IconChevronDown, IconChevronRight, IconEdit, IconFolder, IconPlus, IconTrash } from "../common/icons";
import { Favicon } from "../common/ui";
import { PageShell, mount } from "./shell";

const DRAG_MIME = "application/x-corvus-bookmark";

function normalizeUrl(input: string): string {
  const intent = classifyOmnibox(input);
  return intent.kind === "url" ? intent.url : input.trim();
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
              style={{ paddingLeft: 8 + depth * 14 }}
              onClick={() => select(f.id)}
              onDragOver={(e) => {
                if (e.dataTransfer.types.includes(DRAG_MIME)) {
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
              <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{f.title}</span>
            </button>
            {open && hasChildren && (
              <FolderTree
                list={list}
                parentId={f.id}
                selected={selected}
                depth={depth + 1}
                expanded={expanded}
                toggle={toggle}
                select={select}
                onDropInto={onDropInto}
              />
            )}
          </div>
        );
      })}
    </>
  );
}

function BookmarksPage() {
  const api = internalApi();
  const [list, setList] = useState<Bookmark[]>([]);
  const [folder, setFolder] = useState(BAR_FOLDER_ID);
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<{ id: string | "new-bookmark" | "new-folder"; title: string; url: string } | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set([BAR_FOLDER_ID]));
  const [dropBefore, setDropBefore] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

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

  const moveInto = (folderId: string, e: DragEvent): void => {
    e.preventDefault();
    const id = e.dataTransfer.getData(DRAG_MIME);
    if (id && id !== folderId) run(api.call("bookmarks.move", id, folderId));
  };

  const saveEdit = (): void => {
    if (!editing) return;
    const { id, title, url } = editing;
    if (id === "new-folder") run(api.call("bookmarks.create", { parentId: folder, kind: "folder", title }));
    else if (id === "new-bookmark") {
      if (!url.trim()) return setError("Enter a URL");
      run(api.call("bookmarks.create", { parentId: folder, kind: "bookmark", title, url: normalizeUrl(url) }));
    } else {
      const node = list.find((b) => b.id === id);
      run(api.call("bookmarks.update", id, { title, ...(node?.kind === "bookmark" && url.trim() ? { url: normalizeUrl(url) } : {}) }));
    }
    setEditing(null);
  };

  const editor = (kind: Bookmark["kind"]) =>
    editing && (
      <div className="list-row">
        {kind === "folder" ? <IconFolder size={16} /> : <IconPlus size={16} />}
        <div className="edit-row">
          <input className="input" autoFocus placeholder="Name" value={editing.title} onChange={(e) => setEditing({ ...editing, title: e.target.value })} onKeyDown={(e) => e.key === "Enter" && saveEdit()} />
          {kind === "bookmark" && (
            <input className="input" placeholder="URL" value={editing.url} onChange={(e) => setEditing({ ...editing, url: e.target.value })} onKeyDown={(e) => e.key === "Enter" && saveEdit()} />
          )}
          <button className="btn small primary" onClick={saveEdit}>
            Save
          </button>
          <button className="btn small ghost" onClick={() => setEditing(null)}>
            Cancel
          </button>
        </div>
      </div>
    );

  return (
    <PageShell
      title="Bookmarks"
      active="bookmarks"
      toolbar={<input className="input" placeholder="Search bookmarks" value={query} onChange={(e) => setQuery(e.target.value)} />}
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
            select={(id) => {
              setFolder(id);
              setQuery("");
              setExpanded((s) => new Set([...s, ...pathTo(list, id).map((b) => b.id)]));
            }}
            onDropInto={moveInto}
          />
        </div>
      }
    >
      <div className="inline" style={{ justifyContent: "space-between" }}>
        <div className="muted">{query ? `Results for “${query}”` : crumbs.map((c) => c.title).join(" › ")}</div>
        {!query && (
          <div className="inline">
            <button className="btn small" onClick={() => setEditing({ id: "new-folder", title: "", url: "" })}>
              <IconFolder size={14} /> New folder
            </button>
            <button className="btn small primary" onClick={() => setEditing({ id: "new-bookmark", title: "", url: "" })}>
              <IconPlus size={14} /> Add bookmark
            </button>
          </div>
        )}
      </div>
      {error && <div className="notice error">{error}</div>}
      <div className="card">
        <div className="list">
          {editing?.id === "new-folder" && editor("folder")}
          {editing?.id === "new-bookmark" && editor("bookmark")}
          {items.length === 0 && !editing && <div className="empty">{query ? "No bookmarks match." : "This folder is empty."}</div>}
          {items.map((b) =>
            editing?.id === b.id ? (
              <div key={b.id}>{editor(b.kind)}</div>
            ) : (
              <div
                key={b.id}
                className={`list-row ${dropBefore === b.id ? "drop-target" : ""}`}
                draggable={!ROOT_IDS.has(b.id)}
                onDragStart={(e) => {
                  e.dataTransfer.setData(DRAG_MIME, b.id);
                  e.dataTransfer.effectAllowed = "move";
                }}
                onDragOver={(e) => {
                  if (!query && e.dataTransfer.types.includes(DRAG_MIME)) {
                    e.preventDefault();
                    setDropBefore(b.id);
                  }
                }}
                onDragLeave={() => setDropBefore(null)}
                onDrop={(e) => {
                  e.preventDefault();
                  setDropBefore(null);
                  const id = e.dataTransfer.getData(DRAG_MIME);
                  if (!id || id === b.id) return;
                  if (b.kind === "folder" && e.altKey) return run(api.call("bookmarks.move", id, b.id));
                  const siblings = childrenOf(list, folder).filter((x) => x.id !== id);
                  run(api.call("bookmarks.move", id, folder, siblings.findIndex((x) => x.id === b.id)));
                }}
                onDoubleClick={() => b.kind === "folder" && setFolder(b.id)}
              >
                {b.kind === "folder" ? <IconFolder size={16} /> : <Favicon url={b.url ?? ""} size={16} />}
                <div className="grow">
                  {b.kind === "folder" ? (
                    <a className="title" href="#" onClick={(e) => {
                        e.preventDefault();
                        setFolder(b.id);
                      }}
                    >
                      {b.title}
                    </a>
                  ) : (
                    <a className="title" href={b.url}>
                      {b.title}
                    </a>
                  )}
                  {b.url && <div className="sub">{b.url}</div>}
                </div>
                <div className="actions">
                  <button className="icon-btn" title="Edit" onClick={() => setEditing({ id: b.id, title: b.title, url: b.url ?? "" })}>
                    <IconEdit size={15} />
                  </button>
                  <button className="icon-btn" title="Delete" onClick={() => run(api.call("bookmarks.remove", b.id))}>
                    <IconTrash size={15} />
                  </button>
                </div>
              </div>
            ),
          )}
        </div>
      </div>
      <p className="muted small">Drag bookmarks to reorder them, or onto a folder in the sidebar to move them.</p>
    </PageShell>
  );
}

mount(<BookmarksPage />);
