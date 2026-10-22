import { createHash } from "node:crypto";
import type { FuzzResultRow, FuzzSummary, FuzzerConfig, HttpHeader, OutboundRequest, PayloadRule, PayloadSet } from "./types.js";

/** Apply the payload-processing rules (prefix/suffix, encode, case, hash) to one value, in order. */
export function processPayload(value: string, rules: PayloadRule[] = []): string {
  let v = value;
  for (const rule of rules) {
    switch (rule.kind) {
      case "prefix": v = (rule.text ?? "") + v; break;
      case "suffix": v = v + (rule.text ?? ""); break;
      case "url-encode": v = encodeURIComponent(v); break;
      case "base64": v = Buffer.from(v, "utf8").toString("base64"); break;
      case "upper": v = v.toUpperCase(); break;
      case "lower": v = v.toLowerCase(); break;
      case "hash-md5": v = createHash("md5").update(v).digest("hex"); break;
      case "hash-sha1": v = createHash("sha1").update(v).digest("hex"); break;
      case "hash-sha256": v = createHash("sha256").update(v).digest("hex"); break;
    }
  }
  return v;
}

/** Conservative safety ceilings. The fuzzer clamps to these regardless of what a caller asks for. */
export const SAFE_MAX_RPS = 50;
export const SAFE_MAX_CONCURRENCY = 20;
export const HARD_MAX_REQUESTS = 50_000;
export const DEFAULT_RPS = 5;

export function clampRate(rps: number): number {
  if (!Number.isFinite(rps) || rps <= 0) return DEFAULT_RPS;
  return Math.min(SAFE_MAX_RPS, Math.max(0.1, rps));
}

export function clampConcurrency(n: number): number {
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(SAFE_MAX_CONCURRENCY, Math.floor(n));
}

export function expandPayloadSet(set: PayloadSet): string[] {
  switch (set.kind) {
    case "wordlist":
      return (set.values ?? []).map(String);
    case "charset":
      return [...(set.charset ?? "")];
    case "numbers": {
      const from = set.from ?? 0;
      const to = set.to ?? 0;
      const step = set.step && set.step !== 0 ? Math.abs(set.step) : 1;
      const out: string[] = [];
      if (to >= from) for (let n = from; n <= to; n += step) out.push(String(n));
      else for (let n = from; n >= to; n -= step) out.push(String(n));
      return out;
    }
  }
}

interface SlottedField {
  literals: string[];
  /** Default text for each slot (the text between the § markers in the template). */
  defaults: string[];
}

const SLOT_RE = /§([^§]*)§/g;

function splitField(value: string): SlottedField {
  const literals: string[] = [];
  const defaults: string[] = [];
  let last = 0;
  for (const m of value.matchAll(SLOT_RE)) {
    literals.push(value.slice(last, m.index));
    defaults.push(m[1] ?? "");
    last = m.index + m[0].length;
  }
  literals.push(value.slice(last));
  return { literals, defaults };
}

function joinField(field: SlottedField, values: string[]): string {
  let out = field.literals[0] ?? "";
  for (let i = 0; i < field.defaults.length; i++) out += (values[i] ?? field.defaults[i] ?? "") + (field.literals[i + 1] ?? "");
  return out;
}

interface Template {
  url: SlottedField;
  headers: Array<{ name: string; value: SlottedField }>;
  body: SlottedField | null;
  positions: number;
}

/** Parse §payload§ positions out of a request template. */
export function parseTemplate(req: OutboundRequest): Template {
  const url = splitField(req.url);
  const headers = req.headers.map((h) => ({ name: h.name, value: splitField(h.value) }));
  const body = req.body !== undefined && !req.bodyBase64 ? splitField(req.body) : null;
  const positions = url.defaults.length + headers.reduce((n, h) => n + h.value.defaults.length, 0) + (body?.defaults.length ?? 0);
  return { url, headers, body, positions };
}

/** Build a concrete request by assigning one value to each position slot, in order. */
function buildRequest(base: OutboundRequest, t: Template, values: string[]): OutboundRequest {
  let k = 0;
  const take = (n: number): string[] => values.slice(k, (k += n));
  const url = joinField(t.url, take(t.url.defaults.length));
  const headers: HttpHeader[] = t.headers.map((h) => ({ name: h.name, value: joinField(h.value, take(h.value.defaults.length)) }));
  const body = t.body ? joinField(t.body, take(t.body.defaults.length)) : base.body;
  return { ...base, url, headers, ...(body !== undefined ? { body } : {}) };
}

export interface PlannedRequest {
  payloads: string[];
  request: OutboundRequest;
}

