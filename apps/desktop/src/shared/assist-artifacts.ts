/**
 * Artifacts in Corvus Assist answers: structured pieces the AI adds to its answer (a table, key
 * figures, a comparison, a checklist, a chart, links to open, a short form) as a fenced block
 * holding one JSON object:
 *
 *   ```artifact
 *   {"type": "table", "title": "…", "columns": […], "rows": […]}
 *   ```
 *
 * The panel validates each block here and draws it with its own components: no HTML or script
 * from the model ever runs. A block that does not validate shows as plain text.
 */
import type { AssistMessage } from "./assist-ipc";

export type Tone = "good" | "bad" | "neutral";
export type CellFormat = "text" | "number" | "currency" | "percent" | "date" | "link";

export interface TableColumn {
  key: string;
  label: string;
  format: CellFormat;
  currency?: string;
}
export type Cell = string | number | boolean | null;

export type Artifact =
  | { type: "table"; title: string; columns: TableColumn[]; rows: Array<Record<string, Cell>> }
  | { type: "cards"; layout: "kpi"; title: string; items: Array<{ label: string; value: string; sub?: string; tone: Tone }> }
  | { type: "cards"; layout: "compare"; title: string; columns: Array<{ title: string; subtitle?: string }>; rows: Array<{ label: string; values: string[] }> }
  | { type: "cards"; layout: "checklist"; title: string; items: Array<{ text: string; done: boolean }> }
  | { type: "cards"; layout: "steps"; title: string; items: Array<{ title: string; text?: string }> }
  | { type: "chart"; kind: "bar" | "line" | "pie"; title: string; labels: string[]; series: Array<{ label: string; values: number[] }>; format: "number" | "currency" | "percent"; currency?: string }
  | { type: "links"; title: string; items: Array<{ title: string; url: string; note?: string }> }
  | { type: "form"; title: string; submitLabel: string; fields: FormField[] };

export type FieldType = "text" | "textarea" | "number" | "select" | "radio" | "checkbox" | "date";
export interface FormField {
  key: string;
  label: string;
  type: FieldType;
  options?: string[];
  required: boolean;
  placeholder?: string;
  default?: string;
}

export type AnswerPart =
  | { kind: "text"; text: string }
  | { kind: "artifact"; artifact: Artifact; index: number }
  /** A block still being written (the answer is streaming). */
  | { kind: "pending" }
  /** A block that is not a valid artifact: shown as its text. */
  | { kind: "invalid"; raw: string; error: string };

export const ARTIFACT_LIMITS = {
  blockChars: 20_000,
  perAnswer: 4,
  title: 120,
  text: 400,
  tableRows: 100,
  tableColumns: 10,
  cards: 12,
  compareColumns: 5,
  compareRows: 30,
  listItems: 30,
  chartLabels: 40,
  chartSeries: 4,
  links: 12,
  formFields: 12,
  options: 20,
} as const;

/** ```artifact … ``` (the closing fence may be missing while the answer streams). */
const BLOCK = /```artifact[^\n]*\n([\s\S]*?)(```|$)/g;
const KEY = /^[A-Za-z_][A-Za-z0-9_]{0,39}$/;
const CURRENCY = /^[A-Z]{3}$/;

