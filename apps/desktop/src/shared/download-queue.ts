/**
 * The download queue's model: packages of links downloaded by Corvus itself (not the browser's
 * one-file downloads), a few at a time and at most a couple per host, resumable after a pause or a
 * restart, with progress, speed and time left. Pure, so the scheduling rules are unit tested.
 */
import type { GrabbedPackage, LinkKind } from "./link-grabber";

export type QueueItemState = "queued" | "running" | "paused" | "done" | "failed";

/** A byte range of a file fetched on its own connection (end inclusive). */
export interface Segment {
  start: number;
  end: number;
  received: number;
}

export interface QueueItem {
  id: string;
  url: string;
  /** Name from the address; replaced by the server's when it sends one. */
  filename: string;
  host: string;
  kind: LinkKind;
  part?: number;
  state: QueueItemState;
  receivedBytes: number;
  /** Null while unknown. */
  totalBytes: number | null;
  /** Where the file is (or will be) saved. Set when the download first starts. */
  savePath?: string;
  error?: string;
  /** How many times it failed in a row (retries back off). */
  attempts: number;
  finishedAt?: number;
  /** Byte ranges downloaded in parallel, when the server allows it (kept to resume each one). */
  segments?: Segment[];
  /** Result of the package's checksum file (.sfv, .md5, .sha1, .sha256) for this file. */
  checked?: "ok" | "mismatch";
}

/** One archive of a finished package, after extracting it. */
export interface ArchiveResult {
  /** Its first volume (the file 7-Zip opens). */
  entry: string;
  state: "done" | "password" | "failed";
  files?: number;
  error?: string;
  /** Its volumes were deleted once it was extracted. */
  deleted?: boolean;
}

/** Extracting a finished package's archives (split files are joined the same way). */
export interface PackageExtraction {
  state: "running" | "done" | "password" | "failed";
  archives: ArchiveResult[];
  /** The password that opened them; absent when none was needed. */
  password?: string;
  /** Why it stopped before reaching every archive. */
  error?: string;
}

export interface QueuePackage {
  id: string;
  name: string;
  source: string;
  passwords: string[];
  /** Folder the package downloads into (the downloads folder plus the package name). */
  dir: string;
  addedAt: number;
  items: QueueItem[];
  extraction?: PackageExtraction;
  /** The AI agent that queued it ("Corvus" for the Command Bar agent, or an MCP client's name). */
  addedBy?: string;
}

export interface QueueLimits {
  /** Downloads running at once. */
  parallel: number;
  /** Downloads running at once from one host. */
  perHost: number;
}

export const DEFAULT_LIMITS: QueueLimits = { parallel: 3, perHost: 2 };
export const MAX_ATTEMPTS = 3;

/** Folder-safe package name (no separators, reserved characters or trailing dots). */
export function safeName(name: string): string {
  const cleaned = name
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/, "")
    .slice(0, 120);
  return /^(con|prn|aux|nul|com\d|lpt\d)$/i.test(cleaned) || !cleaned ? "Download" : cleaned;
}

/** A grabbed package as queued: file links only (hoster pages need their page, handled apart). */
export function queueFromGrabbed(pkg: GrabbedPackage, downloadsDir: string, join: (...parts: string[]) => string): QueuePackage {
  return {
    id: pkg.id,
    name: pkg.name,
    source: pkg.source,
    passwords: [...pkg.passwords],
    dir: join(downloadsDir, safeName(pkg.name)),
    addedAt: pkg.addedAt,
    items: pkg.links
      .filter((l) => l.kind !== "hoster")
      .map((l) => ({
        id: l.id,
        url: l.url,
        filename: l.filename || "download",
        host: l.host,
        kind: l.kind,
        ...(l.part !== undefined ? { part: l.part } : {}),
        state: "queued" as const,
        receivedBytes: 0,
        totalBytes: null,
        attempts: 0,
      })),
  };
}

/**
 * The items to start now, in queue order (packages in order, then their items), keeping within
 * the overall and per-host limits counting what already runs.
 */
export function nextToStart(packages: readonly QueuePackage[], limits: QueueLimits): QueueItem[] {
  const running = packages.flatMap((p) => p.items).filter((i) => i.state === "running");
  const perHost = new Map<string, number>();
  for (const i of running) perHost.set(i.host, (perHost.get(i.host) ?? 0) + 1);
  let free = limits.parallel - running.length;
  const out: QueueItem[] = [];
  for (const pkg of packages) {
    for (const item of pkg.items) {
      if (free <= 0) return out;
      if (item.state !== "queued") continue;
      const onHost = perHost.get(item.host) ?? 0;
      if (onHost >= limits.perHost) continue;
      perHost.set(item.host, onHost + 1);
      out.push(item);
      free--;
    }
  }
  return out;
}

