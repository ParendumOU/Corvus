import { useMemo, useState, type ReactNode } from "react";
import type { AssistBridge } from "../../shared/assist-ipc";
import { artifactAsText, formReply, formatValue, type Artifact, type Cell, type FormField } from "../../shared/assist-artifacts";
import { t as tx } from "../common/i18n";

/**
 * Artifacts in Assist answers (see shared/assist-artifacts.ts): drawn by the panel from validated
 * data, never from HTML the model wrote.
 */

type Api = () => AssistBridge;
type Of<T extends Artifact["type"]> = Extract<Artifact, { type: T }>;

export function ArtifactView({ artifact, api, lang, canSend }: { artifact: Artifact; api: Api; lang: string; canSend: boolean }) {
  const [copied, setCopied] = useState(false);
  const copy = (): void => {
    void api()
      .call("assist.copyPlain", artifactAsText(artifact, lang))
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      });
  };
  const body = (() => {
    switch (artifact.type) {
      case "table":
        return <TableArtifact a={artifact} lang={lang} api={api} />;
      case "cards":
        return <CardsArtifact a={artifact} />;
      case "chart":
        return <ChartArtifact a={artifact} lang={lang} />;
      case "links":
        return <LinksArtifact a={artifact} api={api} />;
      case "form":
        return <FormArtifact a={artifact} api={api} canSend={canSend} />;
    }
  })();
  return (
    <section className={`artifact artifact-${artifact.type}`} data-artifact={artifact.type}>
      {(artifact.title || artifact.type !== "form") && (
        <header className="artifact-head">
          <span className="grow">{artifact.title}</span>
          {artifact.type !== "form" && (
            <button className="artifact-copy" title={tx("Copy")} onClick={copy}>
              {copied ? tx("Copied") : tx("Copy")}
            </button>
          )}
        </header>
      )}
      {body}
    </section>
  );
}

export function ArtifactPending() {
  return (
    <div className="artifact pending" aria-busy="true">
      <div className="artifact-skeleton" />
    </div>
  );
}

// ------------------------------------------------------------------ table

