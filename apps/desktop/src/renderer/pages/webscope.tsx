import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import type {
  AuditEntry,
  BlockRule,
  FuzzResultRow,
  FuzzSummary,
  HistoryEntry,
  HistoryFilter,
  HistorySummary,
  Finding,
  FindingSeverity,
  HttpHeader,
  HostOverride,
  MatchReplaceRule,
  PayloadRule,
  PayloadSet,
  ContentType,
  RuleSet,
  Scope,
  ScopeEntry,
  SitemapNode,
} from "@corvus/webscope";
import type { WebScopeInterceptState, WebScopeState } from "../../shared/webscope-ipc";
import { internalApi, errorMessage } from "../common/api";
import { IconChevronDown, IconChevronRight, IconPlus, IconShield, IconWarning } from "../common/icons";
import "../common/theme.css";
import "./webscope.css";
import {
  DiffPane,
  EmptyState,
  Loading,
  MessageViewer,
  MethodBadge,
  Split,
  SortHeader,
  draftToRequest,
  emptyDraft,
  fmtBytes,
  fmtClock,
  fmtMs,
  headersToText,
  newId,
  statusClass,
  useSort,
  useVirtualRows,
  countPositions,
  payloadSetSize,
  plannedRequests,
  type PayloadSetDraft,
  type MessageModel,
  type RequestDraft,
} from "./webscope-lib";

const api = internalApi();

type View = "history" | "intercept" | "repeater" | "fuzzer" | "target" | "findings" | "rules" | "scope" | "decoder" | "comparer";

interface NavGroup {
  items: Array<{ id: View; label: string }>;
}
const NAV_GROUPS: NavGroup[] = [
  { items: [{ id: "history", label: "History" }, { id: "intercept", label: "Intercept" }, { id: "repeater", label: "Repeater" }, { id: "fuzzer", label: "Fuzzer" }] },
  { items: [{ id: "target", label: "Target" }, { id: "findings", label: "Findings" }] },
  { items: [{ id: "scope", label: "Scope" }, { id: "rules", label: "Rules" }, { id: "decoder", label: "Decoder" }, { id: "comparer", label: "Comparer" }] },
];
const ALL_VIEWS: View[] = NAV_GROUPS.flatMap((g) => g.items.map((i) => i.id));

const TYPES: ContentType[] = ["document", "stylesheet", "script", "image", "font", "xhr", "fetch", "websocket", "media", "manifest", "other"];
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

function headerValue(headers: HttpHeader[], name: string): string | undefined {
  const lower = name.toLowerCase();
  return headers.find((h) => h.name.toLowerCase() === lower)?.value;
}

function requestMessage(e: HistoryEntry): MessageModel {
  return {
    startLine: `${e.request.method} ${e.request.url}`,
    startClass: `m-${e.request.method.toLowerCase()}`,
    headers: e.request.headers,
    body: e.request.body,
    bodyBase64: e.request.bodyBase64,
    mimeType: headerValue(e.request.headers, "content-type"),
  };
}

function responseMessage(e: HistoryEntry): MessageModel | null {
  if (e.error) return { startLine: "", headers: [], error: e.error };
  const r = e.response;
  if (!r) return null;
  return {
    startLine: `${r.status} ${r.statusText ?? ""}`.trim(),
    startClass: statusClass(r.status),
    headers: r.headers,
    body: r.body,
    bodyBase64: r.bodyBase64,
    mimeType: r.mimeType,
    byteLen: r.size,
  };
}

function StatusCell({ status }: { status: number | null }) {
  return <span className={statusClass(status)}>{status ?? "ERR"}</span>;
}

/** "200 · 1.2 kB · 41 ms" for a response pane header. */
function ResponseMeta({ entry }: { entry: HistoryEntry }) {
  const r = entry.response;
  if (!r) return entry.error ? <span className="st-5">failed</span> : null;
  return (
    <span className="ws-msg-metaline">
      <span className={statusClass(r.status)}>{r.status}</span> · {fmtBytes(r.size ?? 0)} · {fmtMs(entry.durationMs ?? null)}
    </span>
  );
}

// ================================================================== History

interface HistoryActions {
  onRepeater: (e: HistoryEntry) => void;
  onFuzzer: (e: HistoryEntry) => void;
  onCompare: (ids: string[]) => void;
}