/**
 * On restart nothing runs: running items go back to the queue and resume from their part file, and
 * an extraction Corvus quit in the middle of is marked failed, to be started again by hand.
 */
export function reviveQueue(packages: readonly QueuePackage[]): QueuePackage[] {
  return packages.map((p) => ({
    ...p,
    items: p.items.map((i) => (i.state === "running" ? { ...i, state: "queued" as const } : i)),
    ...(p.extraction?.state === "running" ? { extraction: { ...p.extraction, state: "failed" as const, error: "Corvus closed while extracting" } } : {}),
  }));
}

/** Every file of the package is in (and none failed its checksum). */
export function packageComplete(pkg: QueuePackage): boolean {
  return pkg.items.length > 0 && pkg.items.every((i) => i.state === "done");
}

/** Whether a package that just completed extracts on its own: not while or after it already did. */
export function shouldAutoExtract(pkg: QueuePackage, enabled: boolean): boolean {
  return enabled && packageComplete(pkg) && pkg.extraction?.state !== "running" && pkg.extraction?.state !== "done";
}

/** Overall state of an extraction from its archives' results. */
export function extractionState(archives: readonly ArchiveResult[], error?: string): PackageExtraction["state"] {
  if (error || archives.some((a) => a.state === "failed")) return "failed";
  if (archives.some((a) => a.state === "password")) return "password";
  return "done";
}

/** Moves a package one place up (-1) or down (+1) in the queue. */
export function movePackage(packages: readonly QueuePackage[], id: string, delta: -1 | 1): QueuePackage[] {
  const from = packages.findIndex((p) => p.id === id);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= packages.length) return [...packages];
  const out = [...packages];
  const [moved] = out.splice(from, 1);
  out.splice(to, 0, moved!);
  return out;
}

export type QueueAction = "pause" | "resume" | "retry" | "remove";

/** Applies an action to a package (every item) or one item; returns the new list and the items to stop. */
export function applyQueueAction(
  packages: readonly QueuePackage[],
  id: string,
  action: QueueAction,
): { packages: QueuePackage[]; stop: string[] } {
  const stop: string[] = [];
  const out: QueuePackage[] = [];
  for (const pkg of packages) {
    const whole = pkg.id === id;
    const items: QueueItem[] = [];
    for (const item of pkg.items) {
      if (!whole && item.id !== id) {
        items.push(item);
        continue;
      }
      if (action === "remove") {
        if (item.state === "running") stop.push(item.id);
        continue;
      }
      if (action === "pause" && (item.state === "queued" || item.state === "running")) {
        if (item.state === "running") stop.push(item.id);
        items.push({ ...item, state: "paused" });
      } else if (action === "resume" && item.state === "paused") {
        items.push({ ...item, state: "queued" });
      } else if (action === "retry" && item.state === "failed") {
        const { error: _error, checked, segments, ...rest } = item;
        // A file that failed its checksum starts over; a network failure resumes.
        items.push(checked === "mismatch" ? { ...rest, state: "queued", attempts: 0, receivedBytes: 0 } : { ...rest, ...(segments ? { segments } : {}), state: "queued", attempts: 0 });
      } else {
        items.push(item);
      }
    }
    if (items.length > 0) out.push({ ...pkg, items });
  }
  return { packages: out, stop };
}

export interface PackageProgress {
  received: number;
  /** Null while any item's size is unknown. */
  total: number | null;
  done: number;
  failed: number;
  running: number;
  count: number;
}

export interface QueuePackageView extends QueuePackage {
  progress: PackageProgress;
  /** Bytes per second across its running items. */
  speed: number;
  /** Seconds left, null when unknown. */
  eta: number | null;
  /** Archives (or split files) among its files, to extract or join. */
  archives: number;
}

export interface QueueView {
  packages: QueuePackageView[];
  /** Bytes per second of each running item, by item id. */
  speeds: Record<string, number>;
}

export function packageProgress(pkg: QueuePackage): PackageProgress {
  let received = 0;
  let total: number | null = 0;
  let done = 0;
  let failed = 0;
  let running = 0;
  for (const i of pkg.items) {
    received += i.receivedBytes;
    total = total === null || i.totalBytes === null ? null : total + i.totalBytes;
    if (i.state === "done") done++;
    if (i.state === "failed") failed++;
    if (i.state === "running") running++;
  }
  return { received, total, done, failed, running, count: pkg.items.length };
}

