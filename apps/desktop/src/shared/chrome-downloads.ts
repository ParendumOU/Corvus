import type { DownloadRecord } from "./downloads";

/**
 * chrome.downloads over Corvus's download list: Chrome's item shape (numeric ids, ISO times),
 * search, and the events between two versions of the list. Pure, for the main process and the tests.
 */
export interface ChromeDownloadItem {
  id: number;
  url: string;
  finalUrl: string;
  filename: string;
  mime: string;
  state: "in_progress" | "interrupted" | "complete";
  paused: boolean;
  canResume: boolean;
  danger: "safe" | "file";
  error?: string;
  bytesReceived: number;
  totalBytes: number;
  fileSize: number;
  startTime: string;
  endTime?: string;
  exists: boolean;
  incognito: boolean;
  referrer: string;
  byExtensionId?: string;
}

/** Numeric download ids for Corvus's string ids (stable for the app's run). */
export class DownloadIdMap {
  private readonly toNumber = new Map<string, number>();
  private readonly toId = new Map<number, string>();

  number(id: string): number {
    let n = this.toNumber.get(id);
    if (n === undefined) {
      n = this.toNumber.size + 1;
      this.toNumber.set(id, n);
      this.toId.set(n, id);
    }
    return n;
  }

  id(n: number): string | undefined {
    return this.toId.get(n);
  }
}

export function toDownloadItem(r: DownloadRecord & { extensionId?: string }, id: number): ChromeDownloadItem {
  const complete = r.state === "completed";
  const failed = r.state === "cancelled" || r.state === "interrupted";
  return {
    id,
    url: r.url,
    finalUrl: r.url,
    filename: r.savePath,
    mime: r.mime,
    state: complete ? "complete" : failed ? "interrupted" : "in_progress",
    paused: r.state === "paused",
    canResume: r.canResume,
    danger: r.state === "blocked" ? "file" : "safe",
    ...(r.state === "cancelled" ? { error: "USER_CANCELED" } : r.state === "interrupted" ? { error: "NETWORK_FAILED" } : {}),
    bytesReceived: r.receivedBytes,
    totalBytes: r.totalBytes,
    fileSize: complete ? r.receivedBytes : r.totalBytes,
    startTime: new Date(r.startedAt).toISOString(),
    ...(r.endedAt ? { endTime: new Date(r.endedAt).toISOString() } : {}),
    exists: complete,
    incognito: false,
    referrer: "",
    ...(r.extensionId ? { byExtensionId: r.extensionId } : {}),
  };
}

export interface DownloadQuery {
  id?: number;
  url?: string;
  urlRegex?: string;
  filename?: string;
  filenameRegex?: string;
  query?: string[];
  state?: string;
  paused?: boolean;
  mime?: string;
  limit?: number;
  orderBy?: string[];
}

/** A DownloadQuery from an extension's argument (unknown fields dropped). */
export function toDownloadQuery(raw: unknown): DownloadQuery {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const q: DownloadQuery = {};
  for (const k of ["url", "urlRegex", "filename", "filenameRegex", "state", "mime"] as const) if (typeof o[k] === "string") q[k] = o[k] as string;
  for (const k of ["id", "limit"] as const) if (typeof o[k] === "number" && Number.isFinite(o[k])) q[k] = o[k] as number;
  if (typeof o.paused === "boolean") q.paused = o.paused;
  if (Array.isArray(o.query)) q.query = o.query.filter((t): t is string => typeof t === "string");
  if (Array.isArray(o.orderBy)) q.orderBy = o.orderBy.filter((t): t is string => typeof t === "string");
  return q;
}

/** chrome.downloads.search(): every field given must match; newest first unless orderBy says otherwise. */
export function searchDownloads(items: readonly ChromeDownloadItem[], q: DownloadQuery): ChromeDownloadItem[] {
  const regex = (source: string | undefined): RegExp | null => {
    if (!source) return null;
    try {
      return new RegExp(source);
    } catch {
      throw new Error(`Invalid regular expression: ${source}`);
    }
  };
  const urlRe = regex(q.urlRegex);
  const fileRe = regex(q.filenameRegex);
  const terms = (q.query ?? []).map((t) => t.toLowerCase());
  const matches = items.filter(
    (d) =>
      (q.id === undefined || d.id === q.id) &&
      (q.url === undefined || d.url === q.url) &&
      (!urlRe || urlRe.test(d.url)) &&
      (q.filename === undefined || d.filename === q.filename) &&
      (!fileRe || fileRe.test(d.filename)) &&
      (q.state === undefined || d.state === q.state) &&
      (q.paused === undefined || d.paused === q.paused) &&
      (q.mime === undefined || d.mime === q.mime) &&
      terms.every((t) => (t.startsWith("-") ? !`${d.url} ${d.filename}`.toLowerCase().includes(t.slice(1)) : `${d.url} ${d.filename}`.toLowerCase().includes(t))),
  );
  const order = q.orderBy?.[0] ?? "-startTime";
  const key = order.replace(/^-/, "") as keyof ChromeDownloadItem;
  const dir = order.startsWith("-") ? -1 : 1;
  const sorted = [...matches].sort((a, b) => {
    const x = a[key] ?? "";
    const y = b[key] ?? "";
    return x < y ? -dir : x > y ? dir : 0;
  });
  return q.limit !== undefined && q.limit > 0 ? sorted.slice(0, q.limit) : sorted;
}

const DELTA_FIELDS = ["state", "paused", "canResume", "error", "filename", "totalBytes", "endTime", "exists", "danger", "mime"] as const;

export type ChromeDownloadEvent =
  | { event: "onCreated"; args: [ChromeDownloadItem] }
  | { event: "onChanged"; args: [Record<string, unknown>] }
  | { event: "onErased"; args: [number] };

/** The chrome.downloads events between two versions of the list (progress itself is not an event). */
export function downloadEvents(before: readonly ChromeDownloadItem[], after: readonly ChromeDownloadItem[]): ChromeDownloadEvent[] {
  const was = new Map(before.map((d) => [d.id, d]));
  const now = new Set(after.map((d) => d.id));
  const out: ChromeDownloadEvent[] = [];
  for (const d of after) {
    const old = was.get(d.id);
    if (!old) {
      out.push({ event: "onCreated", args: [d] });
      continue;
    }
    const delta: Record<string, unknown> = { id: d.id };
    for (const f of DELTA_FIELDS) {
      if (old[f] !== d[f]) delta[f] = { previous: old[f], current: d[f] };
    }
    if (Object.keys(delta).length > 1) out.push({ event: "onChanged", args: [delta] });
  }
  for (const d of before) if (!now.has(d.id)) out.push({ event: "onErased", args: [d.id] });
  return out;
}