function HistoryView({ onRepeater, onFuzzer, onCompare }: HistoryActions) {
  const [rows, setRows] = useState<HistorySummary[] | null>(null);
  const [filter, setFilter] = useState<HistoryFilter>({});
  const [selected, setSelected] = useState<HistoryEntry | null>(null);
  const [marked, setMarked] = useState<string[]>([]);
  const [importError, setImportError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const reload = useCallback(() => {
    void api.call("webscope.history", filter, 500).then(setRows);
  }, [filter]);
  useEffect(() => {
    const t = setTimeout(reload, 120);
    return () => clearTimeout(t);
  }, [reload]);

  // The highlighted row updates at once; the detail fills in when it arrives. A late reply for a
  // row the user already moved past is ignored.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const wanted = useRef<string | null>(null);
  const open = (id: string): void => {
    wanted.current = id;
    setSelectedId(id);
    void api.call("webscope.detail", id).then((entry) => {
      if (wanted.current === id) setSelected(entry);
    });
  };
  const toggleMark = (id: string): void => setMarked((m) => (m.includes(id) ? m.filter((x) => x !== id) : [...m, id].slice(-2)));

  const exportHar = (): void => {
    void api.call("webscope.exportHar", null).then((har) => {
      const blob = new Blob([JSON.stringify(har, null, 2)], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `corvus-webscope-${Date.now()}.har`;
      a.click();
      URL.revokeObjectURL(a.href);
    });
  };
  const importHar = (file: File): void => {
    setImportError(null);
    void file.text().then((text) => {
      try {
        void api.call("webscope.importHar", JSON.parse(text)).then(reload);
      } catch {
        setImportError("That file is not valid JSON or HAR.");
      }
    });
  };
  const clearHistory = (): void => {
    if (!confirm("Clear all captured history? This cannot be undone.")) return;
    void api.call("webscope.clearHistory").then(() => {
      setSelected(null);
      setSelectedId(null);
      wanted.current = null;
      reload();
    });
  };

  const setF = (patch: Partial<HistoryFilter>): void => setFilter((f) => ({ ...f, ...patch }));

  const { sorted, sort, toggle } = useSort(
    rows ?? [],
    {
      time: (r) => r.startedAt,
      method: (r) => r.method,
      host: (r) => r.host,
      path: (r) => r.path,
      status: (r) => r.status ?? 0,
      type: (r) => r.type,
      len: (r) => r.length,
    },
    { key: "time", dir: "desc" },
  );
  const ROW_H = 27;
  const HEAD_H = 28;
  const vw = useVirtualRows(sorted.length, ROW_H);

  // Up/Down step through the rows (with the detail following); Space marks the row for Compare.
  const onTableKey = (e: React.KeyboardEvent): void => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== " ") return;
    e.preventDefault();
    const idx = selectedId ? sorted.findIndex((r) => r.id === selectedId) : -1;
    if (e.key === " ") {
      if (selectedId) toggleMark(selectedId);
      return;
    }
    const next = Math.max(0, Math.min(sorted.length - 1, idx + (e.key === "ArrowDown" ? 1 : -1)));
    const row = sorted[next];
    if (!row) return;
    open(row.id);
    const el = vw.ref.current;
    if (el) {
      const top = next * ROW_H;
      if (top < el.scrollTop) el.scrollTop = top;
      else if (top + ROW_H > el.scrollTop + el.clientHeight - HEAD_H) el.scrollTop = top + ROW_H - el.clientHeight + HEAD_H;
    }
  };

  const reqMsg = selected ? requestMessage(selected) : null;
  const resMsg = selected ? responseMessage(selected) : null;

  const table = (
    <div className="ws-view-table">
      <div className="ws-tablewrap" ref={vw.ref} onScroll={vw.onScroll} tabIndex={0} onKeyDown={onTableKey} aria-label="Captured requests. Up and Down move the selection, Space marks for compare.">
        <table className="ws-table">
          <thead>
            <tr>
              <th className="ws-col-cmp" title="Mark two rows to compare"></th>
              <th className="ws-col-dot"></th>
              <SortHeader label="Method" col="method" sort={sort} onSort={toggle} />
              <SortHeader label="Host" col="host" sort={sort} onSort={toggle} />
              <SortHeader label="Path" col="path" sort={sort} onSort={toggle} className="ws-col-path" />
              <SortHeader label="Status" col="status" sort={sort} onSort={toggle} />
              <SortHeader label="Type" col="type" sort={sort} onSort={toggle} />
              <SortHeader label="Size" col="len" sort={sort} onSort={toggle} />
              <SortHeader label="Time" col="time" sort={sort} onSort={toggle} />
              <th>Source</th>
            </tr>
          </thead>
          <tbody>
            <tr className="ws-spacer-row" style={{ height: vw.padTop }} aria-hidden>
              <td colSpan={10} />
            </tr>
            {sorted.slice(vw.start, vw.end).map((r) => (
              <tr key={r.id} className={selectedId === r.id ? "sel" : ""} aria-selected={selectedId === r.id} onClick={() => open(r.id)}>
                <td className="ws-col-cmp" onClick={(e) => { e.stopPropagation(); toggleMark(r.id); }}>
                  <input type="checkbox" checked={marked.includes(r.id)} readOnly tabIndex={-1} aria-label="mark for compare" />
                </td>
                <td className="ws-col-dot"><span className={`scope-dot${r.inScope ? "" : " oos"}`} title={r.inScope ? "in scope" : "out of scope"} /></td>
                <td><MethodBadge method={r.method} /></td>
                <td className={r.inScope ? "" : "oos"}>{r.host}</td>
                <td className="path">{r.path}</td>
                <td><StatusCell status={r.status} /></td>
                <td className="oos">{r.type}</td>
                <td>{fmtBytes(r.length)}</td>
                <td className="oos">{fmtClock(r.startedAt)}</td>
                <td className="oos">{r.source}</td>
              </tr>
            ))}
            <tr className="ws-spacer-row" style={{ height: vw.padBottom }} aria-hidden>
              <td colSpan={10} />
            </tr>
          </tbody>
        </table>
        {rows !== null && sorted.length === 0 && (
          <EmptyState title="No traffic captured yet" hint="Turn capture on, arm a scope, then browse an in-scope site. Captured exchanges appear here." />
        )}
        {rows === null && <Loading label="Loading history" />}
      </div>
      <div className="ws-statusbar">
        <span className="ws-statusbar-count">
          {rows === null ? "…" : `${sorted.length} shown`}
          {marked.length > 0 && ` · ${marked.length} of 2 marked for compare`}
        </span>
        <div className="ws-spacer" />
        <button className="btn small" disabled={marked.length !== 2} onClick={() => onCompare(marked)} title="Mark two rows (checkbox or Space) to compare their responses">Compare</button>
        <button className="btn small" onClick={exportHar}>Export HAR</button>
        <button className="btn small" onClick={() => fileRef.current?.click()}>Import HAR</button>
        <input ref={fileRef} type="file" accept=".har,.json,application/json" hidden onChange={(e) => e.target.files?.[0] && importHar(e.target.files[0])} />
        <button className="btn small danger" onClick={clearHistory}>Clear</button>
      </div>
    </div>
  );

  const detail = (
    <Split
      dir="col"
      initial={0.5}
      className="ws-detail"
      first={
        <MessageViewer
          title="Request"
          msg={reqMsg}
          emptyHint="Select a row, or use Up and Down, to inspect it here."
          actions={
            selected ? (
              <>
                <button className="btn small" onClick={() => onRepeater(selected)}>Send to Repeater</button>
                <button className="btn small" onClick={() => onFuzzer(selected)}>Send to Fuzzer</button>
              </>
            ) : undefined
          }
        />
      }
      second={
        <MessageViewer
          title="Response"
          msg={resMsg}
          meta={selected ? <ResponseMeta entry={selected} /> : undefined}
          emptyHint={selected ? "No response was captured for this request." : "The response appears here."}
        />
      }
    />
  );

  return (
    <div className="ws-view">
      <div className="ws-toolbar ws-filters" role="search">
        <input className="input sm ws-f-host" placeholder="Host" aria-label="Filter by host" onChange={(e) => setF({ host: e.target.value || undefined })} />
        <input className="input sm ws-f-search" placeholder="Search URL, headers, body" aria-label="Search URL, headers and bodies" onChange={(e) => setF({ search: e.target.value || undefined })} />
        <select className="input sm" aria-label="Method" onChange={(e) => setF({ method: e.target.value || undefined })}>
          <option value="">Method</option>
          {METHODS.map((m) => <option key={m}>{m}</option>)}
        </select>
        <select className="input sm" aria-label="Status" onChange={(e) => setF({ statusClass: e.target.value ? (Number(e.target.value) as HistoryFilter["statusClass"]) : undefined })}>
          <option value="">Status</option>
          <option value="2">2xx</option>
          <option value="3">3xx</option>
          <option value="4">4xx</option>
          <option value="5">5xx</option>
        </select>
        <select className="input sm" aria-label="Resource type" onChange={(e) => setF({ type: (e.target.value || undefined) as ContentType | undefined })}>
          <option value="">Type</option>
          {TYPES.map((t) => <option key={t}>{t}</option>)}
        </select>
        <select className="input sm" aria-label="Source" onChange={(e) => setF({ source: (e.target.value || undefined) as HistoryFilter["source"] })}>
          <option value="">Source</option>
          <option value="capture">capture</option>
          <option value="repeater">repeater</option>
          <option value="fuzzer">fuzzer</option>
        </select>
        <label className="ws-check"><input type="checkbox" onChange={(e) => setF({ onlyInScope: e.target.checked || undefined })} /> In scope only</label>
      </div>
      {importError && <div className="ws-inline-error">{importError}</div>}
      <Split dir="row" initial={0.46} first={table} second={detail} className="ws-grow" />
    </div>
  );
}

// ================================================================== Repeater

interface RepTab {
  id: string;
  title: string;
  draft: RequestDraft;
  result: HistoryEntry | null;
  busy: boolean;
  error: string | null;
}

function tabFromSeed(e: HistoryEntry): RepTab {
  return {
    id: newId(),
    title: `${e.request.method} ${e.host}`,
    draft: {
      method: e.request.method,
      url: e.request.url,
      headersText: headersToText(e.request.headers),
      body: e.request.body && !e.request.bodyBase64 ? e.request.body : "",
      useProfileCookies: false,
      followRedirects: false,
    },
    result: null,
    busy: false,
    error: null,
  };
}
function blankTab(): RepTab {
  return { id: newId(), title: "New request", draft: emptyDraft(), result: null, busy: false, error: null };
}