class Invalid extends Error {}
const fail = (message: string): never => {
  throw new Invalid(message);
};

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/** One line of text, without control or bidi-override characters, at most `max` long. */
function line(v: unknown, max: number): string {
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (typeof v !== "string") return "";
  // eslint-disable-next-line no-control-regex
  return v.replace(/[\u0000-\u001f\u007f‪-‮⁦-⁩]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}
const opt = (v: unknown, max: number): string | undefined => line(v, max) || undefined;
function req(v: unknown, max: number, what: string): string {
  return line(v, max) || fail(`${what} is missing`);
}
function list(v: unknown, max: number, what: string): unknown[] {
  if (!Array.isArray(v) || v.length === 0) return fail(`${what} must be a non-empty list`);
  return v.slice(0, max);
}
const tone = (v: unknown): Tone => (v === "good" || v === "bad" ? v : "neutral");
const currency = (v: unknown): string | undefined => (typeof v === "string" && CURRENCY.test(v) ? v : undefined);

/** http(s) addresses only. */
export function safeUrl(v: unknown): string | null {
  if (typeof v !== "string") return null;
  try {
    const url = new URL(v.trim());
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
}

function cell(v: unknown): Cell {
  if (v === null || typeof v === "boolean") return v ?? null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  return line(v, ARTIFACT_LIMITS.text);
}

function table(o: Obj, title: string): Artifact {
  const columns = list(o.columns, ARTIFACT_LIMITS.tableColumns, "columns").map((c, i) => {
    if (!isObj(c)) return fail(`columns[${i}] must be an object`);
    const key = typeof c.key === "string" && KEY.test(c.key) ? c.key : fail(`columns[${i}].key is not a valid key`);
    const format: CellFormat = ["number", "currency", "percent", "date", "link"].includes(c.format as string) ? (c.format as CellFormat) : "text";
    const cur = currency(c.currency);
    return { key, label: line(c.label, 60) || key, format, ...(cur ? { currency: cur } : {}) };
  });
  const rows = list(o.rows, ARTIFACT_LIMITS.tableRows, "rows").map((r, i) => {
    if (!isObj(r)) return fail(`rows[${i}] must be an object`);
    return Object.fromEntries(columns.map((c) => [c.key, cell(r[c.key])]));
  });
  return { type: "table", title, columns, rows };
}

function cards(o: Obj, title: string): Artifact {
  switch (o.layout) {
    case "kpi":
      return {
        type: "cards",
        layout: "kpi",
        title,
        items: list(o.items, ARTIFACT_LIMITS.cards, "items").map((it, i) => {
          if (!isObj(it)) return fail(`items[${i}] must be an object`);
          const sub = opt(it.sub, 120);
          return { label: req(it.label, 60, `items[${i}].label`), value: req(it.value, 40, `items[${i}].value`), ...(sub ? { sub } : {}), tone: tone(it.tone) };
        }),
      };
    case "compare": {
      const columns = list(o.columns, ARTIFACT_LIMITS.compareColumns, "columns").map((c, i) => {
        if (!isObj(c)) return { title: req(c, 60, `columns[${i}]`) };
        const subtitle = opt(c.subtitle, 80);
        return { title: req(c.title, 60, `columns[${i}].title`), ...(subtitle ? { subtitle } : {}) };
      });
      const rows = list(o.rows, ARTIFACT_LIMITS.compareRows, "rows").map((r, i) => {
        if (!isObj(r) || !Array.isArray(r.values)) return fail(`rows[${i}] needs a label and values`);
        const values = columns.map((_, j) => line((r.values as unknown[])[j], 200));
        return { label: req(r.label, 80, `rows[${i}].label`), values };
      });
      return { type: "cards", layout: "compare", title, columns, rows };
    }
    case "checklist":
      return {
        type: "cards",
        layout: "checklist",
        title,
        items: list(o.items, ARTIFACT_LIMITS.listItems, "items").map((it, i) =>
          isObj(it) ? { text: req(it.text, ARTIFACT_LIMITS.text, `items[${i}].text`), done: it.done === true } : { text: req(it, ARTIFACT_LIMITS.text, `items[${i}]`), done: false },
        ),
      };
    case "steps":
      return {
        type: "cards",
        layout: "steps",
        title,
        items: list(o.items, ARTIFACT_LIMITS.listItems, "items").map((it, i) => {
          if (!isObj(it)) return { title: req(it, 120, `items[${i}]`) };
          const text = opt(it.text, ARTIFACT_LIMITS.text);
          return { title: req(it.title, 120, `items[${i}].title`), ...(text ? { text } : {}) };
        }),
      };
    default:
      return fail("cards.layout must be kpi, compare, checklist or steps");
  }
}

function chart(o: Obj, title: string): Artifact {
  const kind = o.kind === "line" || o.kind === "pie" ? o.kind : o.kind === "bar" || o.kind === undefined ? "bar" : fail("chart.kind must be bar, line or pie");
  const labels = list(o.labels, ARTIFACT_LIMITS.chartLabels, "labels").map((l) => line(l, 40));
  const series = list(o.series, kind === "pie" ? 1 : ARTIFACT_LIMITS.chartSeries, "series").map((s, i) => {
    if (!isObj(s) || !Array.isArray(s.values)) return fail(`series[${i}] needs values`);
    const values = labels.map((_, j) => {
      const v = (s.values as unknown[])[j];
      return typeof v === "number" && Number.isFinite(v) ? v : fail(`series[${i}].values[${j}] must be a number`);
    });
    if (kind === "pie" && values.some((v) => v < 0)) fail("pie values cannot be negative");
    return { label: line(s.label, 60) || `#${i + 1}`, values };
  });
  const format = o.format === "currency" || o.format === "percent" ? o.format : "number";
  const cur = currency(o.currency);
  return { type: "chart", kind, title, labels, series, format, ...(cur ? { currency: cur } : {}) };
}

function links(o: Obj, title: string): Artifact {
  const items = list(o.items, ARTIFACT_LIMITS.links, "items").flatMap((it) => {
    if (!isObj(it)) return [];
    const url = safeUrl(it.url);
    if (!url) return [];
    const note = opt(it.note, 200);
    return [{ title: line(it.title, 120) || url, url, ...(note ? { note } : {}) }];
  });
  if (items.length === 0) fail("links need at least one http(s) address");
  return { type: "links", title, items };
}

const FIELD_TYPES: readonly FieldType[] = ["text", "textarea", "number", "select", "radio", "checkbox", "date"];

function form(o: Obj, title: string): Artifact {
  const seen = new Set<string>();
  const fields = list(o.fields, ARTIFACT_LIMITS.formFields, "fields").map((f, i): FormField => {
    if (!isObj(f)) return fail(`fields[${i}] must be an object`);
    const key = typeof f.key === "string" && KEY.test(f.key) && !seen.has(f.key) ? f.key : fail(`fields[${i}].key is missing or repeated`);
    seen.add(key);
    const type = FIELD_TYPES.includes(f.type as FieldType) ? (f.type as FieldType) : "text";
    const options = type === "select" || type === "radio" ? list(f.options, ARTIFACT_LIMITS.options, `fields[${i}].options`).map((x) => line(x, 80)).filter(Boolean) : undefined;
    const placeholder = opt(f.placeholder, 120);
    const def = opt(f.default, 200);
    return {
      key,
      label: req(f.label, 80, `fields[${i}].label`),
      type,
      ...(options ? { options } : {}),
      required: f.required === true,
      ...(placeholder ? { placeholder } : {}),
      ...(def ? { default: def } : {}),
    };
  });
  return { type: "form", title, submitLabel: line(o.submit_label ?? o.submitLabel, 40), fields };
}

/** Validates one artifact block's JSON (throws a short reason when it is not one). */
export function parseArtifact(json: string): Artifact {
  if (json.length > ARTIFACT_LIMITS.blockChars) fail("the block is too large");
  let o: unknown;
  try {
    o = JSON.parse(json);
  } catch {
    return fail("the block is not valid JSON");
  }
  if (!isObj(o)) return fail("the block must hold one JSON object");
  const title = line(o.title, ARTIFACT_LIMITS.title);
  switch (o.type) {
    case "table":
      return table(o, title);
    case "cards":
      return cards(o, title);
    case "chart":
      return chart(o, title);
    case "links":
      return links(o, title);
    case "form":
      return form(o, title);
    default:
      return fail("type must be table, cards, chart, links or form");
  }
}

/**
 * An answer split into text and artifacts, in order. While `streaming`, an unfinished block is a
 * placeholder; past ARTIFACT_LIMITS.perAnswer, blocks show as their text.
 */
export function splitAnswer(text: string, streaming = false): AnswerPart[] {
  const parts: AnswerPart[] = [];
  let last = 0;
  let count = 0;
  for (const m of text.matchAll(BLOCK)) {
    const before = text.slice(last, m.index);
    if (before.trim()) parts.push({ kind: "text", text: before });
    last = m.index + m[0].length;
    if (m[2] !== "```" && streaming) {
      parts.push({ kind: "pending" });
      continue;
    }
    const raw = (m[1] ?? "").trim();
    if (count >= ARTIFACT_LIMITS.perAnswer) {
      parts.push({ kind: "invalid", raw, error: "too many artifacts in one answer" });
      continue;
    }
    try {
      parts.push({ kind: "artifact", artifact: parseArtifact(raw), index: count++ });
    } catch (err) {
      parts.push({ kind: "invalid", raw, error: err instanceof Invalid ? err.message : "not an artifact" });
    }
  }
  const rest = text.slice(last);
  if (rest.trim()) parts.push({ kind: "text", text: rest });
  return parts;
}

// ------------------------------------------------------------------ as text

const CITES = /\s*\[\d+(?:\s*,\s*\d+)*\](?:\[\d+(?:\s*,\s*\d+)*\])*/g;
const mdCell = (v: string): string => v.replace(/\|/g, "\\|");
const mdTable = (head: string[], rows: string[][]): string =>
  [`| ${head.map(mdCell).join(" | ")} |`, `| ${head.map(() => "---").join(" | ")} |`, ...rows.map((r) => `| ${r.map(mdCell).join(" | ")} |`)].join("\n");

/** A value as the person reads it (numbers in `locale`). */
export function formatValue(v: Cell, format: CellFormat | "number", locale: string, cur?: string): string {
  if (v === null) return "";
  if (typeof v === "boolean") return v ? "✓" : "✗";
  if (typeof v !== "number") return v;
  try {
    if (format === "currency") return new Intl.NumberFormat(locale, { style: "currency", currency: cur ?? "EUR", maximumFractionDigits: 2 }).format(v);
    if (format === "percent") return new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 1 }).format(Math.abs(v) > 1 ? v / 100 : v);
    return new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(v);
  } catch {
    return String(v);
  }
}

