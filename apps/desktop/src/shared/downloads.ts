/** Download list model, file naming and executable detection. Pure and unit tested. */

export type DownloadState = "progressing" | "paused" | "completed" | "cancelled" | "interrupted" | "blocked";

export interface DownloadRecord {
  id: string;
  url: string;
  filename: string;
  /** Empty until the save location is known (e.g. while the save dialog is open). */
  savePath: string;
  mime: string;
  totalBytes: number;
  receivedBytes: number;
  state: DownloadState;
  startedAt: number;
  endedAt?: number;
  /** Started from a tab driven by an AI agent. */
  agent: boolean;
  /** Started by an extension (chrome.downloads.download). */
  extensionId?: string;
  /** From a private window: listed while it is open, never saved. */
  ephemeral?: boolean;
  canResume: boolean;
}

export const DOWNLOAD_ACTIONS = ["pause", "resume", "cancel", "open", "show", "remove", "keep", "discard", "retry"] as const;
export type DownloadAction = (typeof DOWNLOAD_ACTIONS)[number];

export function isDownloadAction(value: unknown): value is DownloadAction {
  return typeof value === "string" && (DOWNLOAD_ACTIONS as readonly string[]).includes(value);
}

const EXECUTABLE_EXTENSIONS = new Set([
  "exe", "msi", "msix", "msixbundle", "appx", "appxbundle", "bat", "cmd", "com", "scr", "pif", "cpl", "hta",
  "ps1", "psm1", "vbs", "vbe", "js", "jse", "wsf", "wsh", "lnk", "reg", "jar", "dll", "sys", "inf",
  "application", "gadget", "msp", "mst", "sh", "bash", "zsh", "run", "bin", "command", "app", "dmg",
  "pkg", "mpkg", "deb", "rpm", "appimage", "snap", "flatpakref", "apk", "xapk", "py", "pyw", "pl", "rb",
]);

/** Files that run code when opened. Agent tabs need explicit user confirmation to download them. */
export function isExecutableFilename(name: string): boolean {
  const base = name.trim().toLowerCase().replace(/[.\s]+$/, "");
  const dot = base.lastIndexOf(".");
  if (dot <= 0 && !base.startsWith(".")) return false;
  return EXECUTABLE_EXTENSIONS.has(base.slice(dot + 1));
}

/** "report.pdf" -> "report (1).pdf" -> "report (2).pdf"... until `taken` says it is free. */
export function uniqueFilename(name: string, taken: (candidate: string) => boolean): string {
  const clean = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").trim() || "download";
  if (!taken(clean)) return clean;
  const dot = clean.lastIndexOf(".");
  const hasExt = dot > 0 && dot < clean.length - 1;
  const stem = hasExt ? clean.slice(0, dot) : clean;
  const ext = hasExt ? clean.slice(dot) : "";
  for (let i = 1; i < 10_000; i++) {
    const candidate = `${stem} (${i})${ext}`;
    if (!taken(candidate)) return candidate;
  }
  return `${stem} (${Date.now()})${ext}`;
}

export function isActiveDownload(record: DownloadRecord): boolean {
  return record.state === "progressing" || record.state === "paused";
}

/** Insert or replace by id, newest first, capped. */
export function upsertDownload(list: DownloadRecord[], record: DownloadRecord, cap = 200): DownloadRecord[] {
  const index = list.findIndex((d) => d.id === record.id);
  if (index >= 0) {
    const next = [...list];
    next[index] = record;
    return next;
  }
  const next = [record, ...list];
  if (next.length <= cap) return next;
  // Drop the oldest finished entries first; live downloads always stay listed.
  const out: DownloadRecord[] = [];
  let excess = next.length - cap;
  for (let i = next.length - 1; i >= 0; i--) {
    const d = next[i] as DownloadRecord;
    if (excess > 0 && !isActiveDownload(d) && d.state !== "blocked") {
      excess--;
      continue;
    }
    out.unshift(d);
  }
  return out;
}

export function removeDownload(list: DownloadRecord[], id: string): DownloadRecord[] {
  return list.filter((d) => d.id !== id);
}

/** "Clear all": keep only downloads that are still running or waiting for a decision. */
export function clearFinished(list: DownloadRecord[]): DownloadRecord[] {
  return list.filter((d) => isActiveDownload(d) || d.state === "blocked");
}

const STATES: readonly DownloadState[] = ["progressing", "paused", "completed", "cancelled", "interrupted", "blocked"];

/** Load the stored list. Downloads cut short by a quit or crash become "interrupted". */
export function reviveDownloads(raw: unknown): DownloadRecord[] {
  if (!Array.isArray(raw)) return [];
  const out: DownloadRecord[] = [];
  for (const d of raw) {
    if (typeof d !== "object" || d === null) continue;
    const r = d as Record<string, unknown>;
    if (typeof r.id !== "string" || typeof r.url !== "string" || typeof r.filename !== "string") continue;
    const state = STATES.includes(r.state as DownloadState) ? (r.state as DownloadState) : "interrupted";
    if (state === "blocked") continue;
    const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
    out.push({
      id: r.id,
      url: r.url,
      filename: r.filename,
      savePath: typeof r.savePath === "string" ? r.savePath : "",
      mime: typeof r.mime === "string" ? r.mime : "",
      totalBytes: num(r.totalBytes),
      receivedBytes: num(r.receivedBytes),
      state: state === "progressing" || state === "paused" ? "interrupted" : state,
      startedAt: num(r.startedAt),
      ...(typeof r.endedAt === "number" ? { endedAt: r.endedAt } : {}),
      agent: r.agent === true,
      canResume: false,
    });
  }
  return out;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

export function downloadProgress(record: DownloadRecord): number | null {
  if (record.totalBytes <= 0) return null;
  return Math.max(0, Math.min(1, record.receivedBytes / record.totalBytes));
}

export function downloadStatus(record: DownloadRecord): string {
  const size = formatBytes(record.totalBytes);
  const received = formatBytes(record.receivedBytes);
  switch (record.state) {
    case "progressing":
      return record.totalBytes > 0 ? `${received} of ${size}` : `${received} downloaded`;
    case "paused":
      return record.totalBytes > 0 ? `Paused · ${received} of ${size}` : `Paused · ${received}`;
    case "completed":
      return size || "Done";
    case "cancelled":
      return "Cancelled";
    case "interrupted":
      return "Failed";
    case "blocked":
      return record.extensionId ? "Blocked: an extension tried to download a program" : "Blocked: an AI agent tried to download a program";
  }
}

/** Actions offered for a download, in display order. */
export function downloadActions(record: DownloadRecord): DownloadAction[] {
  switch (record.state) {
    case "progressing":
      return ["pause", "cancel"];
    case "paused":
      return ["resume", "cancel"];
    case "completed":
      return ["open", "show", "remove"];
    case "cancelled":
    case "interrupted":
      return ["retry", "remove"];
    case "blocked":
      return ["keep", "discard"];
  }
}

/**
 * A file name an extension suggests (chrome.downloads.download): a relative path inside the
 * downloads folder ("reports/a.pdf"), or null when it is absolute, climbs out or is empty.
 */
export function safeDownloadPath(name: string): string | null {
  const parts = name.replace(/\\/g, "/").split("/").filter((p) => p !== "" && p !== ".");
  if (/^([a-z]:|\/)/i.test(name) || parts.length === 0 || parts.some((p) => p === ".." || /[<>:"|?*\u0000-\u001f]/.test(p))) return null;
  return parts.join("/");
}