/** Enumerate every request an attack will issue (sniper varies one position at a time). */
export function planRequests(config: FuzzerConfig): PlannedRequest[] {
  const t = parseTemplate(config.template);
  const rules = config.payloadRules ?? [];
  const sets = config.payloadSets.map((s) => expandPayloadSet(s).map((v) => processPayload(v, rules)));
  const defaults = [t.url.defaults, ...t.headers.map((h) => h.value.defaults), t.body?.defaults ?? []].flat();

  if (t.positions === 0) return [{ payloads: [], request: config.template }];

  if (config.attack === "sniper") {
    const payloads = sets[0] ?? [];
    const planned: PlannedRequest[] = [];
    for (let pos = 0; pos < t.positions; pos++) {
      for (const value of payloads) {
        const values = defaults.slice();
        values[pos] = value;
        planned.push({ payloads: [value], request: buildRequest(config.template, t, values) });
      }
    }
    return planned;
  }

  if (config.attack === "pitchfork") {
    // One payload set per position, stepped in lockstep; the shortest set bounds the run.
    const perPosition = Array.from({ length: t.positions }, (_, i) => sets[i] ?? []);
    const count = Math.min(...perPosition.map((p) => p.length));
    const planned: PlannedRequest[] = [];
    for (let i = 0; i < count; i++) {
      const values = perPosition.map((p) => p[i] ?? "");
      planned.push({ payloads: values.slice(), request: buildRequest(config.template, t, values) });
    }
    return planned;
  }

  // cluster-bomb: cartesian product, one payload set per position.
  const perPosition = Array.from({ length: t.positions }, (_, i) => sets[i] ?? sets[sets.length - 1] ?? []);
  const planned: PlannedRequest[] = [];
  const walk = (pos: number, acc: string[]): void => {
    if (pos === t.positions) {
      planned.push({ payloads: acc.slice(), request: buildRequest(config.template, t, acc) });
      return;
    }
    for (const value of perPosition[pos] ?? []) walk(pos + 1, [...acc, value]);
  };
  walk(0, []);
  return planned;
}

/** Compile extract patterns once; invalid regexes are dropped. */
function compileExtract(patterns: string[] = []): RegExp[] {
  const out: RegExp[] = [];
  for (const p of patterns) {
    try {
      out.push(new RegExp(p));
    } catch {
      // skip invalid pattern
    }
  }
  return out;
}

/** Render a fuzz results table as CSV (positions, status, length, time, grep matches, extracts). */
export function fuzzResultsToCsv(rows: FuzzResultRow[]): string {
  const esc = (s: string): string => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const header = ["index", "payloads", "status", "length", "durationMs", "matched", "extracted", "error"];
  const lines = [header.join(",")];
  for (const r of rows) {
    lines.push(
      [
        String(r.index),
        esc(r.payloads.join(" | ")),
        r.status === null ? "" : String(r.status),
        String(r.length),
        r.durationMs === null ? "" : String(r.durationMs),
        esc(r.matched.join(" | ")),
        esc((r.extracted ?? []).join(" | ")),
        esc(r.error ?? ""),
      ].join(","),
    );
  }
  return lines.join("\n");
}

/** Paces work to a requests-per-second budget. Clock and sleep are injectable for tests. */
export class RateLimiter {
  private next = 0;
  private readonly intervalMs: number;

  constructor(
    rps: number,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
    private readonly now: () => number = () => Date.now(),
  ) {
    this.intervalMs = 1000 / clampRate(rps);
  }

  async acquire(): Promise<void> {
    const t = this.now();
    const wait = Math.max(0, this.next - t);
    this.next = Math.max(t, this.next) + this.intervalMs;
    if (wait > 0) await this.sleep(wait);
  }
}

export interface RunFuzzDeps {
  send: (req: OutboundRequest) => Promise<{ status: number | null; length: number; durationMs: number | null; body?: string }>;
  /** Reject out-of-scope targets. Required: the fuzzer refuses to send out of scope. */
  inScope: (url: string) => boolean;
  onRow?: (row: FuzzResultRow) => void;
  signal?: AbortSignal;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export class FuzzScopeError extends Error {}
export class FuzzLimitError extends Error {}

/** Run an attack: expand positions, enforce scope, throttle, and collect a results table. */
export async function runFuzz(config: FuzzerConfig, deps: RunFuzzDeps): Promise<{ rows: FuzzResultRow[]; summary: FuzzSummary }> {
  if (!deps.inScope(config.template.url)) {
    throw new FuzzScopeError("The fuzz target is not in scope; add it to the scope allowlist first");
  }
  const planned = planRequests(config);
  const ceiling = Math.min(config.maxRequests ?? HARD_MAX_REQUESTS, HARD_MAX_REQUESTS);
  if (planned.length > ceiling) {
    throw new FuzzLimitError(`This attack would issue ${planned.length} requests, above the ${ceiling} cap; narrow the payload sets`);
  }

  const rps = clampRate(config.requestsPerSecond);
  const concurrency = clampConcurrency(config.concurrency);
  const limiter = new RateLimiter(rps, deps.sleep, deps.now);
  const grep = (config.grep ?? []).filter((g) => g.length > 0);
  const extractors = compileExtract(config.extract);
  const rows: FuzzResultRow[] = new Array(planned.length);
  let cursor = 0;
  let completed = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      if (deps.signal?.aborted) return;
      const index = cursor++;
      const job = planned[index];
      if (!job) return;
      let row: FuzzResultRow;
      if (!deps.inScope(job.request.url)) {
        row = { index, payloads: job.payloads, status: null, length: 0, durationMs: null, error: "out of scope", matched: [] };
      } else {
        await limiter.acquire();
        if (deps.signal?.aborted) return;
        try {
          const res = await deps.send(job.request);
          const body = res.body ?? "";
          const matched = grep.filter((g) => body.includes(g));
          const extracted = extractors.length > 0 ? extractors.map((re) => re.exec(body)).map((m) => (m ? (m[1] ?? m[0]) : "")) : undefined;
          row = { index, payloads: job.payloads, status: res.status, length: res.length, durationMs: res.durationMs, matched, ...(extracted ? { extracted } : {}) };
        } catch (err) {
          row = { index, payloads: job.payloads, status: null, length: 0, durationMs: null, error: (err as Error).message, matched: [] };
        }
      }
      rows[index] = row;
      completed++;
      deps.onRow?.(row);
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, planned.length || 1) }, () => worker()));
  return {
    rows: rows.filter(Boolean),
    summary: { total: planned.length, completed, config: { attack: config.attack, requestsPerSecond: rps, concurrency } },
  };
}
