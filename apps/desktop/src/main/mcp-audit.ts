import fs from "node:fs";
import path from "node:path";
import type { McpActivityEntry, McpActivityOutcome, McpActivityQuery, McpToolSummary } from "../shared/ipc";

const FILE = "mcp-activity.jsonl";
/** Kept: the newest entries up to this many, from the last MAX_AGE_MS. */
const MAX_ENTRIES = 10_000;
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
/** Appends between rewrites of the file without the dropped entries. */
const COMPACT_EVERY = 500;
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;
const MAX_TEXT = 200;
const OUTCOMES: readonly McpActivityOutcome[] = ["ok", "error", "rate-limited"];

const clip = (value: unknown, max: number): string => (typeof value === "string" ? value.slice(0, max) : "");

function parseEntry(line: string): McpActivityEntry | null {
  if (!line.trim()) return null;
  try {
    const v = JSON.parse(line) as Record<string, unknown>;
    if (typeof v.at !== "number" || typeof v.tool !== "string" || !OUTCOMES.includes(v.outcome as McpActivityOutcome)) return null;
    return clean(v as unknown as McpActivityEntry);
  } catch {
    return null;
  }
}

function clean(e: McpActivityEntry): McpActivityEntry {
  const error = clip(e.error, MAX_TEXT);
  return {
    at: Math.round(e.at),
    client: clip(e.client, 100) || "unknown",
    tool: clip(e.tool, 100),
    host: clip(e.host, 255),
    outcome: e.outcome,
    durationMs: Math.max(0, Math.round(Number(e.durationMs) || 0)),
    ...(error ? { error } : {}),
  };
}

/** A CSV cell; a leading = + - @ is neutralised so spreadsheets never run it as a formula. */
function csvCell(value: string | number): string {
  let text = String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * The local log of MCP tool calls (Settings > AI agents): who called which tool, on which site,
 * how it ended and how long it took. Arguments, typed text and page content are never stored; an
 * error keeps only the tool's own message (the MCP server drops it when it quotes the page). Kept as
 * JSON lines in the user data folder, trimmed to the last 30 days and 10,000 calls. Nothing leaves
 * the device. Every method swallows file errors: logging never breaks a tool call.
 */
export class McpAuditLog {
  private entries: McpActivityEntry[] | null = null;
  private appended = 0;
  private readonly file: string;

  constructor(
    private readonly dir: string,
    private readonly enabled: () => boolean,
    private readonly now: () => number = Date.now,
  ) {
    this.file = path.join(dir, FILE);
  }

  record(entry: McpActivityEntry): void {
    if (!this.enabled()) return;
    const item = clean(entry);
    const list = this.load();
    list.push(item);
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      fs.appendFileSync(this.file, `${JSON.stringify(item)}\n`);
    } catch {
      // A full disk or a locked file only loses this line.
    }
    this.appended += 1;
    if (this.appended >= COMPACT_EVERY || list.length > MAX_ENTRIES) this.compact();
  }

  /** Newest first, filtered by client and/or to calls that did not succeed. */
  list(query: McpActivityQuery = {}): McpActivityEntry[] {
    return this.page(query).entries;
  }

  /** One page of list(): `query.limit` calls after the first `query.offset`, and how many match in all. */
  page(query: McpActivityQuery = {}): { entries: McpActivityEntry[]; total: number } {
    const limit = Math.max(1, Math.min(MAX_LIMIT, Math.round(query.limit ?? DEFAULT_LIMIT)));
    const offset = Math.max(0, Math.round(query.offset ?? 0));
    const entries: McpActivityEntry[] = [];
    let total = 0;
    const list = this.load();
    for (let i = list.length - 1; i >= 0; i--) {
      const e = list[i]!;
      if (query.client && e.client !== query.client) continue;
      if (query.problemsOnly && e.outcome === "ok") continue;
      if (total >= offset && entries.length < limit) entries.push(e);
      total += 1;
    }
    return { entries, total };
  }

  /** Clients seen in the log, most recent first. */
  clients(): string[] {
    const seen = new Set<string>();
    const list = this.load();
    for (let i = list.length - 1; i >= 0; i--) seen.add(list[i]!.client);
    return [...seen];
  }

  /**
   * Per tool since `since` (ms epoch): calls, errors, calls over the rate limit, mean time. Busiest
   * first. Client events ("(connected)", "(revoked)"…) are in the list, not here.
   */
  summary(since: number): McpToolSummary[] {
    const byTool = new Map<string, McpToolSummary & { totalMs: number; timed: number }>();
    for (const e of this.load()) {
      if (e.at < since || e.tool.startsWith("(")) continue;
      const row = byTool.get(e.tool) ?? { tool: e.tool, calls: 0, errors: 0, rateLimited: 0, avgMs: 0, totalMs: 0, timed: 0 };
      row.calls += 1;
      if (e.outcome === "error") row.errors += 1;
      if (e.outcome === "rate-limited") row.rateLimited += 1;
      else {
        row.totalMs += e.durationMs;
        row.timed += 1;
      }
      byTool.set(e.tool, row);
    }
    return [...byTool.values()]
      .map(({ totalMs, timed, ...row }) => ({ ...row, avgMs: timed ? Math.round(totalMs / timed) : 0 }))
      .sort((a, b) => b.calls - a.calls || a.tool.localeCompare(b.tool));
  }

  clear(): void {
    this.entries = [];
    this.appended = 0;
    try {
      fs.rmSync(this.file, { force: true });
    } catch {
      // ignore
    }
  }

  /** The whole log as CSV, oldest first. */
  csv(): string {
    const rows = [["time", "client", "tool", "site", "outcome", "duration_ms", "error"].join(",")];
    for (const e of this.load()) {
      rows.push([new Date(e.at).toISOString(), e.client, e.tool, e.host, e.outcome, e.durationMs, e.error ?? ""].map(csvCell).join(","));
    }
    return `${rows.join("\n")}\n`;
  }

  private load(): McpActivityEntry[] {
    if (this.entries) return this.entries;
    let raw = "";
    try {
      raw = fs.readFileSync(this.file, "utf8");
    } catch {
      // No log yet.
    }
    const parsed = raw.split("\n").map(parseEntry).filter((e): e is McpActivityEntry => e !== null);
    this.entries = parsed;
    const kept = this.pruned(parsed);
    if (kept.length !== parsed.length || (raw && kept.length === 0)) {
      this.entries = kept;
      this.rewrite();
    }
    return this.entries;
  }

  private pruned(list: McpActivityEntry[]): McpActivityEntry[] {
    const cutoff = this.now() - MAX_AGE_MS;
    const recent = list.filter((e) => e.at >= cutoff);
    return recent.length > MAX_ENTRIES ? recent.slice(recent.length - MAX_ENTRIES) : recent;
  }

  private compact(): void {
    this.appended = 0;
    this.entries = this.pruned(this.load());
    this.rewrite();
  }

  private rewrite(): void {
    const list = this.entries ?? [];
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, list.map((e) => JSON.stringify(e)).join("\n") + (list.length ? "\n" : ""));
      fs.renameSync(tmp, this.file);
    } catch {
      // Keep the longer file; the next compaction tries again.
    }
  }
}
