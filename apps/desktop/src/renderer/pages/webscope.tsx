import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  PayloadSet,
  ResponseComparison,
  RuleSet,
  Scope,
  ScopeEntry,
  SitemapNode,
} from "@corvus/webscope";
import type { WebScopeInterceptState, WebScopeState } from "../../shared/webscope-ipc";
import { internalApi, errorMessage } from "../common/api";
import { IconShield, IconWarning } from "../common/icons";
import "../common/theme.css";
import "./webscope.css";
import {
  DiffPane,
  MethodBadge,
  draftToRequest,
  emptyDraft,
  fmtBytes,
  fmtMs,
  headersToText,
  newId,
  statusClass,
  type RequestDraft,
} from "./webscope-lib";

const api = internalApi();

type View = "history" | "intercept" | "repeater" | "fuzzer" | "target" | "findings" | "rules" | "scope" | "decoder" | "comparer";
const NAV: Array<{ id: View; label: string }> = [
  { id: "history", label: "History" },
  { id: "intercept", label: "Intercept" },
  { id: "target", label: "Target" },
  { id: "findings", label: "Findings" },
  { id: "repeater", label: "Repeater" },
  { id: "fuzzer", label: "Fuzzer" },
  { id: "rules", label: "Rules" },
  { id: "scope", label: "Scope" },
  { id: "decoder", label: "Decoder" },
  { id: "comparer", label: "Comparer" },
];

function requestText(e: HistoryEntry): string {
  const lines = [`${e.request.method} ${e.request.url}`, ...e.request.headers.map((h) => `${h.name}: ${h.value}`)];
  if (e.request.body) lines.push("", e.request.bodyBase64 ? "[binary body]" : e.request.body);
  return lines.join("\n");
}
function responseText(e: HistoryEntry): string {
  if (e.error) return `error: ${e.error}`;
  const r = e.response;
  if (!r) return "(no response)";
  const lines = [`${r.status} ${r.statusText ?? ""}`.trim(), ...r.headers.map((h) => `${h.name}: ${h.value}`)];
  if (r.body) lines.push("", r.bodyBase64 ? `[binary body, ${r.size ?? 0} bytes]` : r.body);
  return lines.join("\n");
}

function StatusCell({ status }: { status: number | null }) {
  return <span className={statusClass(status)}>{status ?? "ERR"}</span>;
}

// ------------------------------------------------------------------ History