function TableArtifact({ a, lang, api }: { a: Of<"table">; lang: string; api: Api }) {
  const [sort, setSort] = useState<{ key: string; dir: 1 | -1 } | null>(null);
  const rows = useMemo(() => {
    if (!sort) return a.rows;
    const value = (c: Cell): string | number => (typeof c === "number" ? c : typeof c === "boolean" ? Number(c) : (c ?? ""));
    return [...a.rows].sort((x, y) => {
      const p = value(x[sort.key] ?? null);
      const q = value(y[sort.key] ?? null);
      const cmp = typeof p === "number" && typeof q === "number" ? p - q : String(p).localeCompare(String(q), lang, { numeric: true });
      return cmp * sort.dir;
    });
  }, [a.rows, sort, lang]);
  return (
    <div className="artifact-scroll">
      <table>
        <thead>
          <tr>
            {a.columns.map((c) => (
              <th
                key={c.key}
                className={c.format === "number" || c.format === "currency" || c.format === "percent" ? "num" : ""}
                aria-sort={sort?.key === c.key ? (sort.dir === 1 ? "ascending" : "descending") : "none"}
              >
                <button onClick={() => setSort((s) => (s?.key === c.key ? (s.dir === 1 ? { key: c.key, dir: -1 } : null) : { key: c.key, dir: 1 }))}>
                  {c.label}
                  {sort?.key === c.key ? (sort.dir === 1 ? " ▲" : " ▼") : ""}
                </button>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              {a.columns.map((c) => {
                const v = r[c.key] ?? null;
                const numeric = c.format === "number" || c.format === "currency" || c.format === "percent";
                return (
                  <td key={c.key} className={numeric ? "num" : ""}>
                    {c.format === "link" && typeof v === "string" && /^https?:\/\//i.test(v) ? (
                      <button className="artifact-link" title={v} onClick={() => void api().call("assist.openUrl", v)}>
                        {hostOf(v)}
                      </button>
                    ) : (
                      formatValue(v, c.format === "link" ? "text" : c.format, lang, c.currency)
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ------------------------------------------------------------------ cards

function CardsArtifact({ a }: { a: Of<"cards"> }) {
  const [done, setDone] = useState<Set<number>>(() => new Set(a.layout === "checklist" ? a.items.flatMap((it, i) => (it.done ? [i] : [])) : []));
  switch (a.layout) {
    case "kpi":
      return (
        <div className="kpis">
          {a.items.map((it, i) => (
            <div key={i} className={`kpi ${it.tone}`}>
              <div className="kpi-label">{it.label}</div>
              <div className="kpi-value">{it.value}</div>
              {it.sub ? <div className="kpi-sub">{it.sub}</div> : null}
            </div>
          ))}
        </div>
      );
    case "compare":
      return (
        <div className="artifact-scroll">
          <table className="compare-cards">
            <thead>
              <tr>
                <th />
                {a.columns.map((c, i) => (
                  <th key={i}>
                    {c.title}
                    {c.subtitle ? <div className="kpi-sub">{c.subtitle}</div> : null}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {a.rows.map((r, i) => (
                <tr key={i}>
                  <th scope="row">{r.label}</th>
                  {r.values.map((v, j) => (
                    <td key={j}>{v}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case "checklist":
      return (
        <ul className="checklist">
          {a.items.map((it, i) => (
            <li key={i}>
              <label>
                <input
                  type="checkbox"
                  checked={done.has(i)}
                  onChange={() =>
                    setDone((prev) => {
                      const next = new Set(prev);
                      if (next.has(i)) next.delete(i);
                      else next.add(i);
                      return next;
                    })
                  }
                />
                <span className={done.has(i) ? "done" : ""}>{it.text}</span>
              </label>
            </li>
          ))}
        </ul>
      );
    case "steps":
      return (
        <ol className="steps">
          {a.items.map((it, i) => (
            <li key={i}>
              <strong>{it.title}</strong>
              {it.text ? <div className="muted">{it.text}</div> : null}
            </li>
          ))}
        </ol>
      );
  }
}

// ------------------------------------------------------------------ chart

const W = 320;
const H = 170;
const PAD = { left: 40, right: 8, top: 10, bottom: 28 };

function niceMax(v: number): number {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  return Math.ceil(v / p) * p;
}

function ChartArtifact({ a, lang }: { a: Of<"chart">; lang: string }) {
  const fmt = (v: number): string => formatValue(v, a.format, lang, a.currency);
  const legend =
    a.series.length > 1 || a.kind === "pie" ? (
      <div className="chart-legend">
        {(a.kind === "pie" ? a.labels : a.series.map((s) => s.label)).map((label, i) => (
          <span key={i}>
            <i className={`swatch c${i % 6}`} />
            {label}
          </span>
        ))}
      </div>
    ) : null;

  if (a.kind === "pie") {
    const values = a.series[0]!.values;
    const total = values.reduce((s, v) => s + v, 0) || 1;
    let angle = -Math.PI / 2;
    const r = 70;
    const cx = W / 2;
    const cy = H / 2;
    const slices = values.map((v, i) => {
      const start = angle;
      const sweep = (v / total) * Math.PI * 2;
      angle += sweep;
      if (sweep >= Math.PI * 2 - 1e-6) return <circle key={i} cx={cx} cy={cy} r={r} className={`fill c${i % 6}`} />;
      const large = sweep > Math.PI ? 1 : 0;
      const [x1, y1] = [cx + r * Math.cos(start), cy + r * Math.sin(start)];
      const [x2, y2] = [cx + r * Math.cos(start + sweep), cy + r * Math.sin(start + sweep)];
      return (
        <path key={i} className={`fill c${i % 6}`} d={`M${cx},${cy} L${x1},${y1} A${r},${r} 0 ${large} 1 ${x2},${y2} Z`}>
          <title>{`${a.labels[i]}: ${fmt(v)} (${Math.round((v / total) * 100)}%)`}</title>
        </path>
      );
    });
    return (
      <>
        <svg viewBox={`0 0 ${W} ${H}`} className="chart" role="img" aria-label={a.title}>
          {slices}
        </svg>
        {legend}
      </>
    );
  }

  const all = a.series.flatMap((s) => s.values);
  const min = Math.min(0, ...all);
  const max = niceMax(Math.max(...all, 0));
  const span = max - min || 1;
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;
  const y = (v: number): number => PAD.top + plotH - ((v - min) / span) * plotH;
  const band = plotW / a.labels.length;
  const ticks = [min, min + span / 2, max];
  const every = Math.ceil(a.labels.length / 8);
  return (
    <>
      <svg viewBox={`0 0 ${W} ${H}`} className="chart" role="img" aria-label={a.title}>
        {ticks.map((v, i) => (
          <g key={i}>
            <line x1={PAD.left} x2={W - PAD.right} y1={y(v)} y2={y(v)} className="grid" />
            <text x={PAD.left - 4} y={y(v) + 3} className="axis" textAnchor="end">
              {compact(v, lang)}
            </text>
          </g>
        ))}
        {a.labels.map((l, i) =>
          i % every === 0 ? (
            <text key={i} x={PAD.left + band * (i + 0.5)} y={H - 10} className="axis" textAnchor="middle">
              {l.length > 10 ? `${l.slice(0, 9)}…` : l}
            </text>
          ) : null,
        )}
        {a.kind === "bar"
          ? a.series.map((s, si) => {
              const bw = (band * 0.75) / a.series.length;
              return s.values.map((v, i) => {
                const x = PAD.left + band * i + band * 0.125 + bw * si;
                const top = y(Math.max(v, 0));
                return (
                  <rect key={`${si}-${i}`} x={x} y={top} width={Math.max(1, bw - 1)} height={Math.max(1, Math.abs(y(v) - y(0)))} rx={2} className={`fill c${si % 6}`}>
                    <title>{`${a.labels[i]} · ${s.label}: ${fmt(v)}`}</title>
                  </rect>
                );
              });
            })
          : a.series.map((s, si) => (
              <g key={si}>
                <polyline className={`stroke c${si % 6}`} fill="none" points={s.values.map((v, i) => `${PAD.left + band * (i + 0.5)},${y(v)}`).join(" ")} />
                {s.values.map((v, i) => (
                  <circle key={i} cx={PAD.left + band * (i + 0.5)} cy={y(v)} r={2.5} className={`fill c${si % 6}`}>
                    <title>{`${a.labels[i]} · ${s.label}: ${fmt(v)}`}</title>
                  </circle>
                ))}
              </g>
            ))}
      </svg>
      {legend}
    </>
  );
}

function compact(v: number, lang: string): string {
  try {
    return new Intl.NumberFormat(lang, { notation: "compact", maximumFractionDigits: 1 }).format(v);
  } catch {
    return String(v);
  }
}

// ------------------------------------------------------------------ links

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function LinksArtifact({ a, api }: { a: Of<"links">; api: Api }) {
  return (
    <ul className="artifact-links">
      {a.items.map((it, i) => (
        <li key={i}>
          <button className="artifact-link" title={it.url} onClick={() => void api().call("assist.openUrl", it.url)}>
            {it.title}
          </button>
          <span className="muted small"> · {hostOf(it.url)}</span>
          {it.note ? <div className="muted small">{it.note}</div> : null}
        </li>
      ))}
    </ul>
  );
}

// ------------------------------------------------------------------ form

function FormArtifact({ a, api, canSend }: { a: Of<"form">; api: Api; canSend: boolean }) {
  const [values, setValues] = useState<Record<string, string | boolean>>(() =>
    Object.fromEntries(a.fields.map((f) => [f.key, f.type === "checkbox" ? f.default === "true" : (f.default ?? "")])),
  );
  const [sent, setSent] = useState(false);
  const missing = a.fields.filter((f) => f.required && f.type !== "checkbox" && !String(values[f.key] ?? "").trim());
  const set = (key: string, v: string | boolean): void => setValues((prev) => ({ ...prev, [key]: v }));
  const submit = (): void => {
    if (sent || missing.length > 0 || !canSend) return;
    setSent(true);
    void api().call("assist.ask", formReply(a, values, { yes: tx("Yes"), no: tx("No") }));
  };
  return (
    <form
      className="artifact-form"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <fieldset disabled={sent}>
        {a.fields.map((f) => (
          <Field key={f.key} f={f} value={values[f.key] ?? ""} onChange={(v) => set(f.key, v)} />
        ))}
      </fieldset>
      <div className="write-actions">
        <button type="submit" className="btn small primary" disabled={sent || missing.length > 0 || !canSend}>
          {sent ? tx("Sent") : a.submitLabel || tx("Send")}
        </button>
        {!sent && missing.length > 0 ? <span className="muted small">{tx("Fill in the fields marked *")}</span> : null}
      </div>
    </form>
  );
}

function Field({ f, value, onChange }: { f: FormField; value: string | boolean; onChange: (v: string | boolean) => void }) {
  const label: ReactNode = (
    <>
      {f.label}
      {f.required ? <span className="req"> *</span> : null}
    </>
  );
  const text = typeof value === "string" ? value : "";
  switch (f.type) {
    case "checkbox":
      return (
        <label className="field check">
          <input type="checkbox" checked={value === true} onChange={(e) => onChange(e.target.checked)} />
          <span>{label}</span>
        </label>
      );
    case "radio":
      return (
        <div className="field" role="radiogroup" aria-label={f.label}>
          <span className="field-label">{label}</span>
          {(f.options ?? []).map((o) => (
            <label key={o} className="check">
              <input type="radio" name={f.key} checked={text === o} onChange={() => onChange(o)} />
              <span>{o}</span>
            </label>
          ))}
        </div>
      );
    case "select":
      return (
        <label className="field">
          <span className="field-label">{label}</span>
          <select value={text} onChange={(e) => onChange(e.target.value)}>
            <option value="">{tx("Choose…")}</option>
            {(f.options ?? []).map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </select>
        </label>
      );
    case "textarea":
      return (
        <label className="field">
          <span className="field-label">{label}</span>
          <textarea rows={3} value={text} placeholder={f.placeholder} maxLength={2000} onChange={(e) => onChange(e.target.value)} />
        </label>
      );
    default:
      return (
        <label className="field">
          <span className="field-label">{label}</span>
          <input type={f.type} value={text} placeholder={f.placeholder} maxLength={400} onChange={(e) => onChange(e.target.value)} />
        </label>
      );
  }
}
