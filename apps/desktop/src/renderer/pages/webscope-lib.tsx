import { useCallback, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { HttpHeader, ResponseComparison } from "@corvus/webscope";
import { bodyBytes, fmtBytes, fmtMs, hexDump, methodClass, prettyBody } from "./webscope-format";

import { t } from "../common/i18n";
export * from "./webscope-format";

export function MethodBadge({ method }: { method: string }) {
  return <span className={methodClass(method)}>{method.toUpperCase()}</span>;
}

// ------------------------------------------------------------------ message viewer

export interface MessageModel {
  startLine: string;
  startClass?: string;
  headers: HttpHeader[];
  body?: string;
  bodyBase64?: boolean;
  mimeType?: string;
  error?: string;
  byteLen?: number;
}

type MsgTab = "pretty" | "raw" | "headers" | "hex";

/**
 * Shared request/response pane: a titled header (with meta and actions), then Pretty, Raw,
 * Headers and Hex views of one captured message. Binary bodies open on Hex.
 */
export function MessageViewer({
  title,
  msg,
  actions,
  meta,
  emptyHint,
}: {
  title: string;
  msg: MessageModel | null;
  actions?: ReactNode;
  meta?: ReactNode;
  emptyHint?: string;
}) {
  const [picked, setPicked] = useState<MsgTab | null>(null);
  const tab: MsgTab = picked ?? (msg?.bodyBase64 ? "hex" : "pretty");

  const head = (
    <div className="ws-msg-head">
      <span className="ws-msg-title">{title}</span>
      {meta && <span className="ws-msg-meta">{meta}</span>}
      {actions && <span className="ws-msg-actions">{actions}</span>}
    </div>
  );

  if (!msg) {
    return (
      <div className="ws-msg">
        {head}
        <div className="ws-msg-body ws-msg-empty">{emptyHint && <div className="ws-state empty"><div className="ws-state-hint">{emptyHint}</div></div>}</div>
      </div>
    );
  }
  if (msg.error) {
    return (
      <div className="ws-msg">
        {head}
        <div className="ws-msg-body">
          <div className="ws-inline-error">{t("Request failed:")}{" "}{msg.error}</div>
        </div>
      </div>
    );
  }

  const bytes = tab === "hex" ? bodyBytes(msg.body, msg.bodyBase64) : new Uint8Array();
  const pretty = tab === "pretty" ? prettyBody(msg.body, msg.mimeType, msg.bodyBase64) : { text: "", note: undefined };
  const rawBody = msg.bodyBase64 ? `[binary body, ${msg.byteLen ?? bytes.length} bytes]` : msg.body ?? "";
  // A known size with no captured text means capture skipped the body, not that it was empty.
  const noBody = !msg.body && msg.byteLen ? t("Body not captured ({byteLen}).", { byteLen: fmtBytes(msg.byteLen) }) : t("No body.");

  let content: ReactNode;
  if (tab === "headers") {
    content = (
      <table className="ws-kv">
        <tbody>
          {msg.headers.length === 0 ? (
            <tr>
              <td className="ws-kv-empty" colSpan={2}>{t("No headers.")}</td>
            </tr>
          ) : (
            msg.headers.map((h, i) => (
              <tr key={i}>
                <td className="ws-kv-k">{h.name}</td>
                <td className="ws-kv-v">{h.value}</td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    );
  } else if (tab === "hex") {
    content = <pre className="ws-mono-body">{bytes.length ? hexDump(bytes) : noBody}</pre>;
  } else if (tab === "pretty") {
    content = (
      <>
        {pretty.note && <div className="ws-msg-note">{pretty.note}</div>}
        {(pretty.text || !msg.body) && <pre className="ws-mono-body">{pretty.text || noBody}</pre>}
      </>
    );
  } else {
    content = <pre className="ws-mono-body">{rawBody || noBody}</pre>;
  }

  const tabs: Array<[MsgTab, string, number | null]> = [
    ["pretty", t("Pretty"), null],
    ["raw", t("Raw"), null],
    ["headers", t("Headers"), msg.headers.length],
    ["hex", "Hex", null],
  ];

  return (
    <div className="ws-msg">
      {head}
      <div className="ws-msg-tabs" role="tablist" aria-label={t("{title} view", { title })}>
        {tabs.map(([id, label, count]) => (
          <button key={id} role="tab" aria-selected={tab === id} className={`ws-msg-tab ${tab === id ? "on" : ""}`} onClick={() => setPicked(id)}>
            {label}
            {count ? <span className="ws-tab-count">{count}</span> : null}
          </button>
        ))}
      </div>
      <div className={`ws-msg-start ${msg.startClass ?? ""}`}>{msg.startLine}</div>
      <div className="ws-msg-body">{content}</div>
    </div>
  );
}


// ------------------------------------------------------------------ resizable split

/**
 * Two panes with a draggable divider. `dir="col"` splits left/right, `dir="row"` top/bottom.
 * The handle is focusable and the arrow keys nudge the ratio, so it is keyboard-operable.
 */
export function Split({
  dir,
  initial = 0.5,
  min = 0.15,
  className = "",
  first,
  second,
}: {
  dir: "col" | "row";
  initial?: number;
  min?: number;
  className?: string;
  first: ReactNode;
  second: ReactNode;
}) {
  const [ratio, setRatio] = useState(initial);
  const ref = useRef<HTMLDivElement>(null);

  const clamp = (r: number): number => Math.min(1 - min, Math.max(min, r));

  const onPointerDown = (e: React.PointerEvent): void => {
    e.preventDefault();
    const el = ref.current;
    if (!el) return;
    const move = (ev: PointerEvent): void => {
      const rect = el.getBoundingClientRect();
      const r = dir === "col" ? (ev.clientX - rect.left) / rect.width : (ev.clientY - rect.top) / rect.height;
      setRatio(clamp(r));
    };
    const up = (): void => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const onKeyDown = (e: React.KeyboardEvent): void => {
    const step = 0.03;
    if ((dir === "col" && e.key === "ArrowLeft") || (dir === "row" && e.key === "ArrowUp")) {
      setRatio((r) => clamp(r - step));
      e.preventDefault();
    } else if ((dir === "col" && e.key === "ArrowRight") || (dir === "row" && e.key === "ArrowDown")) {
      setRatio((r) => clamp(r + step));
      e.preventDefault();
    }
  };

  const style =
    dir === "col"
      ? { gridTemplateColumns: `${ratio}fr 7px ${1 - ratio}fr` }
      : { gridTemplateRows: `${ratio}fr 7px ${1 - ratio}fr` };

  return (
    <div ref={ref} className={`ws-split ws-split-${dir} ${className}`} style={style}>
      <div className="ws-split-pane">{first}</div>
      <div
        className="ws-split-bar"
        role="separator"
        tabIndex={0}
        aria-orientation={dir === "col" ? "vertical" : "horizontal"}
        aria-valuenow={Math.round(ratio * 100)}
        onPointerDown={onPointerDown}
        onKeyDown={onKeyDown}
      />
      <div className="ws-split-pane">{second}</div>
    </div>
  );
}

// ------------------------------------------------------------------ virtual rows

export interface VirtualWindow {
  start: number;
  end: number;
  padTop: number;
  padBottom: number;
  onScroll: () => void;
  ref: React.RefObject<HTMLDivElement>;
}

/** Windowed rendering for long tables. Keeps the DOM small while the list scrolls. */
export function useVirtualRows(count: number, rowHeight: number, overscan = 12): VirtualWindow {
  const ref = useRef<HTMLDivElement>(null);
  const [range, setRange] = useState({ start: 0, end: 0 });

  const measure = useCallback(() => {
    const el = ref.current;
    const viewport = el ? el.clientHeight : 600;
    const scrollTop = el ? el.scrollTop : 0;
    const start = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
    const visible = Math.ceil(viewport / rowHeight) + overscan * 2;
    setRange({ start, end: Math.min(count, start + visible) });
  }, [count, rowHeight, overscan]);

  useLayoutEffect(() => {
    measure();
  }, [measure]);

  const end = range.end === 0 ? Math.min(count, Math.ceil(600 / rowHeight) + overscan) : Math.min(range.end, count);
  const start = Math.min(range.start, Math.max(0, count - 1));
  return {
    start,
    end,
    padTop: start * rowHeight,
    padBottom: Math.max(0, (count - end) * rowHeight),
    onScroll: measure,
    ref,
  };
}

// ------------------------------------------------------------------ sorting

export type SortDir = "asc" | "desc";

export function useSort<T, K extends string>(
  rows: T[],
  accessors: Record<K, (row: T) => string | number>,
  initial: { key: NoInfer<K>; dir: SortDir } | null = null,
) {
  const [sort, setSort] = useState<{ key: K; dir: SortDir } | null>(initial);
  const sorted = useMemo(() => {
    if (!sort) return rows;
    const get = accessors[sort.key];
    const factor = sort.dir === "asc" ? 1 : -1;
    return [...rows].sort((a, b) => {
      const av = get(a);
      const bv = get(b);
      if (av < bv) return -1 * factor;
      if (av > bv) return 1 * factor;
      return 0;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, sort]);
  const toggle = (key: K): void =>
    setSort((s) => (s && s.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: "asc" }));
  return { sorted, sort, toggle };
}

export function SortHeader<K extends string>({
  label,
  col,
  sort,
  onSort,
  className,
}: {
  label: string;
  col: K;
  sort: { key: K; dir: SortDir } | null;
  onSort: (k: K) => void;
  className?: string;
}) {
  const active = sort?.key === col;
  return (
    <th className={`ws-sortable ${className ?? ""} ${active ? "on" : ""}`} onClick={() => onSort(col)} aria-sort={active ? (sort?.dir === "asc" ? "ascending" : "descending") : "none"}>
      {label}
      <span className="ws-sort-caret">{active ? (sort?.dir === "asc" ? "▲" : "▼") : ""}</span>
    </th>
  );
}

// ------------------------------------------------------------------ small states

export function EmptyState({ title, hint, icon }: { title: string; hint?: string; icon?: ReactNode }) {
  return (
    <div className="ws-state empty">
      {icon && <div className="ws-state-icon">{icon}</div>}
      <div className="ws-state-title">{title}</div>
      {hint && <div className="ws-state-hint">{hint}</div>}
    </div>
  );
}

export function Loading({ label = "Loading" }: { label?: string }) {
  return (
    <div className="ws-state loading">
      <span className="spinner" /> {label}…
    </div>
  );
}

// ------------------------------------------------------------------ comparer diff

export function DiffPane({ diff }: { diff: ResponseComparison }) {
  const section = (title: string, lines: ResponseComparison["bodyDiff"]): ReactNode => (
    <div className="ws-diff-section">
      <div className="ws-diff-title">{title}</div>
      {lines.length === 0 ? (
        <div className="ws-diff-same">{t("No differences.")}</div>
      ) : (
        <pre className="ws-mono-body">
          {lines.map((line, i) =>
            line.kind === "same" ? (
              <span key={i} className="ws-diff-ctx">
                {"  "}
                {line.text}
                {"\n"}
              </span>
            ) : (
              <span key={i} className={line.kind === "added" ? "diff-add" : "diff-del"}>
                {line.kind === "added" ? "+ " : "- "}
                {line.text}
                {"\n"}
              </span>
            ),
          )}
        </pre>
      )}
    </div>
  );
  return (
    <div className="ws-diff">
      <div className="ws-diff-summary">
        <span>A: {diff.a.status ?? "-"} · {fmtBytes(diff.a.length)} · {fmtMs(diff.a.durationMs)}</span>
        <span>B: {diff.b.status ?? "-"} · {fmtBytes(diff.b.length)} · {fmtMs(diff.b.durationMs)}</span>
        <span className={diff.statusChanged ? "hit" : "ws-ok"}>{diff.statusChanged ? t("status differs") : t("status identical")}</span>
      </div>
      {section(t("Headers"), diff.headerDiff)}
      {section(t("Body"), diff.bodyDiff)}
    </div>
  );
}