function HistoryView({ onSeed, onCompare }: { onSeed: (e: HistoryEntry) => void; onCompare: (ids: string[]) => void }) {
  const [rows, setRows] = useState<HistorySummary[]>([]);
  const [filter, setFilter] = useState<HistoryFilter>({});
  const [selected, setSelected] = useState<HistoryEntry | null>(null);
  const [marked, setMarked] = useState<string[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);

  const reload = useCallback(() => {
    void api.call("webscope.history", filter, 500).then(setRows);
  }, [filter]);
  useEffect(() => {
    const t = setTimeout(reload, 120);
    return () => clearTimeout(t);
  }, [reload]);

  const open = (id: string): void => {
    void api.call("webscope.detail", id).then(setSelected);
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
    void file.text().then((text) => {
      try {
        void api.call("webscope.importHar", JSON.parse(text)).then(reload);
      } catch {
        alert("That file is not valid JSON/HAR.");
      }
    });
  };

  return (
    <div className="ws-main">
      <div className="ws-head">
        <h2>HTTP history</h2>
        <span className="sub">{rows.length} shown</span>
        <div className="ws-spacer" />
        <div className="ws-toolbar">
          <input className="input" placeholder="filter host" style={{ width: 150 }} onChange={(e) => setFilter((f) => ({ ...f, host: e.target.value || undefined }))} />
          <input className="input" placeholder="search url/body" style={{ width: 170 }} onChange={(e) => setFilter((f) => ({ ...f, search: e.target.value || undefined }))} />
          <select className="input" onChange={(e) => setFilter((f) => ({ ...f, statusClass: e.target.value ? (Number(e.target.value) as HistoryFilter["statusClass"]) : undefined }))}>
            <option value="">all status</option>
            <option value="2">2xx</option>
            <option value="3">3xx</option>
            <option value="4">4xx</option>
            <option value="5">5xx</option>
          </select>
          <label className="ws-check">
            <input type="checkbox" onChange={(e) => setFilter((f) => ({ ...f, onlyInScope: e.target.checked || undefined }))} /> in-scope
          </label>
          <button className="btn small" onClick={exportHar}>Export HAR</button>
          <button className="btn small" onClick={() => fileRef.current?.click()}>Import</button>
          <input ref={fileRef} type="file" accept=".har,.json,application/json" hidden onChange={(e) => e.target.files?.[0] && importHar(e.target.files[0])} />
          <button className="btn small" disabled={marked.length !== 2} onClick={() => onCompare(marked)}>Compare ({marked.length})</button>
          <button className="btn small danger" onClick={() => void api.call("webscope.clearHistory").then(reload)}>Clear</button>
        </div>
      </div>
      <div className="ws-content split">
        <div className="ws-tablewrap">
          <table className="ws-table">
            <thead>
              <tr>
                <th></th>
                <th></th>
                <th>method</th>
                <th>host</th>
                <th>path</th>
                <th>status</th>
                <th>type</th>
                <th>len</th>
                <th>time</th>
                <th>src</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className={selected?.id === r.id ? "sel" : ""} onClick={() => open(r.id)}>
                  <td onClick={(e) => { e.stopPropagation(); toggleMark(r.id); }}>
                    <input type="checkbox" checked={marked.includes(r.id)} readOnly />
                  </td>
                  <td><span className={`scope-dot${r.inScope ? "" : " oos"}`} /></td>
                  <td><MethodBadge method={r.method} /></td>
                  <td className={r.inScope ? "" : "oos"}>{r.host}</td>
                  <td className="path">{r.path}</td>
                  <td><StatusCell status={r.status} /></td>
                  <td className="oos">{r.type}</td>
                  <td>{fmtBytes(r.length)}</td>
                  <td>{fmtMs(r.durationMs)}</td>
                  <td className="oos">{r.source}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {rows.length === 0 && <div className="ws-empty">No traffic captured yet. Enable WebScope and browse an in-scope site.</div>}
        </div>
        <div className="ws-content cols">
          <div className="ws-pane">
            <div className="ws-pane-head">
              request
              {selected && <button className="btn small" style={{ marginLeft: "auto" }} onClick={() => onSeed(selected)}>Send to Repeater →</button>}
            </div>
            <pre className="ws-pre">{selected ? requestText(selected) : "Select a row to inspect."}</pre>
          </div>
          <div className="ws-pane right">
            <div className="ws-pane-head">response</div>
            <pre className="ws-pre">{selected ? responseText(selected) : ""}</pre>
          </div>
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ Repeater

function RepeaterView({ seed }: { seed: HistoryEntry | null }) {
  const [draft, setDraft] = useState<RequestDraft>(emptyDraft());
  const [result, setResult] = useState<HistoryEntry | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!seed) return;
    setDraft({
      method: seed.request.method,
      url: seed.request.url,
      headersText: headersToText(seed.request.headers),
      body: seed.request.body && !seed.request.bodyBase64 ? seed.request.body : "",
      useProfileCookies: false,
      followRedirects: false,
    });
    setResult(null);
  }, [seed]);

  const send = (): void => {
    setBusy(true);
    setError(null);
    api.call("webscope.send", draftToRequest(draft)).then(
      (entry) => { setResult(entry); setBusy(false); },
      (err: unknown) => { setError(errorMessage(err)); setBusy(false); },
    );
  };

  const upd = (patch: Partial<RequestDraft>): void => setDraft((d) => ({ ...d, ...patch }));

  return (
    <div className="ws-main">
      <div className="ws-head">
        <h2>Repeater</h2>
        <span className="sub">in-scope targets only</span>
        <div className="ws-spacer" />
        <label className="ws-check"><input type="checkbox" checked={draft.useProfileCookies} onChange={(e) => upd({ useProfileCookies: e.target.checked })} /> reuse cookies</label>
        <label className="ws-check"><input type="checkbox" checked={draft.followRedirects} onChange={(e) => upd({ followRedirects: e.target.checked })} /> follow redirects</label>
        <button className="btn small primary" disabled={busy || !draft.url} onClick={send}>{busy ? "Sending…" : "Send"}</button>
      </div>
      <div className="ws-content cols">
        <div className="ws-pane">
          <div className="ws-pane-head">request</div>
          <div style={{ padding: 10, display: "flex", flexDirection: "column", gap: 8, overflow: "auto" }}>
            <div className="ws-row">
              <select className="input" style={{ width: 100 }} value={draft.method} onChange={(e) => upd({ method: e.target.value })}>
                {["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].map((m) => <option key={m}>{m}</option>)}
              </select>
              <input className="input grow mono" placeholder="https://host.in.scope/path" value={draft.url} onChange={(e) => upd({ url: e.target.value })} />
            </div>
            <textarea className="input mono" rows={7} placeholder="Header-Name: value (one per line)" value={draft.headersText} onChange={(e) => upd({ headersText: e.target.value })} />
            <textarea className="input mono" rows={6} placeholder="request body" value={draft.body} onChange={(e) => upd({ body: e.target.value })} />
            {error && <div className="ws-error">{error}</div>}
          </div>
        </div>
        <div className="ws-pane right">
          <div className="ws-pane-head">
            response
            {result?.response && <span style={{ marginLeft: "auto" }} className={statusClass(result.response.status)}>{result.response.status} · {fmtBytes(result.response.size ?? 0)} · {fmtMs(result.durationMs ?? null)}</span>}
          </div>
          <pre className="ws-pre">{result ? responseText(result) : "Send a request to see the response."}</pre>
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ Fuzzer

interface PayloadSetDraft { kind: PayloadSet["kind"]; text: string; from: string; to: string; step: string }

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

function FuzzerView() {
  const [draft, setDraft] = useState<RequestDraft>({ ...emptyDraft(), method: "GET" });
  const [attack, setAttack] = useState<"sniper" | "cluster-bomb" | "pitchfork">("sniper");
  const [extract, setExtract] = useState("");
  const [sets, setSets] = useState<PayloadSetDraft[]>([{ kind: "wordlist", text: "", from: "0", to: "100", step: "1" }]);
  const [rps, setRps] = useState("5");
  const [concurrency, setConcurrency] = useState("2");
  const [grep, setGrep] = useState("");
  const [authorized, setAuthorized] = useState(false);
  const [running, setRunning] = useState(false);
  const [rows, setRows] = useState<FuzzResultRow[]>([]);
  const [summary, setSummary] = useState<FuzzSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  const toSet = (d: PayloadSetDraft): PayloadSet => {
    if (d.kind === "wordlist") return { kind: "wordlist", values: d.text.split("\n").map((s) => s.trim()).filter(Boolean) };
    if (d.kind === "charset") return { kind: "charset", charset: d.text.replace(/\n/g, "") };
    return { kind: "numbers", from: Number(d.from) || 0, to: Number(d.to) || 0, step: Number(d.step) || 1 };
  };

  const start = (): void => {
    if (!authorized) return;
    if (!confirm("Start a fuzzing attack against the in-scope target? Only run this against systems you are authorized to test.")) return;
    setRunning(true);
    setError(null);
    setRows([]);
    const config = {
      template: draftToRequest(draft),
      attack,
      payloadSets: sets.map(toSet),
      concurrency: Number(concurrency) || 2,
      requestsPerSecond: Number(rps) || 5,
      grep: grep.split("\n").map((s) => s.trim()).filter(Boolean),
      useProfileCookies: draft.useProfileCookies,
    };
    api.call("webscope.fuzz", config).then(
      (res) => { setRows(res.rows); setSummary(res.summary); setRunning(false); },
      (err: unknown) => { setError(errorMessage(err)); setRunning(false); },
    );
  };

  const updSet = (i: number, patch: Partial<PayloadSetDraft>): void => setSets((s) => s.map((x, j) => (j === i ? { ...x, ...patch } : x)));

  return (
    <div className="ws-main">
      <div className="ws-head">
        <h2>Fuzzer</h2>
        <span className="sub">mark positions with §payload§ · in-scope only</span>
        <div className="ws-spacer" />
        <button className="btn small primary" disabled={running || !authorized || !draft.url} onClick={start}>{running ? "Running…" : "Start attack"}</button>
      </div>
      <div className="ws-content" style={{ display: "grid", gridTemplateColumns: "360px 1fr", gap: 0, padding: 0 }}>
        <div className="ws-pane" style={{ borderTop: "none", borderRight: "1px solid var(--border)" }}>
          <div className="ws-pane-head">attack setup</div>
          <div style={{ padding: 10, display: "flex", flexDirection: "column", gap: 10, overflow: "auto" }}>
            <div className="ws-row">
              <select className="input" style={{ width: 90 }} value={draft.method} onChange={(e) => setDraft((d) => ({ ...d, method: e.target.value }))}>
                {["GET", "POST", "PUT", "DELETE"].map((m) => <option key={m}>{m}</option>)}
              </select>
              <input className="input grow mono" placeholder="https://host/path?q=§FUZZ§" value={draft.url} onChange={(e) => setDraft((d) => ({ ...d, url: e.target.value }))} />
            </div>
            <textarea className="input mono" rows={3} placeholder="headers (optional)" value={draft.headersText} onChange={(e) => setDraft((d) => ({ ...d, headersText: e.target.value }))} />
            <textarea className="input mono" rows={3} placeholder="body (optional, §mark§ positions)" value={draft.body} onChange={(e) => setDraft((d) => ({ ...d, body: e.target.value }))} />
            <div className="ws-row">
              <label className="ws-label" style={{ flex: 1 }}>attack
                <select className="input" value={attack} onChange={(e) => setAttack(e.target.value as "sniper" | "cluster-bomb" | "pitchfork")}>
                  <option value="sniper">sniper (one position)</option>
                  <option value="cluster-bomb">cluster-bomb (all combos)</option>
                  <option value="pitchfork">pitchfork (sets in lockstep)</option>
                </select>
              </label>
            </div>
            {sets.map((s, i) => (
              <div className="ws-card" key={i}>
                <div className="ws-row" style={{ marginBottom: 6 }}>
                  <select className="input" value={s.kind} onChange={(e) => updSet(i, { kind: e.target.value as PayloadSet["kind"] })}>
                    <option value="wordlist">wordlist</option>
                    <option value="numbers">numbers</option>
                    <option value="charset">charset</option>
                  </select>
                  <span className="ws-note">set {i + 1}</span>
                  {sets.length > 1 && <button className="btn small ghost" style={{ marginLeft: "auto" }} onClick={() => setSets((ss) => ss.filter((_, j) => j !== i))}>remove</button>}
                </div>
                {s.kind === "numbers" ? (
                  <div className="ws-row">
                    <input className="input ws-field-sm" placeholder="from" value={s.from} onChange={(e) => updSet(i, { from: e.target.value })} />
                    <input className="input ws-field-sm" placeholder="to" value={s.to} onChange={(e) => updSet(i, { to: e.target.value })} />
                    <input className="input ws-field-sm" placeholder="step" value={s.step} onChange={(e) => updSet(i, { step: e.target.value })} />
                  </div>
                ) : (
                  <textarea className="input mono" rows={3} placeholder={s.kind === "charset" ? "characters e.g. abc123" : "one payload per line (you supply the wordlist)"} value={s.text} onChange={(e) => updSet(i, { text: e.target.value })} />
                )}
              </div>
            ))}
            {(attack === "cluster-bomb" || attack === "pitchfork") && <button className="btn small" onClick={() => setSets((s) => [...s, { kind: "wordlist", text: "", from: "0", to: "100", step: "1" }])}>+ payload set</button>}
            <div className="ws-row">
              <label className="ws-label" style={{ flex: 1 }}>req/sec (max 10)
                <input className="input" value={rps} onChange={(e) => setRps(e.target.value)} />
              </label>
              <label className="ws-label" style={{ flex: 1 }}>concurrency
                <input className="input" value={concurrency} onChange={(e) => setConcurrency(e.target.value)} />
              </label>
            </div>
            <textarea className="input mono" rows={2} placeholder="grep terms (one per line)" value={grep} onChange={(e) => setGrep(e.target.value)} />
            <textarea className="input mono" rows={2} placeholder="extract regex (one per line, first capture group)" value={extract} onChange={(e) => setExtract(e.target.value)} />
            <label className="ws-check"><input type="checkbox" checked={draft.useProfileCookies} onChange={(e) => setDraft((d) => ({ ...d, useProfileCookies: e.target.checked }))} /> reuse profile cookies</label>
            <label className="ws-check" style={{ color: "var(--ws-signal)" }}><input type="checkbox" checked={authorized} onChange={(e) => setAuthorized(e.target.checked)} /> I am authorized to test this target</label>
            {error && <div className="ws-error">{error}</div>}
          </div>
        </div>
        <div className="ws-pane" style={{ borderTop: "none" }}>
          <div className="ws-pane-head">
            results {summary && <span>{summary.completed}/{summary.total} · {summary.config.requestsPerSecond}/s</span>}
            {rows.length > 0 && <button className="btn small" style={{ marginLeft: "auto" }} onClick={() => exportCsv(rows)}>Export CSV</button>}
          </div>
          <div className="ws-tablewrap">
            <table className="ws-table">
              <thead><tr><th>#</th><th>payloads</th><th>status</th><th>len</th><th>time</th><th>grep</th><th>extract</th></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.index}>
                    <td>{r.index}</td>
                    <td className="path">{r.payloads.join(" · ")}</td>
                    <td>{r.error ? <span className="st-5">{r.error}</span> : <StatusCell status={r.status} />}</td>
                    <td>{fmtBytes(r.length)}</td>
                    <td>{fmtMs(r.durationMs)}</td>
                    <td className="hit">{r.matched.join(", ")}</td>
                    <td className="hit">{(r.extracted ?? []).join(", ")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {rows.length === 0 && !running && <div className="ws-empty">Configure positions and payloads, confirm authorization, then start.</div>}
          </div>
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ Scope

function ScopeView({ scope, reload }: { scope: Scope; reload: () => void }) {
  const [draft, setDraft] = useState<Scope>(scope);
  const [saved, setSaved] = useState(false);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  useEffect(() => setDraft(scope), [scope]);
  useEffect(() => { void api.call("webscope.audit", 50).then(setAudit); }, [saved]);

  const save = (): void => { void api.call("webscope.setScope", draft).then(() => { setSaved((s) => !s); reload(); }); };
  const addEntry = (key: "include" | "exclude"): void => setDraft((d) => ({ ...d, [key]: [...d[key], { host: "", enabled: true }] }));
  const updEntry = (key: "include" | "exclude", i: number, patch: Partial<ScopeEntry>): void =>
    setDraft((d) => ({ ...d, [key]: d[key].map((e, j) => (j === i ? { ...e, ...patch } : e)) }));
  const delEntry = (key: "include" | "exclude", i: number): void => setDraft((d) => ({ ...d, [key]: d[key].filter((_, j) => j !== i) }));

  const list = (key: "include" | "exclude") => (
    <div className="ws-card">
      <h3>{key === "include" ? "In scope (allowlist)" : "Excluded"}</h3>
      {draft[key].map((e, i) => (
        <div className="ws-rule" key={i} style={{ gridTemplateColumns: "auto 1fr 120px 90px auto" }}>
          <input type="checkbox" checked={e.enabled} onChange={(ev) => updEntry(key, i, { enabled: ev.target.checked })} />
          <input className="input mono" placeholder="host glob e.g. *.example.com" value={e.host} onChange={(ev) => updEntry(key, i, { host: ev.target.value })} />
          <input className="input mono" placeholder="/path prefix" value={e.pathPrefix ?? ""} onChange={(ev) => updEntry(key, i, { pathPrefix: ev.target.value || undefined })} />
          <input className="input mono" placeholder="port" value={e.port ?? ""} onChange={(ev) => updEntry(key, i, { port: ev.target.value ? Number(ev.target.value) : undefined })} />
          <button className="btn small ghost" onClick={() => delEntry(key, i)}>✕</button>
        </div>
      ))}
      <button className="btn small" onClick={() => addEntry(key)}>+ entry</button>
    </div>
  );

  return (
    <div className="ws-main">
      <div className="ws-head">
        <h2>Scope</h2>
        <span className="sub">nothing is acted on unless it matches an enabled include and no exclude</span>
        <div className="ws-spacer" />
        <label className="ws-check"><input type="checkbox" checked={draft.enabled} onChange={(e) => setDraft((d) => ({ ...d, enabled: e.target.checked }))} /> scope enabled</label>
        <button className="btn small primary" onClick={save}>Save scope</button>
      </div>
      <div className="ws-content">
        <div className="ws-form">
          {list("include")}
          {list("exclude")}
          <div className="ws-card">
            <h3>Audit log</h3>
            <div className="ws-tablewrap" style={{ maxHeight: 200 }}>
              <table className="ws-table">
                <tbody>
                  {audit.map((a, i) => (
                    <tr key={i} style={{ cursor: "default" }}>
                      <td style={{ width: 150 }}>{new Date(a.at).toLocaleTimeString()}</td>
                      <td style={{ width: 120 }}>{a.action}</td>
                      <td className="path">{a.detail}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {audit.length === 0 && <div className="ws-empty">No actions recorded yet.</div>}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ Rules

function RulesView({ rules, reload }: { rules: RuleSet; reload: () => void }) {
  const [draft, setDraft] = useState<RuleSet>(rules);
  useEffect(() => setDraft(rules), [rules]);
  const save = (): void => { void api.call("webscope.setRules", draft).then(reload); };

  const addMr = (): void => setDraft((d) => ({ ...d, matchReplace: [...d.matchReplace, { id: newId(), name: "", enabled: true, target: "request-header", match: "", replace: "", regex: false }] }));
  const updMr = (i: number, patch: Partial<MatchReplaceRule>): void => setDraft((d) => ({ ...d, matchReplace: d.matchReplace.map((r, j) => (j === i ? { ...r, ...patch } : r)) }));
  const addBlock = (): void => setDraft((d) => ({ ...d, block: [...d.block, { id: newId(), name: "", enabled: true, pattern: "" }] }));
  const updBlock = (i: number, patch: Partial<BlockRule>): void => setDraft((d) => ({ ...d, block: d.block.map((r, j) => (j === i ? { ...r, ...patch } : r)) }));
  const addOv = (): void => setDraft((d) => ({ ...d, hostOverride: [...d.hostOverride, { id: newId(), enabled: true, host: "", address: "" }] }));
  const updOv = (i: number, patch: Partial<HostOverride>): void => setDraft((d) => ({ ...d, hostOverride: d.hostOverride.map((r, j) => (j === i ? { ...r, ...patch } : r)) }));

  return (
    <div className="ws-main">
      <div className="ws-head">
        <h2>Rules</h2>
        <span className="sub">applied to in-scope requests (repeater &amp; fuzzer)</span>
        <div className="ws-spacer" />
        <button className="btn small primary" onClick={save}>Save rules</button>
      </div>
      <div className="ws-content">
        <div className="ws-form">
          <div className="ws-card">
            <h3>Match &amp; replace</h3>
            {draft.matchReplace.map((r, i) => (
              <div className="ws-rule" key={r.id} style={{ gridTemplateColumns: "auto 130px 1fr 1fr auto auto" }}>
                <input type="checkbox" checked={r.enabled} onChange={(e) => updMr(i, { enabled: e.target.checked })} />
                <select className="input" value={r.target} onChange={(e) => updMr(i, { target: e.target.value as MatchReplaceRule["target"] })}>
                  <option value="request-header">req header</option>
                  <option value="request-body">req body</option>
                  <option value="request-url">req url</option>
                  <option value="response-header">res header</option>
                  <option value="response-body">res body</option>
                </select>
                <input className="input mono" placeholder="match" value={r.match} onChange={(e) => updMr(i, { match: e.target.value })} />
                <input className="input mono" placeholder="replace" value={r.replace} onChange={(e) => updMr(i, { replace: e.target.value })} />
                <label className="ws-check"><input type="checkbox" checked={r.regex} onChange={(e) => updMr(i, { regex: e.target.checked })} /> re</label>
                <button className="btn small ghost" onClick={() => setDraft((d) => ({ ...d, matchReplace: d.matchReplace.filter((_, j) => j !== i) }))}>✕</button>
              </div>
            ))}
            <button className="btn small" onClick={addMr}>+ rule</button>
          </div>
          <div className="ws-card">
            <h3>Block</h3>
            {draft.block.map((r, i) => (
              <div className="ws-rule" key={r.id} style={{ gridTemplateColumns: "auto 180px 1fr auto" }}>
                <input type="checkbox" checked={r.enabled} onChange={(e) => updBlock(i, { enabled: e.target.checked })} />
                <input className="input" placeholder="name" value={r.name} onChange={(e) => updBlock(i, { name: e.target.value })} />
                <input className="input mono" placeholder="url glob e.g. https://*/ads*" value={r.pattern} onChange={(e) => updBlock(i, { pattern: e.target.value })} />
                <button className="btn small ghost" onClick={() => setDraft((d) => ({ ...d, block: d.block.filter((_, j) => j !== i) }))}>✕</button>
              </div>
            ))}
            <button className="btn small" onClick={addBlock}>+ block</button>
          </div>
          <div className="ws-card">
            <h3>Host overrides (DNS-style)</h3>
            {draft.hostOverride.map((r, i) => (
              <div className="ws-rule" key={r.id} style={{ gridTemplateColumns: "auto 1fr 1fr auto" }}>
                <input type="checkbox" checked={r.enabled} onChange={(e) => updOv(i, { enabled: e.target.checked })} />
                <input className="input mono" placeholder="host" value={r.host} onChange={(e) => updOv(i, { host: e.target.value })} />
                <input className="input mono" placeholder="address e.g. 127.0.0.1" value={r.address} onChange={(e) => updOv(i, { address: e.target.value })} />
                <button className="btn small ghost" onClick={() => setDraft((d) => ({ ...d, hostOverride: d.hostOverride.filter((_, j) => j !== i) }))}>✕</button>
              </div>
            ))}
            <button className="btn small" onClick={addOv}>+ override</button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ Decoder

const OPS = [
  ["base64-encode", "base64 enc"], ["base64-decode", "base64 dec"],
  ["url-encode", "url enc"], ["url-decode", "url dec"],
  ["html-encode", "html enc"], ["html-decode", "html dec"],
  ["hex-encode", "hex enc"], ["hex-decode", "hex dec"],
] as const;
const HASHES = ["md5", "sha1", "sha256", "sha512"] as const;

function DecoderView() {
  const [input, setInput] = useState("");
  const [output, setOutput] = useState("");
  const run = (fn: () => Promise<string>): void => { fn().then(setOutput, (e: unknown) => setOutput(`error: ${errorMessage(e)}`)); };
  return (
    <div className="ws-main">
      <div className="ws-head"><h2>Decoder</h2><span className="sub">encode / decode / hash / inspect JWTs</span></div>
      <div className="ws-content cols">
        <div className="ws-pane">
          <div className="ws-pane-head">input</div>
          <textarea className="ws-pre" style={{ border: "none", background: "transparent", outline: "none", resize: "none" }} value={input} onChange={(e) => setInput(e.target.value)} />
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, padding: 10, borderTop: "1px solid var(--border)" }}>
            {OPS.map(([op, label]) => <button key={op} className="btn small" onClick={() => run(() => api.call("webscope.encode", op, input))}>{label}</button>)}
            {HASHES.map((h) => <button key={h} className="btn small" onClick={() => run(() => api.call("webscope.hash", h, input))}>{h}</button>)}
            <button className="btn small" onClick={() => run(() => api.call("webscope.jwt", input).then((p) => JSON.stringify(p, null, 2)))}>jwt decode</button>
          </div>
        </div>
        <div className="ws-pane right">
          <div className="ws-pane-head">output {output && <button className="btn small" style={{ marginLeft: "auto" }} onClick={() => { setInput(output); setOutput(""); }}>↑ use as input</button>}</div>
          <pre className="ws-pre">{output}</pre>
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ Comparer

function ComparerView({ seedIds }: { seedIds: string[] }) {
  const [history, setHistory] = useState<HistorySummary[]>([]);
  const [a, setA] = useState(seedIds[0] ?? "");
  const [b, setB] = useState(seedIds[1] ?? "");
  const [diff, setDiff] = useState<ResponseComparison | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { void api.call("webscope.history", {}, 300).then(setHistory); }, []);
  useEffect(() => { setA(seedIds[0] ?? ""); setB(seedIds[1] ?? ""); }, [seedIds]);
  useEffect(() => {
    if (!a || !b) return;
    api.call("webscope.compare", a, b).then((d) => { setDiff(d); setError(null); }, (e: unknown) => setError(errorMessage(e)));
  }, [a, b]);
  const opts = useMemo(() => history.map((h) => ({ id: h.id, label: `${h.method} ${h.host}${h.path} [${h.status ?? "err"}]` })), [history]);
  return (
    <div className="ws-main">
      <div className="ws-head">
        <h2>Comparer</h2>
        <div className="ws-spacer" />
        <select className="input mono" style={{ maxWidth: 320 }} value={a} onChange={(e) => setA(e.target.value)}><option value="">pick A…</option>{opts.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}</select>
        <select className="input mono" style={{ maxWidth: 320 }} value={b} onChange={(e) => setB(e.target.value)}><option value="">pick B…</option>{opts.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}</select>
      </div>
      <div className="ws-content split" style={{ gridTemplateRows: "1fr" }}>
        <div className="ws-pane" style={{ borderTop: "none" }}>
          <div className="ws-pane-head">response diff (A vs B)</div>
          {error ? <div className="ws-empty">{error}</div> : diff ? <DiffPane diff={diff} /> : <div className="ws-empty">Pick two exchanges to diff their responses.</div>}
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ Intercept

function headersText(headers: HttpHeader[]): string {
  return headers.map((h) => `${h.name}: ${h.value}`).join("\n");
}

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

function InterceptView({ state }: { state: WebScopeState }) {
  const [intercept, setIntercept] = useState<WebScopeInterceptState | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [edit, setEdit] = useState<{ method: string; url: string; headers: string; body: string } | null>(null);

  const reload = useCallback(() => { void api.call("webscope.interceptState").then(setIntercept); }, []);
  useEffect(() => {
    reload();
    const t = setInterval(reload, 800); // poll the held queue
    return () => clearInterval(t);
  }, [reload]);

  const config = intercept?.config ?? { enabled: false, interceptRequests: true, interceptResponses: false };
  const queue = intercept?.queue ?? [];
  const held = queue.find((q) => q.id === selected) ?? queue[0] ?? null;

  useEffect(() => {
    if (held && held.id !== (edit && selected)) {
      setSelected(held.id);
      setEdit({ method: held.request.method, url: held.request.url, headers: headersText(held.request.headers), body: held.request.body ?? "" });
    }
    if (!held) setEdit(null);
  }, [held, selected, edit]);

  const setConfig = (patch: Partial<typeof config>): void => {
    void api.call("webscope.setInterceptConfig", { ...config, ...patch }).then(setIntercept);
  };
  const forward = (useEdit: boolean): void => {
    if (!held) return;
    const payload = useEdit && edit ? { method: edit.method, url: edit.url, headers: parseHeaders(edit.headers), body: edit.body } : null;
    void api.call("webscope.interceptForward", held.id, payload).then(setIntercept);
  };
  const drop = (): void => { if (held) void api.call("webscope.interceptDrop", held.id).then(setIntercept); };

  return (
    <div className="ws-main">
      <div className="ws-head">
        <h2>Intercept</h2>
        <span className="sub">{queue.length} held</span>
        <div className="ws-spacer" />
        <label className="ws-toggle">
          <input type="checkbox" checked={config.enabled} onChange={(e) => setConfig({ enabled: e.target.checked })} /> Intercept {config.enabled ? "on" : "off"}
        </label>
        <label className="ws-toggle">
          <input type="checkbox" checked={config.interceptResponses} disabled={!config.enabled} onChange={(e) => setConfig({ interceptResponses: e.target.checked })} /> Hold responses
        </label>
      </div>
      {!state.enabled && <div className="ws-note warn">WebScope is off — enable it (top right) to attach to your traffic.</div>}
      <div className="ws-content ws-intercept">
        <div className="ws-queue">
          {queue.length === 0 ? (
            <div className="ws-empty">{config.enabled ? "Waiting for an in-scope request…" : "Turn interception on to hold requests."}</div>
          ) : (
            queue.map((q) => (
              <button key={q.id} className={`ws-queue-row ${q.id === held?.id ? "on" : ""}`} onClick={() => setSelected(q.id)}>
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
              <div className="ws-editor-line">
                <input className="ws-input mono" value={edit.method} onChange={(e) => setEdit({ ...edit, method: e.target.value })} style={{ width: 70 }} disabled={held.phase === "response"} />
                <input className="ws-input mono" value={edit.url} onChange={(e) => setEdit({ ...edit, url: e.target.value })} disabled={held.phase === "response"} />
              </div>
              <label className="ws-label">Headers</label>
              <textarea className="ws-area mono" rows={6} value={edit.headers} onChange={(e) => setEdit({ ...edit, headers: e.target.value })} />
              <label className="ws-label">Body</label>
              <textarea className="ws-area mono" rows={6} value={edit.body} onChange={(e) => setEdit({ ...edit, body: e.target.value })} />
              <div className="ws-editor-actions">
                <button className="btn" onClick={() => forward(true)}>Forward edited</button>
                <button className="btn ghost" onClick={() => forward(false)}>Forward</button>
                <button className="btn danger" onClick={drop}>Drop</button>
              </div>
            </>
          ) : (
            <div className="ws-empty">Nothing held. Matching in-scope requests will pause here.</div>
          )}
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ Target (sitemap)

function SitemapRows({ nodes, depth }: { nodes: SitemapNode[]; depth: number }) {
  return (
    <>
      {nodes.map((n) => (
        <div key={n.path}>
          <div className="ws-tree-row" style={{ paddingLeft: 10 + depth * 16 }}>
            <span className="ws-tree-seg">{n.segment}</span>
            <span className="ws-tree-methods">{n.methods.join(" ")}</span>
            <span className="ws-tree-count">{n.count}</span>
          </div>
          {n.children.length > 0 && <SitemapRows nodes={n.children} depth={depth + 1} />}
        </div>
      ))}
    </>
  );
}

function TargetView() {
  const [tree, setTree] = useState<SitemapNode[] | null>(null);
  useEffect(() => { void api.call("webscope.sitemap").then(setTree); }, []);
  return (
    <div className="ws-main">
      <div className="ws-head"><h2>Target</h2><span className="sub">sitemap of captured hosts</span></div>
      <div className="ws-content ws-tree">
        {tree && tree.length > 0 ? <SitemapRows nodes={tree} depth={0} /> : <div className="ws-empty">No captured traffic yet.</div>}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ Findings

const SEVERITY_LABEL: Record<FindingSeverity, string> = { medium: "Medium", low: "Low", info: "Info" };

function FindingsView() {
  const [findings, setFindings] = useState<Finding[] | null>(null);
  useEffect(() => { void api.call("webscope.findings").then(setFindings); }, []);
  return (
    <div className="ws-main">
      <div className="ws-head"><h2>Findings</h2><span className="sub">{findings ? `${findings.length} passive` : "…"}</span></div>
      <div className="ws-note warn">Passive observations from captured responses only. Nothing here was actively tested or exploited.</div>
      <div className="ws-content ws-findings">
        {findings && findings.length > 0 ? (
          findings.map((f) => (
            <div key={f.id} className="ws-finding">
              <div className="ws-finding-head">
                <span className={`ws-sev ${f.severity}`}>{SEVERITY_LABEL[f.severity]}</span>
                <span className="ws-finding-title">{f.title}</span>
                <span className="ws-finding-loc">{f.host}{f.path}</span>
              </div>
              <p className="ws-finding-detail">{f.detail}</p>
            </div>
          ))
        ) : (
          <div className="ws-empty">No findings. Browse in-scope sites to populate this.</div>
        )}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ App

function App() {
  const [view, setView] = useState<View>("history");
  const [state, setState] = useState<WebScopeState | null>(null);
  const [seed, setSeed] = useState<HistoryEntry | null>(null);
  const [compareIds, setCompareIds] = useState<string[]>([]);

  const reload = useCallback(() => { void api.call("webscope.state").then(setState); }, []);
  useEffect(() => { reload(); }, [reload]);

  const toggleEnabled = (): void => {
    if (!state) return;
    void api.call("webscope.setEnabled", !state.enabled).then(setState);
  };

  const goRepeater = (e: HistoryEntry): void => { setSeed(e); setView("repeater"); };
  const goCompare = (ids: string[]): void => { setCompareIds(ids); setView("comparer"); };

  return (
    <div className="ws-root">
      <div className="ws-topbar">
        <div className="ws-brand"><IconShield size={18} /> <b>Corvus</b> <span>WEBSCOPE</span></div>
        <div className="ws-spacer" />
        <div className={`ws-chip ${state?.scope.enabled ? "on" : ""}`}><span className="dot" /> scope {state?.scope.enabled ? "armed" : "off"}</div>
        <div className="ws-chip">captured {state?.historySize ?? 0}</div>
        <label className="ws-check"><span style={{ marginRight: 6 }}>capture</span>
          <button className={`toggle ${state?.enabled ? "on" : ""}`} onClick={toggleEnabled}><span className="knob" /></button>
        </label>
      </div>
      <div className="ws-banner">
        <IconWarning size={16} />
        <span><b>Authorized testing only.</b> Only capture, replay, or fuzz systems you own or have explicit written permission to test. WebScope operates on your own browser traffic and is gated to the scope allowlist.</span>
      </div>
      <div className="ws-body">
        <nav className="ws-nav">
          {NAV.map((n, i) => (
            <button key={n.id} className={view === n.id ? "active" : ""} onClick={() => setView(n.id)}>
              <span className="idx">{String(i + 1).padStart(2, "0")}</span>
              {n.label}
            </button>
          ))}
          <div className="ws-nav-foot">{state ? `${state.historySize} captured · ${state.attachedTabs} tab(s)` : "…"}</div>
        </nav>
        {!state ? (
          <div className="ws-main"><div className="ws-empty">Loading…</div></div>
        ) : view === "history" ? (
          <HistoryView onSeed={goRepeater} onCompare={goCompare} />
        ) : view === "intercept" ? (
          <InterceptView state={state} />
        ) : view === "target" ? (
          <TargetView />
        ) : view === "findings" ? (
          <FindingsView />
        ) : view === "repeater" ? (
          <RepeaterView seed={seed} />
        ) : view === "fuzzer" ? (
          <FuzzerView />
        ) : view === "rules" ? (
          <RulesView rules={state.rules} reload={reload} />
        ) : view === "scope" ? (
          <ScopeView scope={state.scope} reload={reload} />
        ) : view === "decoder" ? (
          <DecoderView />
        ) : (
          <ComparerView seedIds={compareIds} />
        )}
      </div>
    </div>
  );
}

createRoot(document.getElementById("root") as HTMLElement).render(<App />);