/** An artifact as plain text (Markdown tables and lists), for copying. */
export function artifactAsText(a: Artifact, locale = "en"): string {
  const head = a.title ? `${a.title}\n\n` : "";
  switch (a.type) {
    case "table":
      return head + mdTable(a.columns.map((c) => c.label), a.rows.map((r) => a.columns.map((c) => formatValue(r[c.key] ?? null, c.format === "link" ? "text" : c.format, locale, c.currency))));
    case "cards":
      if (a.layout === "kpi") return head + a.items.map((i) => `- ${i.label}: ${i.value}${i.sub ? ` (${i.sub})` : ""}`).join("\n");
      if (a.layout === "compare") return head + mdTable(["", ...a.columns.map((c) => c.title)], a.rows.map((r) => [r.label, ...r.values]));
      if (a.layout === "checklist") return head + a.items.map((i) => `- [${i.done ? "x" : " "}] ${i.text}`).join("\n");
      return head + a.items.map((i, n) => `${n + 1}. ${i.title}${i.text ? ` — ${i.text}` : ""}`).join("\n");
    case "chart":
      return head + mdTable(["", ...a.series.map((s) => s.label)], a.labels.map((l, i) => [l, ...a.series.map((s) => formatValue(s.values[i] ?? null, a.format, locale, a.currency))]));
    case "links":
      return head + a.items.map((i) => `- ${i.title}: ${i.url}${i.note ? ` (${i.note})` : ""}`).join("\n");
    case "form":
      return head + a.fields.map((f) => `- ${f.label}`).join("\n");
  }
}