function RepeaterView({ seed, seedNonce }: { seed: HistoryEntry | null; seedNonce: number }) {
  // Opened straight from "Send to Repeater": start with that request instead of an empty tab.
  const [tabs, setTabs] = useState<RepTab[]>(() => [seed && seedNonce > 0 ? tabFromSeed(seed) : blankTab()]);
  const [active, setActive] = useState<string>(() => tabs[0]?.id ?? "");
  const handledNonce = useRef(seedNonce);

  useEffect(() => {
    if (!seed || seedNonce === handledNonce.current) return;
    handledNonce.current = seedNonce;
    const t = tabFromSeed(seed);
    setTabs((ts) => [...ts, t]);
    setActive(t.id);
  }, [seedNonce]); // eslint-disable-line react-hooks/exhaustive-deps

  const current = tabs.find((t) => t.id === active) ?? tabs[0] ?? null;
  const patch = (id: string, p: Partial<RepTab>): void => setTabs((ts) => ts.map((t) => (t.id === id ? { ...t, ...p } : t)));
  const updDraft = (id: string, p: Partial<RequestDraft>): void => setTabs((ts) => ts.map((t) => (t.id === id ? { ...t, draft: { ...t.draft, ...p } } : t)));

  const send = (t: RepTab): void => {
    if (!t.draft.url || t.busy) return;
    patch(t.id, { busy: true, error: null });
    api.call("webscope.send", draftToRequest(t.draft)).then(
      (entry) => patch(t.id, { result: entry, busy: false, title: `${t.draft.method} ${entry.host}` }),
      (err: unknown) => patch(t.id, { error: errorMessage(err), busy: false }),
    );
  };

  const close = (id: string): void => {
    const next = tabs.filter((t) => t.id !== id);
    const list = next.length ? next : [blankTab()];
    setTabs(list);
    if (id === active || !list.some((t) => t.id === active)) setActive(list[0]!.id);
  };
  const addTab = (): void => {
    const t = blankTab();
    setTabs((ts) => [...ts, t]);
    setActive(t.id);
  };

  if (!current) return null;
  const resMsg = current.result ? responseMessage(current.result) : null;

  return (
    <div className="ws-view">
      <div className="ws-subtabs" role="tablist" aria-label="Repeater tabs">
        {tabs.map((t) => (
          <div key={t.id} className={`ws-subtab ${t.id === active ? "on" : ""}`}>
            <button className="ws-subtab-label" role="tab" aria-selected={t.id === active} onClick={() => setActive(t.id)}>
              {t.title}
            </button>
            <button className="ws-subtab-close" aria-label="Close tab" onClick={() => close(t.id)}>×</button>
          </div>
        ))}
        <button className="ws-subtab-add" aria-label="New request tab" onClick={addTab}><IconPlus size={14} /></button>
      </div>
      <Split
        dir="col"
        initial={0.5}
        className="ws-grow"
        first={
          <div className="ws-req-editor" onKeyDown={(e) => { if ((e.ctrlKey || e.metaKey) && e.key === "Enter") send(current); }}>
            <div className="ws-req-line">
              <select className="input sm" value={current.draft.method} onChange={(e) => updDraft(current.id, { method: e.target.value })} aria-label="Method">
                {METHODS.map((m) => <option key={m}>{m}</option>)}
              </select>
              <input className="input sm grow mono" placeholder="https://host.in.scope/path" value={current.draft.url} onChange={(e) => updDraft(current.id, { url: e.target.value })} aria-label="URL" />
              <button className="btn small primary" disabled={current.busy || !current.draft.url} onClick={() => send(current)}>
                {current.busy ? "Sending…" : "Send"}
              </button>
            </div>
            <div className="ws-field fill">
              <label className="ws-flabel">Headers</label>
              <textarea className="input mono" rows={6} placeholder="Header-Name: value (one per line)" value={current.draft.headersText} onChange={(e) => updDraft(current.id, { headersText: e.target.value })} />
            </div>
            <div className="ws-field fill">
              <label className="ws-flabel">Body</label>
              <textarea className="input mono" rows={5} placeholder="Request body" value={current.draft.body} onChange={(e) => updDraft(current.id, { body: e.target.value })} />
            </div>
            <div className="ws-req-opts">
              <label className="ws-check"><input type="checkbox" checked={current.draft.useProfileCookies} onChange={(e) => updDraft(current.id, { useProfileCookies: e.target.checked })} /> Reuse cookies</label>
              <label className="ws-check"><input type="checkbox" checked={current.draft.followRedirects} onChange={(e) => updDraft(current.id, { followRedirects: e.target.checked })} /> Follow redirects</label>
              <span className="ws-hint-inline">Ctrl+Enter sends</span>
            </div>
            {current.error && <div className="ws-inline-error">{current.error}</div>}
          </div>
        }
        second={
          <MessageViewer
            key={current.id}
            title="Response"
            msg={resMsg}
            meta={current.result ? <ResponseMeta entry={current.result} /> : current.busy ? <span className="ws-muted">Sending…</span> : undefined}
            emptyHint="Send the request (Ctrl+Enter) to see the response here."
          />
        }
      />
    </div>
  );
}

// ================================================================== Fuzzer

const RULE_KINDS: Array<[PayloadRule["kind"], string]> = [
  ["prefix", "Prefix"], ["suffix", "Suffix"], ["url-encode", "URL-encode"], ["base64", "Base64"],
  ["upper", "Uppercase"], ["lower", "Lowercase"], ["hash-md5", "MD5"], ["hash-sha1", "SHA-1"], ["hash-sha256", "SHA-256"],
];

