import { useCallback, useEffect, useRef, useState } from "react";
import {
  ANNOTATION_COLORS,
  ANNOTATION_COLOR_HEX,
  type Annotation,
  type AnnotationColor,
  groupAnnotationsByPage,
} from "../../shared/annotations";
import { internalApi } from "../common/api";
import { IconDownload, IconEdit, IconTrash } from "../common/icons";
import { Favicon, hostOf } from "../common/ui";
import { PageShell, mount } from "./shell";

function ColorSwatches({ value, onPick }: { value: AnnotationColor; onPick: (color: AnnotationColor) => void }) {
  return (
    <div className="anno-swatches">
      {ANNOTATION_COLORS.map((color) => (
        <button
          key={color}
          type="button"
          title={color}
          className={`anno-swatch${color === value ? " active" : ""}`}
          style={{ background: ANNOTATION_COLOR_HEX[color] }}
          onClick={() => onPick(color)}
        />
      ))}
    </div>
  );
}

function AnnotationRow({ item, onChanged }: { item: Annotation; onChanged: () => void }) {
  const api = internalApi();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(item.note);

  const saveNote = (): void => {
    setEditing(false);
    if (draft !== item.note) void api.call("annotations.updateNote", item.id, draft).then(onChanged);
  };

  return (
    <div className="list-row anno-row" style={{ alignItems: "flex-start" }}>
      <span className="anno-dot" style={{ background: ANNOTATION_COLOR_HEX[item.color] }} />
      <div className="grow">
        <blockquote className="anno-quote">{item.anchor.quote}</blockquote>
        {editing ? (
          <div className="anno-edit">
            <textarea className="input" rows={2} value={draft} autoFocus onChange={(e) => setDraft(e.target.value)} />
            <div className="anno-edit-actions">
              <button className="btn small primary" onClick={saveNote}>Save</button>
              <button className="btn small ghost" onClick={() => { setDraft(item.note); setEditing(false); }}>Cancel</button>
            </div>
          </div>
        ) : item.note ? (
          <div className="anno-note">{item.note}</div>
        ) : (
          <div className="sub muted">No note</div>
        )}
        <ColorSwatches value={item.color} onPick={(color) => void api.call("annotations.setColor", item.id, color).then(onChanged)} />
      </div>
      <div className="actions">
        <button className="icon-btn" title="Edit note" onClick={() => { setDraft(item.note); setEditing(true); }}>
          <IconEdit size={15} />
        </button>
        <button className="icon-btn" title="Delete annotation" onClick={() => void api.call("annotations.remove", item.id).then(onChanged)}>
          <IconTrash size={15} />
        </button>
      </div>
    </div>
  );
}

function AnnotationsPage() {
  const api = internalApi();
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<Annotation[]>([]);
  const queryRef = useRef(query);
  queryRef.current = query;

  const load = useCallback((q: string) => void api.call("annotations.list", q).then(setItems), [api]);

  useEffect(() => {
    const timer = setTimeout(() => load(query), 120);
    return () => clearTimeout(timer);
  }, [query, load]);

  useEffect(() => {
    return api.onEvent((event) => {
      if (event.type === "annotations-changed") load(queryRef.current);
    });
  }, [api, load]);

  const groups = groupAnnotationsByPage(items);
  const refresh = (): void => load(queryRef.current);

  return (
    <PageShell
      title="Annotations"
      active="annotations"
      toolbar={
        <>
          <input className="input" placeholder="Search highlights and notes" value={query} onChange={(e) => setQuery(e.target.value)} />
          <button className="btn" disabled={items.length === 0} onClick={() => void api.call("annotations.export")}>
            <IconDownload size={14} /> Export
          </button>
        </>
      }
    >
      {items.length === 0 ? (
        <div className="card">
          <div className="empty">
            {query ? "No annotations match your search." : "Select text on any page and pick a highlight color to start annotating."}
          </div>
        </div>
      ) : (
        groups.map((g) => (
          <div key={g.url} className="card">
            <div className="day-head anno-page-head">
              <Favicon url={g.url} />
              <button className="anno-page-title" title={g.url} onClick={() => void api.call("annotations.open", g.items[0]?.id ?? "")}>
                {g.title || hostOf(g.url)}
              </button>
              <span className="sub muted">{hostOf(g.url)} · {g.items.length}</span>
            </div>
            <div className="list">
              {g.items.map((item) => (
                <AnnotationRow key={item.id} item={item} onChanged={refresh} />
              ))}
            </div>
          </div>
        ))
      )}
    </PageShell>
  );
}

mount(<AnnotationsPage />);