/** An answer as plain text: citations dropped, artifacts written out. */
export function answerAsText(text: string, locale = "en"): string {
  return splitAnswer(text)
    .map((p) => (p.kind === "text" ? p.text.replace(CITES, "").trim() : p.kind === "artifact" ? artifactAsText(p.artifact, locale) : p.kind === "invalid" ? p.raw : ""))
    .filter(Boolean)
    .join("\n\n");
}

/** What a filled-in form sends back to the AI as the person's next message. */
export function formReply(a: Extract<Artifact, { type: "form" }>, values: Record<string, string | boolean>, words = { yes: "yes", no: "no" }): string {
  const lines = a.fields.map((f) => {
    const v = values[f.key];
    const shown = typeof v === "boolean" ? (v ? words.yes : words.no) : (v ?? "").trim() || "—";
    return `- ${f.label}: ${shown}`;
  });
  return `${a.title ? `«${a.title}»` : "Form"}:\n${lines.join("\n")}`;
}

/** What "Copy" puts on the clipboard for an answer in the panel. */
export function copyableText(message: Pick<AssistMessage, "kind" | "text" | "summary">, locale: string): string {
  if (message.kind === "summarize" && message.summary) {
    const points = message.summary.points.map((p) => `- ${p.text}`);
    return [message.summary.tldr, points.join("\n")].filter(Boolean).join("\n\n");
  }
  if (message.kind === "write" || message.kind === "translate-selection") return message.text;
  return answerAsText(message.text, locale);
}