/** Download speed over a sliding window of byte counts. */
export class SpeedMeter {
  private samples: Array<{ at: number; bytes: number }> = [];

  constructor(private readonly windowMs = 5000) {}

  add(bytes: number, at: number): void {
    this.samples.push({ at, bytes });
    while (this.samples.length > 1 && at - this.samples[0]!.at > this.windowMs) this.samples.shift();
  }

  /** Bytes per second, 0 without enough samples. */
  rate(now: number): number {
    const recent = this.samples.filter((s) => now - s.at <= this.windowMs);
    if (recent.length === 0) return 0;
    const span = Math.max(1000, now - recent[0]!.at);
    return (recent.reduce((n, s) => n + s.bytes, 0) * 1000) / span;
  }
}

/** Seconds left at the given speed, null when it cannot be told. */
export function etaSeconds(received: number, total: number | null, bytesPerSecond: number): number | null {
  if (total === null || bytesPerSecond <= 0 || received >= total) return null;
  return Math.ceil((total - received) / bytesPerSecond);
}

/** The file name a server suggests (Content-Disposition), made safe; null when it gives none. */
export function filenameFromDisposition(header: string | null): string | null {
  if (!header) return null;
  const star = /filename\*\s*=\s*(?:UTF-8|utf-8)?''([^;]+)/i.exec(header);
  let name: string | null = null;
  if (star) {
    try {
      name = decodeURIComponent(star[1]!.trim().replace(/^"|"$/g, ""));
    } catch {
      name = null;
    }
  }
  if (!name) name = /filename\s*=\s*"([^"]*)"|filename\s*=\s*([^;]+)/i.exec(header)?.slice(1).find(Boolean)?.trim() ?? null;
  if (!name) return null;
  const base = name.split(/[\\/]/).pop()!.replace(/[:*?"<>|\u0000-\u001f]/g, "_").trim();
  return base && base !== "." && base !== ".." ? base.slice(0, 255) : null;
}

/** Files smaller than this download on one connection. */
export const SEGMENT_MIN_BYTES = 8 * 1024 * 1024;

/** Splits a file into `count` byte ranges (fewer for small files), each at least `min` long. */
export function planSegments(total: number, count: number, min = SEGMENT_MIN_BYTES): Segment[] {
  const n = Math.max(1, Math.min(count, Math.floor(total / min)));
  const size = Math.ceil(total / n);
  const out: Segment[] = [];
  for (let start = 0; start < total; start += size) out.push({ start, end: Math.min(total, start + size) - 1, received: 0 });
  return out;
}

/** Bytes received across a file's segments. */
export function segmentsReceived(segments: readonly Segment[]): number {
  return segments.reduce((n, s) => n + s.received, 0);
}

export type ChecksumAlgorithm = "crc32" | "md5" | "sha1" | "sha256";

const CHECKSUM_FILE = /\.(sfv|md5|sha1|sha256)$/i;

export function isChecksumFile(filename: string): boolean {
  return CHECKSUM_FILE.test(filename);
}

/**
 * The expected hashes listed in a checksum file, by file name (lower case):
 * ".sfv" lines are "name CRC32"; ".md5"/".sha1"/".sha256" lines are "hash  name" or "hash *name".
 */
export function parseChecksums(filename: string, text: string): Map<string, { algorithm: ChecksumAlgorithm; hash: string }> {
  const ext = CHECKSUM_FILE.exec(filename)?.[1]?.toLowerCase();
  const out = new Map<string, { algorithm: ChecksumAlgorithm; hash: string }>();
  if (!ext) return out;
  const lengths: Record<string, number> = { md5: 32, sha1: 40, sha256: 64 };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith(";") || line.startsWith("#")) continue;
    if (ext === "sfv") {
      const m = /^(.+?)\s+([0-9a-f]{8})$/i.exec(line);
      if (m) out.set(m[1]!.trim().toLowerCase(), { algorithm: "crc32", hash: m[2]!.toLowerCase() });
    } else {
      const m = /^([0-9a-f]+)\s+\*?(.+)$/i.exec(line);
      if (m && m[1]!.length === lengths[ext]) out.set(m[2]!.trim().toLowerCase(), { algorithm: ext as ChecksumAlgorithm, hash: m[1]!.toLowerCase() });
    }
  }
  return out;
}

/** "1.5 MB", "830 KB". */
export function formatBytes(bytes: number): string {
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