function exportCsv(rows: FuzzResultRow[]): void {
  const esc = (s: string): string => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const header = ["index", "payloads", "status", "length", "durationMs", "matched", "extracted", "error"];
  const lines = [header.join(",")];
  for (const r of rows) {
    lines.push(
      [String(r.index), esc(r.payloads.join(" | ")), r.status === null ? "" : String(r.status), String(r.length), r.durationMs === null ? "" : String(r.durationMs), esc(r.matched.join(" | ")), esc((r.extracted ?? []).join(" | ")), esc(r.error ?? "")].join(","),
    );
  }
  const blob = new Blob([lines.join("\n")], { type: "text/csv" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "webscope-fuzz.csv";
  a.click();
  URL.revokeObjectURL(a.href);
}

function Section({ title, children, aside }: { title: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="ws-section">
      <div className="ws-section-head">
        <h3>{title}</h3>
        {aside}
      </div>
      {children}
    </section>
  );
}

function FuzzerView({ seed, seedNonce }: { seed: HistoryEntry | null; seedNonce: number }) {
  const [draft, setDraft] = useState<RequestDraft>({ ...emptyDraft(), method: "GET" });
  const [attack, setAttack] = useState<"sniper" | "cluster-bomb" | "pitchfork">("sniper");
  const [extract, setExtract] = useState("");
  const [sets, setSets] = useState<PayloadSetDraft[]>([{ kind: "wordlist", text: "", from: "0", to: "100", step: "1" }]);
  const [rules, setRules] = useState<PayloadRule[]>([]);
  const [rps, setRps] = useState("5");
  const [concurrency, setConcurrency] = useState("2");
  const [grep, setGrep] = useState("");
  const [authorized, setAuthorized] = useState(false);
  const [running, setRunning] = useState(false);
  const [rows, setRows] = useState<FuzzResultRow[]>([]);
  const [summary, setSummary] = useState<FuzzSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [onlyHits, setOnlyHits] = useState(false);

  useEffect(() => {
    if (!seed || seedNonce === 0) return;
    setDraft({
      method: seed.request.method,
      url: seed.request.url,
      headersText: headersToText(seed.request.headers),
      body: seed.request.body && !seed.request.bodyBase64 ? seed.request.body : "",
      useProfileCookies: false,
      followRedirects: false,
    });
  }, [seedNonce]); // eslint-disable-line react-hooks/exhaustive-deps

  const toSet = (d: PayloadSetDraft): PayloadSet => {
    if (d.kind === "wordlist") return { kind: "wordlist", values: d.text.split("\n").map((s) => s.trim()).filter(Boolean) };
    if (d.kind === "charset") return { kind: "charset", charset: d.text.replace(/\n/g, "") };
    return { kind: "numbers", from: Number(d.from) || 0, to: Number(d.to) || 0, step: Number(d.step) || 1 };
  };

  const positions = useMemo(() => countPositions(draft.url, draft.headersText, draft.body), [draft]);
  const planned = useMemo(() => plannedRequests(attack, positions, sets.map(payloadSetSize)), [positions, sets, attack]);

  const start = (): void => {
    if (!authorized) return;
    if (!confirm("Start a fuzzing attack against the in-scope target? Only run this against systems you are authorized to test.")) return;
    setRunning(true);
    setError(null);
    setRows([]);
    setSummary(null);
    const config = {
      template: draftToRequest(draft),
      attack,
      payloadSets: sets.map(toSet),
      concurrency: Number(concurrency) || 2,
      requestsPerSecond: Number(rps) || 5,
      grep: grep.split("\n").map((s) => s.trim()).filter(Boolean),
      extract: extract.split("\n").map((s) => s.trim()).filter(Boolean),
      payloadRules: rules,
      useProfileCookies: draft.useProfileCookies,
    };
    api.call("webscope.fuzz", config).then(
      (res) => { setRows(res.rows); setSummary(res.summary); setRunning(false); },
      (err: unknown) => { setError(errorMessage(err)); setRunning(false); },
    );
  };

  const updSet = (i: number, p: Partial<PayloadSetDraft>): void => setSets((s) => s.map((x, j) => (j === i ? { ...x, ...p } : x)));
  const addRule = (): void => setRules((r) => [...r, { kind: "suffix", text: "" }]);
  const updRule = (i: number, p: Partial<PayloadRule>): void => setRules((rs) => rs.map((x, j) => (j === i ? { ...x, ...p } : x)));

  const { sorted, sort, toggle } = useSort(
    rows,
    { index: (r) => r.index, status: (r) => r.status ?? 0, len: (r) => r.length, time: (r) => r.durationMs ?? 0 },
    { key: "index", dir: "asc" },
  );
  const shown = onlyHits ? sorted.filter((r) => r.matched.length > 0) : sorted;

  const setup = (
    <div className="ws-setup">
      <Section title="Target">
        <div className="ws-req-line">
          <select className="input sm" value={draft.method} onChange={(e) => setDraft((d) => ({ ...d, method: e.target.value }))} aria-label="Method">
            {METHODS.map((m) => <option key={m}>{m}</option>)}
          </select>
          <input className="input sm grow mono" placeholder="https://host/path?q=§FUZZ§" value={draft.url} onChange={(e) => setDraft((d) => ({ ...d, url: e.target.value }))} aria-label="URL" />
        </div>
        <div className="ws-field">
          <label className="ws-flabel">Headers</label>
          <textarea className="input mono" rows={3} placeholder="Optional. Mark positions with §payload§." value={draft.headersText} onChange={(e) => setDraft((d) => ({ ...d, headersText: e.target.value }))} />
        </div>
        <div className="ws-field">
          <label className="ws-flabel">Body</label>
          <textarea className="input mono" rows={3} placeholder="Optional. Mark positions with §payload§." value={draft.body} onChange={(e) => setDraft((d) => ({ ...d, body: e.target.value }))} />
        </div>
        <div className="ws-count">
          {positions === 0
            ? "No positions marked: the request is sent once, unchanged."
            : `${positions} position${positions === 1 ? "" : "s"} marked, ${planned.toLocaleString()} request${planned === 1 ? "" : "s"} planned`}
        </div>
      </Section>

      <Section title="Attack">
        <select className="input sm" value={attack} onChange={(e) => setAttack(e.target.value as typeof attack)} aria-label="Attack type">
          <option value="sniper">Sniper: one position at a time</option>
          <option value="cluster-bomb">Cluster bomb: every combination</option>
          <option value="pitchfork">Pitchfork: sets in lockstep</option>
        </select>
      </Section>

      <Section title="Payload sets" aside={(attack !== "sniper") && <button className="btn small" onClick={() => setSets((s) => [...s, { kind: "wordlist", text: "", from: "0", to: "100", step: "1" }])}>Add set</button>}>
        {sets.map((s, i) => (
          <div className="ws-subcard" key={i}>
            <div className="ws-row">
              <select className="input sm" value={s.kind} onChange={(e) => updSet(i, { kind: e.target.value as PayloadSet["kind"] })} aria-label="Payload set kind">
                <option value="wordlist">Wordlist</option>
                <option value="numbers">Numbers</option>
                <option value="charset">Charset</option>
              </select>
              <span className="ws-muted">Set {i + 1} · {payloadSetSize(s).toLocaleString()} values</span>
              {sets.length > 1 && <button className="btn small ghost" style={{ marginLeft: "auto" }} onClick={() => setSets((ss) => ss.filter((_, j) => j !== i))}>Remove</button>}
            </div>
            {s.kind === "numbers" ? (
              <div className="ws-row">
                <input className="input sm" style={{ width: 90 }} placeholder="from" value={s.from} onChange={(e) => updSet(i, { from: e.target.value })} aria-label="from" />
                <input className="input sm" style={{ width: 90 }} placeholder="to" value={s.to} onChange={(e) => updSet(i, { to: e.target.value })} aria-label="to" />
                <input className="input sm" style={{ width: 90 }} placeholder="step" value={s.step} onChange={(e) => updSet(i, { step: e.target.value })} aria-label="step" />
              </div>
            ) : (
              <textarea className="input mono" rows={3} placeholder={s.kind === "charset" ? "Characters, e.g. abc123" : "One payload per line. You supply the wordlist."} value={s.text} onChange={(e) => updSet(i, { text: e.target.value })} />
            )}
          </div>
        ))}
      </Section>

      <Section title="Payload processing" aside={<button className="btn small" onClick={addRule}>Add rule</button>}>
        {rules.length === 0 ? (
          <div className="ws-muted">Each payload is inserted as-is. Add a rule to encode, hash or wrap it first.</div>
        ) : (
          rules.map((r, i) => (
            <div className="ws-row" key={i}>
              <select className="input sm" value={r.kind} onChange={(e) => updRule(i, { kind: e.target.value as PayloadRule["kind"] })} aria-label="Rule">
                {RULE_KINDS.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
              </select>
              {(r.kind === "prefix" || r.kind === "suffix") && (
                <input className="input sm grow mono" placeholder="text" value={r.text ?? ""} onChange={(e) => updRule(i, { text: e.target.value })} aria-label="text" />
              )}
              <button className="btn small ghost" style={{ marginLeft: "auto" }} onClick={() => setRules((rs) => rs.filter((_, j) => j !== i))}>Remove</button>
            </div>
          ))
        )}
      </Section>

      <Section title="Throttle">
        <div className="ws-row">
          <label className="ws-field grow"><span className="ws-flabel">Requests / sec (max 50)</span><input className="input sm" value={rps} onChange={(e) => setRps(e.target.value)} /></label>
          <label className="ws-field grow"><span className="ws-flabel">Concurrency (max 20)</span><input className="input sm" value={concurrency} onChange={(e) => setConcurrency(e.target.value)} /></label>
        </div>
      </Section>

      <Section title="Grep and extract">
        <div className="ws-field">
          <label className="ws-flabel">Grep: flag responses containing (one per line)</label>
          <textarea className="input mono" rows={2} value={grep} onChange={(e) => setGrep(e.target.value)} />
        </div>
        <div className="ws-field">
          <label className="ws-flabel">Extract: regex, first capture group (one per line)</label>
          <textarea className="input mono" rows={2} value={extract} onChange={(e) => setExtract(e.target.value)} />
        </div>
        <label className="ws-check"><input type="checkbox" checked={draft.useProfileCookies} onChange={(e) => setDraft((d) => ({ ...d, useProfileCookies: e.target.checked }))} /> Reuse profile cookies</label>
      </Section>

      <div className="ws-authbar">
        <label className="ws-check signal"><input type="checkbox" checked={authorized} onChange={(e) => setAuthorized(e.target.checked)} /> I am authorized to test this target</label>
        <button className="btn small primary" disabled={running || !authorized || !draft.url} onClick={start}>{running ? "Running…" : "Start attack"}</button>
      </div>
      {error && <div className="ws-inline-error">{error}</div>}
    </div>
  );

  const results = (
    <div className="ws-results">
      <div className="ws-results-head">
        <span className="ws-results-summary">
          {running ? <><span className="spinner" /> Running…</> : summary ? `${summary.completed}/${summary.total} done · ${summary.config.requestsPerSecond}/s · ${summary.config.attack}` : "No results yet"}
        </span>
        <div className="ws-spacer" />
        {rows.length > 0 && <label className="ws-check"><input type="checkbox" checked={onlyHits} onChange={(e) => setOnlyHits(e.target.checked)} /> Only grep hits</label>}
        {rows.length > 0 && <button className="btn small" onClick={() => exportCsv(rows)}>Export CSV</button>}
      </div>
      <div className="ws-tablewrap">
        <table className="ws-table">
          <thead>
            <tr>
              <SortHeader label="#" col="index" sort={sort} onSort={toggle} />
              <th>Payloads</th>
              <SortHeader label="Status" col="status" sort={sort} onSort={toggle} />
              <SortHeader label="Size" col="len" sort={sort} onSort={toggle} />
              <SortHeader label="Time" col="time" sort={sort} onSort={toggle} />
              <th>Grep</th>
              <th>Extract</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => (
              <tr key={r.index} className={r.matched.length ? "ws-hit-row" : ""}>
                <td>{r.index}</td>
                <td className="path">{r.payloads.join(" · ")}</td>
                <td>{r.error ? <span className="st-5" title={r.error}>ERR</span> : <StatusCell status={r.status} />}</td>
                <td>{fmtBytes(r.length)}</td>
                <td>{fmtMs(r.durationMs)}</td>
                <td className="hit">{r.matched.join(", ")}</td>
                <td className="hit">{(r.extracted ?? []).join(", ")}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length === 0 && !running && (
          <EmptyState title="No attack has run" hint="Mark positions with §payload§, add a payload set, confirm authorization, then start." />
        )}
      </div>
    </div>
  );

  return (
    <div className="ws-view">
      <Split dir="col" initial={0.42} className="ws-grow" first={setup} second={results} />
    </div>
  );
}

// ================================================================== Intercept

function parseHeaders(text: string): HttpHeader[] {
  return text
    .split("\n")
    .map((line) => {
      const i = line.indexOf(":");
      if (i < 0) return null;
      return { name: line.slice(0, i).trim(), value: line.slice(i + 1).trim() };
    })
    .filter((h): h is HttpHeader => h !== null && h.name.length > 0);
}

function InterceptView({ state, visible }: { state: WebScopeState; visible: boolean }) {
  const [intercept, setIntercept] = useState<WebScopeInterceptState | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  // `forId` ties the editor contents to one held item, so switching items loads that item's request.
  const [edit, setEdit] = useState<{ forId: string; method: string; url: string; headers: string; body: string } | null>(null);
  // Match filters are edited locally and sent after a short pause, so typing is never fighting the poll.
  const [matchDraft, setMatchDraft] = useState<{ host: string; method: string; path: string } | null>(null);
  const matchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const reload = useCallback(() => { void api.call("webscope.interceptState").then(setIntercept); }, []);
  useEffect(() => {
    if (!visible) return;
    reload();
    const t = setInterval(reload, 800);
    return () => clearInterval(t);
  }, [reload, visible]);

  const config = intercept?.config ?? { enabled: false, interceptRequests: true, interceptResponses: false };
  const queue = intercept?.queue ?? [];
  const held = queue.find((q) => q.id === selected) ?? queue[0] ?? null;

  useEffect(() => {
    if (!held) {
      if (edit) setEdit(null);
      return;
    }
    if (selected !== held.id) setSelected(held.id);
    if (!edit || edit.forId !== held.id) {
      setEdit({ forId: held.id, method: held.request.method, url: held.request.url, headers: headersToText(held.request.headers), body: held.request.body ?? "" });
    }
  }, [held, selected, edit]);

  // Seed the local filter fields once from the engine's config.
  useEffect(() => {
    if (intercept && matchDraft === null) {
      const m = intercept.config.match;
      setMatchDraft({ host: m?.host ?? "", method: m?.method ?? "", path: m?.path ?? "" });
    }
  }, [intercept, matchDraft]);

  const setConfig = (patch: Partial<typeof config>): void => { void api.call("webscope.setInterceptConfig", { ...config, ...patch }).then(setIntercept); };
  const setMatch = (patch: Partial<{ host: string; method: string; path: string }>): void => {
    const draft = { host: "", method: "", path: "", ...matchDraft, ...patch };
    setMatchDraft(draft);
    if (matchTimer.current) clearTimeout(matchTimer.current);
    matchTimer.current = setTimeout(() => {
      // Read the latest config at send time (not the one from when typing started) and keep any
      // resource-type filter an agent set over MCP; the UI does not edit types.
      void api
        .call("webscope.interceptState")
        .then((s) => {
          const types = s.config.match?.types;
          const match = {
            ...(draft.host ? { host: draft.host } : {}),
            ...(draft.method ? { method: draft.method } : {}),
            ...(draft.path ? { path: draft.path } : {}),
            ...(types?.length ? { types } : {}),
          };
          return api.call("webscope.setInterceptConfig", { ...s.config, match: Object.keys(match).length ? match : undefined });
        })
        .then(setIntercept);
    }, 300);
  };
  useEffect(() => () => { if (matchTimer.current) clearTimeout(matchTimer.current); }, []);
  const forward = (useEdit: boolean): void => {
    if (!held) return;
    const payload = useEdit && edit ? { method: edit.method, url: edit.url, headers: parseHeaders(edit.headers), body: edit.body } : null;
    void api.call("webscope.interceptForward", held.id, payload).then(setIntercept);
  };
  const drop = (): void => { if (held) void api.call("webscope.interceptDrop", held.id).then(setIntercept); };

  return (
    <div className="ws-view">
      <div className="ws-toolbar">
        <label className="ws-toggle"><input type="checkbox" checked={config.enabled} onChange={(e) => setConfig({ enabled: e.target.checked })} /> Intercept {config.enabled ? "on" : "off"}</label>
        <label className="ws-toggle"><input type="checkbox" checked={config.interceptResponses} disabled={!config.enabled} onChange={(e) => setConfig({ interceptResponses: e.target.checked })} /> Hold responses</label>
        <div className="ws-spacer" />
        <span className="ws-muted">Match filters</span>
        <input className="input sm" style={{ width: 120 }} placeholder="host" value={matchDraft?.host ?? ""} onChange={(e) => setMatch({ host: e.target.value })} aria-label="Match host" />
        <select className="input sm" value={matchDraft?.method ?? ""} onChange={(e) => setMatch({ method: e.target.value })} aria-label="Match method">
          <option value="">any</option>
          {METHODS.map((m) => <option key={m}>{m}</option>)}
        </select>
        <input className="input sm" style={{ width: 120 }} placeholder="path" value={matchDraft?.path ?? ""} onChange={(e) => setMatch({ path: e.target.value })} aria-label="Match path" />
      </div>
      {!state.enabled && <div className="ws-inline-warn">Capture is off. Turn it on (top right) so WebScope can attach to your traffic.</div>}
      <div
        className="ws-intercept ws-grow"
        onKeyDown={(e) => {
          // Single-key shortcuts must never fire while typing in the editor fields.
          if (!held || e.ctrlKey || e.metaKey || e.altKey) return;
          if ((e.target as HTMLElement).closest("input, textarea, select, [contenteditable]")) return;
          if (e.key === "f" || e.key === "F") { e.preventDefault(); forward(true); }
          if (e.key === "d" || e.key === "D") { e.preventDefault(); drop(); }
        }}
      >
        <div className="ws-queue" role="listbox" aria-label="Held requests">
          {queue.length === 0 ? (
            <EmptyState title={config.enabled ? "Nothing held" : "Interception off"} hint={config.enabled ? "In-scope requests that match the filters will pause here." : "Turn interception on to hold matching requests."} />
          ) : (
            queue.map((q) => (
              <button key={q.id} role="option" aria-selected={q.id === held?.id} className={`ws-queue-row ${q.id === held?.id ? "on" : ""}`} onClick={() => setSelected(q.id)}>
                <span className={`ws-phase ${q.phase}`}>{q.phase === "response" ? "RESP" : q.request.method}</span>
                <span className="ws-queue-host">{q.host}</span>
                <span className="ws-queue-path">{q.path}</span>
              </button>
            ))
          )}
        </div>
        <div className="ws-editor">
          {held && edit ? (
            <>
              <div className="ws-req-line">
                <input className="input sm mono" style={{ width: 90 }} value={edit.method} onChange={(e) => setEdit({ ...edit, method: e.target.value })} disabled={held.phase === "response"} aria-label="Method" />
                <input className="input sm grow mono" value={edit.url} onChange={(e) => setEdit({ ...edit, url: e.target.value })} disabled={held.phase === "response"} aria-label="URL" />
              </div>
              <div className="ws-field fill">
                <label className="ws-flabel">Headers</label>
                <textarea className="input mono" rows={6} value={edit.headers} onChange={(e) => setEdit({ ...edit, headers: e.target.value })} />
              </div>
              <div className="ws-field fill">
                <label className="ws-flabel">Body</label>
                <textarea className="input mono" rows={6} value={edit.body} onChange={(e) => setEdit({ ...edit, body: e.target.value })} />
              </div>
              <div className="ws-editor-actions">
                <button className="btn small primary" onClick={() => forward(true)}>Forward edited</button>
                <button className="btn small" onClick={() => forward(false)}>Forward</button>
                <button className="btn small danger" onClick={drop}>Drop</button>
                <span className="ws-hint-inline">F forwards · D drops</span>
              </div>
            </>
          ) : (
            <EmptyState title="Nothing held" hint="Matching in-scope requests pause here so you can edit and forward them." />
          )}
        </div>
      </div>
    </div>
  );
}

// ================================================================== Target (sitemap)

function SitemapRows({ nodes, depth }: { nodes: SitemapNode[]; depth: number }) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const toggle = (path: string): void =>
    setCollapsed((c) => {
      const next = new Set(c);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  return (
    <>
      {nodes.map((n) => {
        const hasChildren = n.children.length > 0;
        const open = !collapsed.has(n.path);
        return (
          <div key={n.path}>
            <div className={`ws-tree-row${depth === 0 ? " host" : ""}`} style={{ paddingLeft: 8 + depth * 16 }}>
              {hasChildren ? (
                <button className="ws-tree-twist" onClick={() => toggle(n.path)} aria-label={open ? "Collapse" : "Expand"} aria-expanded={open}>
                  {open ? <IconChevronDown size={14} /> : <IconChevronRight size={14} />}
                </button>
              ) : (
                <span className="ws-tree-twist" />
              )}
              <span className="ws-tree-seg">{n.segment}</span>
              <span className="ws-tree-methods">{n.methods.join(" ")}</span>
              <span className="ws-tree-count">{n.count}</span>
            </div>
            {hasChildren && open && <SitemapRows nodes={n.children} depth={depth + 1} />}
          </div>
        );
      })}
    </>
  );
}

function TargetView() {
  const [tree, setTree] = useState<SitemapNode[] | null>(null);
  useEffect(() => { void api.call("webscope.sitemap").then(setTree); }, []);
  const total = tree?.reduce((n, h) => n + h.count, 0) ?? 0;
  return (
    <div className="ws-view">
      {tree && tree.length > 0 && (
        <div className="ws-tree-head">
          <span className="ws-tree-head-path">
            Path <span className="ws-muted">· {tree.length} host{tree.length === 1 ? "" : "s"}, {total} request{total === 1 ? "" : "s"}</span>
          </span>
          <span className="ws-tree-head-methods">Methods</span>
          <span className="ws-tree-head-count">Requests</span>
        </div>
      )}
      <div className="ws-scroll ws-tree">
        {tree === null ? <Loading label="Building sitemap" /> : tree.length > 0 ? <SitemapRows nodes={tree} depth={0} /> : <EmptyState title="No captured traffic" hint="Browse an in-scope site to build a host-to-path tree here." />}
      </div>
    </div>
  );
}

// ================================================================== Findings

const SEV_ORDER: FindingSeverity[] = ["medium", "low", "info"];
const SEVERITY_LABEL: Record<FindingSeverity, string> = { medium: "Medium", low: "Low", info: "Info" };

/** One observation and every place it was seen (the engine reports one finding per response). */
interface FindingGroup {
  key: string;
  title: string;
  detail: string;
  items: Finding[];
}

const LOCATIONS_SHOWN = 4;

function FindingCard({ group }: { group: FindingGroup }) {
  const [all, setAll] = useState(false);
  const shown = all ? group.items : group.items.slice(0, LOCATIONS_SHOWN);
  const hidden = group.items.length - shown.length;
  return (
    <div className="ws-finding">
      <div className="ws-finding-head">
        <span className="ws-finding-title">{group.title}</span>
        <span className="ws-finding-count">{group.items.length} location{group.items.length === 1 ? "" : "s"}</span>
      </div>
      <p className="ws-finding-detail">{group.detail}</p>
      <ul className="ws-finding-locs">
        {shown.map((f) => (
          <li key={f.id}>{f.host}{f.path}</li>
        ))}
      </ul>
      {(hidden > 0 || all) && group.items.length > LOCATIONS_SHOWN && (
        <button className="ws-linkbtn" onClick={() => setAll((a) => !a)}>{all ? "Show fewer" : `Show ${hidden} more`}</button>
      )}
    </div>
  );
}

function FindingsView() {
  const [findings, setFindings] = useState<Finding[] | null>(null);
  useEffect(() => { void api.call("webscope.findings").then(setFindings); }, []);

  // Severity -> identical observations merged into one card listing where each was seen.
  const groups = useMemo(() => {
    const by: Record<FindingSeverity, FindingGroup[]> = { medium: [], low: [], info: [] };
    const index = new Map<string, FindingGroup>();
    for (const f of findings ?? []) {
      const key = `${f.severity}\u0000${f.title}\u0000${f.detail}`;
      let g = index.get(key);
      if (!g) {
        g = { key, title: f.title, detail: f.detail, items: [] };
        index.set(key, g);
        by[f.severity].push(g);
      }
      g.items.push(f);
    }
    return by;
  }, [findings]);
  const countIn = (sev: FindingSeverity): number => groups[sev].reduce((n, g) => n + g.items.length, 0);

  return (
    <div className="ws-view">
      <div className="ws-findings-note">
        <IconWarning size={14} />
        <span>Passive observations from captured responses only. Nothing here was actively tested or exploited.</span>
      </div>
      <div className="ws-scroll ws-findings">
        {findings === null ? (
          <Loading label="Scanning captured responses" />
        ) : findings.length === 0 ? (
          <EmptyState title="No findings" hint="Browse in-scope sites. WebScope flags passive observations such as missing security headers here." />
        ) : (
          SEV_ORDER.filter((s) => groups[s].length > 0).map((sev) => (
            <div key={sev} className="ws-finding-group">
              <div className="ws-finding-grouphead">
                <span className={`ws-sev ${sev}`}>{SEVERITY_LABEL[sev]}</span>
                <span className="ws-muted">
                  {countIn(sev)} finding{countIn(sev) === 1 ? "" : "s"}, {groups[sev].length} kind{groups[sev].length === 1 ? "" : "s"}
                </span>
              </div>
              {groups[sev].map((g) => (
                <FindingCard key={g.key} group={g} />
              ))}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

// ================================================================== Scope

function ScopeView({ scope, reload, goBack }: { scope: Scope; reload: () => void; goBack: () => void }) {
  const [draft, setDraft] = useState<Scope>(scope);
  const [saved, setSaved] = useState(false);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  useEffect(() => setDraft(scope), [scope]);
  useEffect(() => { void api.call("webscope.audit", 50).then(setAudit); }, [saved]);

  const save = (): void => { void api.call("webscope.setScope", draft).then(() => { setSaved(true); reload(); setTimeout(() => setSaved(false), 1600); }); };
  const addEntry = (key: "include" | "exclude"): void => setDraft((d) => ({ ...d, [key]: [...d[key], { host: "", enabled: true }] }));
  const updEntry = (key: "include" | "exclude", i: number, patch: Partial<ScopeEntry>): void =>
    setDraft((d) => ({ ...d, [key]: d[key].map((e, j) => (j === i ? { ...e, ...patch } : e)) }));
  const delEntry = (key: "include" | "exclude", i: number): void => setDraft((d) => ({ ...d, [key]: d[key].filter((_, j) => j !== i) }));

  const list = (key: "include" | "exclude") => (
    <Section title={key === "include" ? "In scope (allowlist)" : "Excluded (always wins)"} aside={<button className="btn small" onClick={() => addEntry(key)}>Add entry</button>}>
      {draft[key].length === 0 ? (
        <div className="ws-muted">{key === "include" ? "Nothing is in scope until you add a host here." : "No exclusions."}</div>
      ) : (
        <table className="ws-entry-table">
          <thead>
            <tr><th className="ws-col-dot"></th><th>Host glob</th><th>Path prefix</th><th>Port</th><th></th></tr>
          </thead>
          <tbody>
            {draft[key].map((e, i) => (
              <tr key={i}>
                <td className="ws-col-dot"><input type="checkbox" checked={e.enabled} onChange={(ev) => updEntry(key, i, { enabled: ev.target.checked })} aria-label="enabled" /></td>
                <td><input className="input sm mono" placeholder="*.example.com" value={e.host} onChange={(ev) => updEntry(key, i, { host: ev.target.value })} /></td>
                <td><input className="input sm mono" placeholder="/api" value={e.pathPrefix ?? ""} onChange={(ev) => updEntry(key, i, { pathPrefix: ev.target.value || undefined })} /></td>
                <td><input className="input sm mono" style={{ width: 70 }} placeholder="any" value={e.port ?? ""} onChange={(ev) => updEntry(key, i, { port: ev.target.value ? Number(ev.target.value) : undefined })} /></td>
                <td><button className="btn small ghost" onClick={() => delEntry(key, i)} aria-label="Remove">×</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Section>
  );

  return (
    <div className="ws-view">
      <div className="ws-toolbar">
        <label className="ws-toggle"><input type="checkbox" checked={draft.enabled} onChange={(e) => setDraft((d) => ({ ...d, enabled: e.target.checked }))} /> Scope armed</label>
        <span className="ws-muted">Nothing is acted on unless it matches an enabled include and no exclude.</span>
        <div className="ws-spacer" />
        {saved && <span className="ws-ok">Saved</span>}
        <button className="btn small" onClick={goBack}>Done</button>
        <button className="btn small primary" onClick={save}>Save scope</button>
      </div>
      <div className="ws-scroll ws-form">
        {list("include")}
        {list("exclude")}
        <Section title="Audit log">
          {audit.length === 0 ? (
            <div className="ws-muted">No actions recorded yet.</div>
          ) : (
            <table className="ws-audit">
              <tbody>
                {audit.map((a, i) => (
                  <tr key={i}>
                    <td className="ws-audit-time">{fmtClock(a.at)}</td>
                    <td className="ws-audit-action">{a.action}</td>
                    <td className="path">{a.detail}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Section>
      </div>
    </div>
  );
}

// ================================================================== Rules

function RulesView({ rules, reload }: { rules: RuleSet; reload: () => void }) {
  const [draft, setDraft] = useState<RuleSet>(rules);
  const [saved, setSaved] = useState(false);
  useEffect(() => setDraft(rules), [rules]);
  const save = (): void => { void api.call("webscope.setRules", draft).then(() => { setSaved(true); reload(); setTimeout(() => setSaved(false), 1600); }); };

  const addMr = (): void => setDraft((d) => ({ ...d, matchReplace: [...d.matchReplace, { id: newId(), name: "", enabled: true, target: "request-header", match: "", replace: "", regex: false }] }));
  const updMr = (i: number, patch: Partial<MatchReplaceRule>): void => setDraft((d) => ({ ...d, matchReplace: d.matchReplace.map((r, j) => (j === i ? { ...r, ...patch } : r)) }));
  const addBlock = (): void => setDraft((d) => ({ ...d, block: [...d.block, { id: newId(), name: "", enabled: true, pattern: "" }] }));
  const updBlock = (i: number, patch: Partial<BlockRule>): void => setDraft((d) => ({ ...d, block: d.block.map((r, j) => (j === i ? { ...r, ...patch } : r)) }));
  const addOv = (): void => setDraft((d) => ({ ...d, hostOverride: [...d.hostOverride, { id: newId(), enabled: true, host: "", address: "" }] }));
  const updOv = (i: number, patch: Partial<HostOverride>): void => setDraft((d) => ({ ...d, hostOverride: d.hostOverride.map((r, j) => (j === i ? { ...r, ...patch } : r)) }));

  return (
    <div className="ws-view">
      <div className="ws-toolbar">
        <span className="ws-muted">Applied to in-scope requests in Repeater and Fuzzer, and on forward in Intercept.</span>
        <div className="ws-spacer" />
        {saved && <span className="ws-ok">Saved</span>}
        <button className="btn small primary" onClick={save}>Save rules</button>
      </div>
      <div className="ws-scroll ws-form">
        <Section title="Match and replace" aside={<button className="btn small" onClick={addMr}>Add rule</button>}>
          {draft.matchReplace.length === 0 ? <div className="ws-muted">No rewrite rules.</div> : (
            <table className="ws-entry-table">
              <thead><tr><th className="ws-col-dot"></th><th>Target</th><th>Match</th><th>Replace</th><th>Regex</th><th></th></tr></thead>
              <tbody>
                {draft.matchReplace.map((r, i) => (
                  <tr key={r.id}>
                    <td className="ws-col-dot"><input type="checkbox" checked={r.enabled} onChange={(e) => updMr(i, { enabled: e.target.checked })} aria-label="enabled" /></td>
                    <td>
                      <select className="input sm" value={r.target} onChange={(e) => updMr(i, { target: e.target.value as MatchReplaceRule["target"] })}>
                        <option value="request-header">Request header</option>
                        <option value="request-body">Request body</option>
                        <option value="request-url">Request URL</option>
                        <option value="response-header">Response header</option>
                        <option value="response-body">Response body</option>
                      </select>
                    </td>
                    <td><input className="input sm mono" placeholder="match" value={r.match} onChange={(e) => updMr(i, { match: e.target.value })} /></td>
                    <td><input className="input sm mono" placeholder="replace" value={r.replace} onChange={(e) => updMr(i, { replace: e.target.value })} /></td>
                    <td className="ws-col-dot"><input type="checkbox" checked={r.regex} onChange={(e) => updMr(i, { regex: e.target.checked })} aria-label="regex" /></td>
                    <td><button className="btn small ghost" onClick={() => setDraft((d) => ({ ...d, matchReplace: d.matchReplace.filter((_, j) => j !== i) }))} aria-label="Remove">×</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Section>
        <Section title="Block" aside={<button className="btn small" onClick={addBlock}>Add rule</button>}>
          {draft.block.length === 0 ? <div className="ws-muted">No block rules.</div> : (
            <table className="ws-entry-table">
              <thead><tr><th className="ws-col-dot"></th><th>Name</th><th>URL glob</th><th></th></tr></thead>
              <tbody>
                {draft.block.map((r, i) => (
                  <tr key={r.id}>
                    <td className="ws-col-dot"><input type="checkbox" checked={r.enabled} onChange={(e) => updBlock(i, { enabled: e.target.checked })} aria-label="enabled" /></td>
                    <td><input className="input sm" placeholder="name" value={r.name} onChange={(e) => updBlock(i, { name: e.target.value })} /></td>
                    <td><input className="input sm mono" placeholder="https://*/ads*" value={r.pattern} onChange={(e) => updBlock(i, { pattern: e.target.value })} /></td>
                    <td><button className="btn small ghost" onClick={() => setDraft((d) => ({ ...d, block: d.block.filter((_, j) => j !== i) }))} aria-label="Remove">×</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Section>
        <Section title="Host overrides (DNS-style)" aside={<button className="btn small" onClick={addOv}>Add rule</button>}>
          {draft.hostOverride.length === 0 ? <div className="ws-muted">No host overrides.</div> : (
            <table className="ws-entry-table">
              <thead><tr><th className="ws-col-dot"></th><th>Host</th><th>Address</th><th></th></tr></thead>
              <tbody>
                {draft.hostOverride.map((r, i) => (
                  <tr key={r.id}>
                    <td className="ws-col-dot"><input type="checkbox" checked={r.enabled} onChange={(e) => updOv(i, { enabled: e.target.checked })} aria-label="enabled" /></td>
                    <td><input className="input sm mono" placeholder="host" value={r.host} onChange={(e) => updOv(i, { host: e.target.value })} /></td>
                    <td><input className="input sm mono" placeholder="127.0.0.1" value={r.address} onChange={(e) => updOv(i, { address: e.target.value })} /></td>
                    <td><button className="btn small ghost" onClick={() => setDraft((d) => ({ ...d, hostOverride: d.hostOverride.filter((_, j) => j !== i) }))} aria-label="Remove">×</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Section>
      </div>
    </div>
  );
}

// ================================================================== Decoder

const OP_GROUPS: Array<{ title: string; ops: Array<[string, string]> }> = [
  { title: "Encode", ops: [["base64-encode", "Base64"], ["url-encode", "URL"], ["html-encode", "HTML"], ["hex-encode", "Hex"]] },
  { title: "Decode", ops: [["base64-decode", "Base64"], ["url-decode", "URL"], ["html-decode", "HTML"], ["hex-decode", "Hex"]] },
];
const HASHES = ["md5", "sha1", "sha256", "sha512"] as const;

function DecoderView() {
  const [input, setInput] = useState("");
  const [output, setOutput] = useState("");
  const run = (fn: () => Promise<string>): void => { fn().then(setOutput, (e: unknown) => setOutput(`error: ${errorMessage(e)}`)); };
  return (
    <div className="ws-view">
      <Split
        dir="col"
        initial={0.5}
        className="ws-grow"
        first={
          <div className="ws-decoder-pane">
            <div className="ws-msg-head"><span className="ws-msg-title">Input</span></div>
            <textarea className="ws-decoder-area mono" value={input} onChange={(e) => setInput(e.target.value)} placeholder="Paste text to encode, decode, hash or inspect." />
            <div className="ws-decoder-ops">
              {OP_GROUPS.map((g) => (
                <div className="ws-op-group" key={g.title}>
                  <span className="ws-op-label">{g.title}</span>
                  {g.ops.map(([op, label]) => <button key={op} className="btn small" onClick={() => run(() => api.call("webscope.encode", op as never, input))}>{label}</button>)}
                </div>
              ))}
              <div className="ws-op-group">
                <span className="ws-op-label">Hash</span>
                {HASHES.map((h) => <button key={h} className="btn small" onClick={() => run(() => api.call("webscope.hash", h, input))}>{h}</button>)}
              </div>
              <div className="ws-op-group">
                <span className="ws-op-label">Token</span>
                <button className="btn small" onClick={() => run(() => api.call("webscope.jwt", input).then((p) => JSON.stringify(p, null, 2)))}>JWT decode</button>
              </div>
            </div>
          </div>
        }
        second={
          <div className="ws-decoder-pane">
            <div className="ws-msg-head">
              <span className="ws-msg-title">Output</span>
              <span className="ws-msg-actions">{output && <button className="btn small" onClick={() => { setInput(output); setOutput(""); }}>Use as input</button>}</span>
            </div>
            <pre className="ws-mono-body">{output || "Results appear here."}</pre>
          </div>
        }
      />
    </div>
  );
}

// ================================================================== Comparer

function ComparerView({ seedIds }: { seedIds: string[] }) {
  const [history, setHistory] = useState<HistorySummary[]>([]);
  const [a, setA] = useState(seedIds[0] ?? "");
  const [b, setB] = useState(seedIds[1] ?? "");
  const [diff, setDiff] = useState<import("@corvus/webscope").ResponseComparison | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { void api.call("webscope.history", {}, 300).then(setHistory); }, []);
  useEffect(() => { setA(seedIds[0] ?? ""); setB(seedIds[1] ?? ""); }, [seedIds]);
  useEffect(() => {
    if (!a || !b) { setDiff(null); return; }
    api.call("webscope.compare", a, b).then((d) => { setDiff(d); setError(null); }, (e: unknown) => setError(errorMessage(e)));
  }, [a, b]);
  const opts = useMemo(() => history.map((h) => ({ id: h.id, label: `${h.method} ${h.host}${h.path} [${h.status ?? "err"}]` })), [history]);
  return (
    <div className="ws-view">
      <div className="ws-toolbar">
        <label className="ws-field grow"><span className="ws-flabel">Response A</span>
          <select className="input sm mono" value={a} onChange={(e) => setA(e.target.value)}><option value="">Pick a response…</option>{opts.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}</select>
        </label>
        <label className="ws-field grow"><span className="ws-flabel">Response B</span>
          <select className="input sm mono" value={b} onChange={(e) => setB(e.target.value)}><option value="">Pick a response…</option>{opts.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}</select>
        </label>
      </div>
      <div className="ws-scroll">
        {error ? <EmptyState title="Could not compare" hint={error} /> : diff ? <DiffPane diff={diff} /> : <EmptyState title="Pick two responses" hint="Choose A and B above, or mark two rows in History and open Compare, to diff their headers and bodies." />}
      </div>
    </div>
  );
}

// ================================================================== App shell

function ScopeStrip({ scope, onEdit }: { scope: Scope; onEdit: () => void }) {
  const hosts = scope.include.filter((e) => e.enabled && e.host.trim());
  return (
    <div className={`ws-scopestrip ${scope.enabled ? "armed" : "off"}`}>
      <span className="ws-scope-label"><span className="ws-scope-dot" /> Scope {scope.enabled ? "armed" : "off"}</span>
      <div className="ws-scope-chips">
        {!scope.enabled ? (
          <span className="ws-muted">Nothing is in scope. Arm a scope to capture, replay or fuzz.</span>
        ) : hosts.length === 0 ? (
          <span className="ws-muted">No hosts in scope yet.</span>
        ) : (
          hosts.map((e, i) => (
            <span className="ws-scope-chip" key={i}>
              {e.host}{e.pathPrefix ? e.pathPrefix : ""}{e.port ? `:${e.port}` : ""}
            </span>
          ))
        )}
      </div>
      <button className="ws-scope-edit" onClick={onEdit}>Edit scope</button>
    </div>
  );
}

function App() {
  const [view, setView] = useState<View>("history");
  const [state, setState] = useState<WebScopeState | null>(null);
  const [seed, setSeed] = useState<HistoryEntry | null>(null);
  const [seedNonce, setSeedNonce] = useState(0);
  const [fuzzSeed, setFuzzSeed] = useState<HistoryEntry | null>(null);
  const [fuzzNonce, setFuzzNonce] = useState(0);
  const [compareIds, setCompareIds] = useState<string[]>([]);
  const [showCaution, setShowCaution] = useState(false);
  // Workspace tools opened so far; they stay mounted (hidden) after the first visit.
  const [openedSet, setOpenedSet] = useState<ReadonlySet<View>>(() => new Set<View>());
  useEffect(() => {
    setOpenedSet((s) => (s.has(view) ? s : new Set([...s, view])));
  }, [view]);
  const opened: ReadonlySet<View> = openedSet.has(view) ? openedSet : new Set([...openedSet, view]);

  // Polled so the counts and scope strip stay live. Scope and rules keep their identity while
  // unchanged, so the Scope and Rules editors do not lose unsaved edits on every poll.
  const reload = useCallback(() => {
    void api.call("webscope.state").then((next) =>
      setState((prev) => {
        if (!prev) return next;
        const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
        const scope = same(prev.scope, next.scope) ? prev.scope : next.scope;
        const rules = same(prev.rules, next.rules) ? prev.rules : next.rules;
        const unchanged = scope === prev.scope && rules === prev.rules && prev.enabled === next.enabled && prev.historySize === next.historySize && prev.attachedTabs === next.attachedTabs;
        return unchanged ? prev : { ...next, scope, rules };
      }),
    );
  }, []);
  useEffect(() => { reload(); const t = setInterval(reload, 2500); return () => clearInterval(t); }, [reload]);

  const toggleEnabled = (): void => {
    if (!state) return;
    void api.call("webscope.setEnabled", !state.enabled).then(() => reload());
  };

  const goRepeater = (e: HistoryEntry): void => { setSeed(e); setSeedNonce((n) => n + 1); setView("repeater"); };
  const goFuzzer = (e: HistoryEntry): void => { setFuzzSeed(e); setFuzzNonce((n) => n + 1); setView("fuzzer"); };
  const goCompare = (ids: string[]): void => { setCompareIds(ids); setView("comparer"); };

  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const onTabKey = (e: React.KeyboardEvent, idx: number): void => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    e.preventDefault();
    const next = (idx + (e.key === "ArrowRight" ? 1 : ALL_VIEWS.length - 1)) % ALL_VIEWS.length;
    setView(ALL_VIEWS[next]!);
    tabRefs.current[next]?.focus();
  };

  return (
    <div className="ws-root">
      <header className="ws-topbar">
        <div className="ws-brand"><IconShield size={17} /> <b>WebScope</b></div>
        <button className="ws-caution" onClick={() => setShowCaution((s) => !s)} aria-expanded={showCaution}>
          <IconWarning size={13} /> Authorized testing only
        </button>
        <div className="ws-spacer" />
        <span className="ws-readout">{state?.historySize ?? 0} captured</span>
        <span className="ws-readout">{state?.attachedTabs ?? 0} tab{state?.attachedTabs === 1 ? "" : "s"}</span>
        <label className="ws-capture">
          <span>Capture</span>
          <button className={`toggle ${state?.enabled ? "on" : ""}`} onClick={toggleEnabled} role="switch" aria-checked={!!state?.enabled} aria-label="Capture traffic"><span className="knob" /></button>
        </label>
      </header>
      {showCaution && (
        <div className="ws-caution-panel">
          <b>Authorized testing only.</b> Only capture, replay, intercept or fuzz systems you own or have explicit written permission to test. WebScope works on your own browser traffic and is gated to the scope allowlist.
        </div>
      )}
      <nav className="ws-tabs" role="tablist" aria-label="WebScope tools">
        {NAV_GROUPS.map((g, gi) => (
          <div className="ws-tabgroup" key={gi}>
            {g.items.map((item) => {
              const idx = ALL_VIEWS.indexOf(item.id);
              return (
                <button
                  key={item.id}
                  ref={(el) => { tabRefs.current[idx] = el; }}
                  role="tab"
                  aria-selected={view === item.id}
                  tabIndex={view === item.id ? 0 : -1}
                  className={`ws-tab ${view === item.id ? "active" : ""}`}
                  onClick={() => setView(item.id)}
                  onKeyDown={(e) => onTabKey(e, idx)}
                >
                  {item.label}
                </button>
              );
            })}
          </div>
        ))}
      </nav>
      {state && <ScopeStrip scope={state.scope} onEdit={() => setView("scope")} />}
      <main className="ws-body">
        {!state ? (
          <div className="ws-view"><Loading label="Starting WebScope" /></div>
        ) : (
          <>
            {/* Data views mount when shown, so they always load fresh data. */}
            {view === "history" && <HistoryView onRepeater={goRepeater} onFuzzer={goFuzzer} onCompare={goCompare} />}
            {view === "intercept" && <InterceptView state={state} visible />}
            {view === "target" && <TargetView />}
            {view === "findings" && <FindingsView />}
            {view === "scope" && <ScopeView scope={state.scope} reload={reload} goBack={() => setView("history")} />}
            {view === "rules" && <RulesView rules={state.rules} reload={reload} />}
            {/* Workspaces stay alive once opened, so tabs, drafts and results survive tool switches. */}
            {opened.has("repeater") && <div className="ws-keep" hidden={view !== "repeater"}><RepeaterView seed={seed} seedNonce={seedNonce} /></div>}
            {opened.has("fuzzer") && <div className="ws-keep" hidden={view !== "fuzzer"}><FuzzerView seed={fuzzSeed} seedNonce={fuzzNonce} /></div>}
            {opened.has("decoder") && <div className="ws-keep" hidden={view !== "decoder"}><DecoderView /></div>}
            {opened.has("comparer") && <div className="ws-keep" hidden={view !== "comparer"}><ComparerView seedIds={compareIds} /></div>}
          </>
        )}
      </main>
    </div>
  );
}

createRoot(document.getElementById("root") as HTMLElement).render(<App />);
