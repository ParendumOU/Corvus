import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { Notification, type DownloadItem } from "electron";
import type { ProfileId, TabId } from "@corvus/shared";
import {
  DEFAULT_LIMITS,
  MAX_ATTEMPTS,
  SpeedMeter,
  applyQueueAction,
  etaSeconds,
  expandFolder,
  extractionState,
  filenameFromDisposition,
  isChecksumFile,
  movePackage,
  nextToStart,
  nextWake,
  packageComplete,
  packageProgress,
  parseChecksums,
  planSegments,
  queueFromGrabbed,
  reviveQueue,
  safeFileName,
  segmentsReceived,
  shouldAutoExtract,
  wakeWaiting,
  type ArchiveResult,
  type ChecksumAlgorithm,
  type PackageExtraction,
  type QueueAction,
  type Segment,
  type QueueItem,
  type QueuePackage,
  type QueueView,
} from "../shared/download-queue";
import { archiveSets, cleanPasswords, passwordCandidates, type ArchiveSet } from "../shared/archives";
import { agentPackages, describeAgentLinks, parseAgentDownloadRequest, splitAgentLinks, type AgentDownloadRequest } from "../shared/download-ai";
import { isExecutableFilename, uniqueFilename } from "../shared/downloads";
import type { HosterReason } from "../shared/hosters";
import { filenameOf, looksLikeFile, type GrabbedPackage } from "../shared/link-grabber";
import { askNativeApproval, type NativeApproval } from "./approval-dialog";
import { SevenZipProcess, extractArchive } from "./archive-extractor";
import type { QueueSummary } from "../shared/browser-ipc";
import type { AppContext } from "./context";
import { resolveLink } from "./hosters";
import { megaDecryptor } from "./hosters/mega";
import { sessionNet } from "./hosters/session-net";
import type { MegaCipher } from "./hosters/types";
import { JsonFile } from "./json-file";
import type { ProfileRuntime } from "./profiles";
import { tr } from "./menu-i18n";
import type { BrowserWindowCtl } from "./window";

interface ProfileQueue {
  runtime: ProfileRuntime;
  file: JsonFile<QueuePackage[]>;
  notifyTimer: NodeJS.Timeout | null;
  /** Wakes the items a file host made wait. */
  wakeTimer: NodeJS.Timeout | null;
}

interface Running {
  abort: AbortController;
  meter: SpeedMeter;
  profileId: ProfileId;
}

/** A failure retrying cannot fix (the download stops at once). */
class FatalDownloadError extends Error {}

/** A hoster link's file address stopped working: it is looked up again. */
class LinkExpiredError extends Error {}

/** The file host asks to come back later. */
class HostWaitError extends Error {
  constructor(
    readonly seconds: number,
    readonly reason: HosterReason,
  ) {
    super("The file host asks to wait");
  }
}

/** A hoster link's file address is looked up again after this long (they expire). */
const RESOLVED_TTL_MS = 20 * 60 * 1000;

/** What the notification says when a file host needs the person (the downloads page words them the same). */
const REASON_TEXT: Record<HosterReason, string> = {
  captcha: "The free download needs a CAPTCHA",
  challenge: "The site checks that you're a person",
  login: "The file host asks you to sign in",
  premium: "Only premium accounts can download this file",
  password: "The file has a password",
  protector: "The links are behind a link protector",
  page: "Corvus didn't find the file on the page",
  expired: "The download from the page stopped",
  limit: "Free download limit reached",
  quota: "The host's transfer quota is used up for now",
  countdown: "The host makes free downloads wait",
  busy: "The host is busy",
  offline: "The file is no longer on the host",
};

/** Seconds in a Retry-After header, when it has a number. */
function retryAfter(res: Response): number | null {
  const n = Number(res.headers.get("retry-after"));
  return Number.isFinite(n) && n > 0 ? Math.min(n, 6 * 3600) : null;
}

/** What an AI agent's queued downloads became. */
export interface AgentQueueResult {
  packages: Array<{ id: string; name: string; files: number }>;
  /** Programs (by address) an agent may not queue. */
  refused: string[];
  /** Links already in the queue. */
  known: number;
}

function revive(raw: unknown): QueuePackage[] {
  return reviveQueue(Array.isArray(raw) ? (raw.filter((p) => p && typeof p === "object" && Array.isArray((p as QueuePackage).items)) as QueuePackage[]) : []);
}

/** A file's hash in lower-case hex (CRC32 for .sfv lists). */
async function hashFile(file: string, algorithm: ChecksumAlgorithm): Promise<string> {
  const stream = fs.createReadStream(file);
  if (algorithm === "crc32") {
    let crc = 0;
    for await (const chunk of stream) crc = zlib.crc32(chunk as Buffer, crc);
    return (crc >>> 0).toString(16).padStart(8, "0");
  }
  const hash = crypto.createHash(algorithm);
  for await (const chunk of stream) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

/** The archives among a package's downloaded files. */
function packageArchives(pkg: QueuePackage): ArchiveSet[] {
  return archiveSets(pkg.items.filter((i) => i.state === "done" && i.savePath).map((i) => path.basename(i.savePath!)));
}

/** "bytes 100-199/1000" -> 1000. */
function totalFromRange(header: string | null): number | null {
  const m = /\/(\d+)\s*$/.exec(header ?? "");
  return m ? Number(m[1]) : null;
}

/**
 * Corvus's own download queue: packages of links (from the link grabber), downloaded a few at a
 * time and at most a couple per host, through the profile's session (so sites you are signed in
 * to work). Each file is written to "<name>.part" and renamed when complete; a paused, failed or
 * interrupted download resumes where it stopped when the server supports byte ranges.
 */
export class DownloadQueue {
  private readonly profiles = new Map<ProfileId, ProfileQueue>();
  private readonly running = new Map<string, Running>();
  /** Save paths in use, so two downloads never pick the same name. */
  private readonly reserved = new Set<string>();
  /** Corvus is quitting: running downloads stop as they are and resume on the next start. */
  private closing = false;
  /** Package extractions, one after another. */
  private extractions: Promise<void> = Promise.resolve();
  private extractor: SevenZipProcess | null = null;
  /** Smoke tests answer the "AI agent wants to download" dialog. */
  private testApprover: ((approval: NativeApproval) => boolean) | null = null;
  /** Tabs opened with "Open page": what they download goes to that queue item. */
  private readonly pageTabs = new Map<TabId, { profileId: ProfileId; itemId: string }>();
  private lastAsk = 0;

  constructor(private readonly ctx: AppContext) {}

  private entry(runtime: ProfileRuntime): ProfileQueue {
    let entry = this.profiles.get(runtime.profile.id);
    if (!entry) {
      entry = { runtime, file: JsonFile.load(path.join(runtime.dataDir, "download-queue.json"), () => [], revive, 500), notifyTimer: null, wakeTimer: null };
      this.profiles.set(runtime.profile.id, entry);
    }
    return entry;
  }

  /** Resumes what was queued when Corvus last closed. */
  attach(runtime: ProfileRuntime): void {
    const entry = this.entry(runtime);
    this.pump(entry);
    this.scheduleWake(entry);
  }

  private limits(): typeof DEFAULT_LIMITS {
    return { parallel: this.ctx.settings.get().downloads.maxParallel, perHost: DEFAULT_LIMITS.perHost };
  }

  list(runtime: ProfileRuntime): QueueView {
    const now = Date.now();
    const packages = this.entry(runtime).file.get();
    const speeds: Record<string, number> = {};
    for (const [id, r] of this.running) if (r.profileId === runtime.profile.id) speeds[id] = Math.round(r.meter.rate(now));
    return {
      packages: packages.map((p) => {
        const progress = packageProgress(p);
        const speed = p.items.reduce((n, i) => n + (speeds[i.id] ?? 0), 0);
        return { ...p, progress, speed, eta: etaSeconds(progress.received, progress.total, speed), archives: packageArchives(p).length };
      }),
      speeds,
    };
  }

  /** The toolbar's view of the queue, null when nothing is left to download. */
  summary(runtime: ProfileRuntime): QueueSummary | null {
    const left = this.entry(runtime)
      .file.get()
      .flatMap((p) => p.items)
      .filter((i) => i.state !== "done" && i.state !== "failed");
    if (left.length === 0) return null;
    const sized = left.every((i) => i.totalBytes !== null && i.totalBytes > 0);
    const total = left.reduce((n, i) => n + (i.totalBytes ?? 0), 0);
    return {
      left: left.length,
      running: left.filter((i) => i.state === "running").length,
      attention: left.filter((i) => i.state === "attention").length,
      progress: sized && total > 0 ? left.reduce((n, i) => n + i.receivedBytes, 0) / total : null,
    };
  }

  /** Queues grabbed packages (file links); returns how many files were queued. */
  addGrabbed(runtime: ProfileRuntime, grabbed: readonly GrabbedPackage[]): number {
    return this.enqueue(this.entry(runtime), grabbed).reduce((n, p) => n + p.items.length, 0);
  }

  /** Adds packages, leaving out links already queued; returns the packages added. */
  private enqueue(entry: ProfileQueue, grabbed: readonly GrabbedPackage[], addedBy?: string): QueuePackage[] {
    const dir = this.ctx.downloads.directory();
    const added = grabbed.map((g) => queueFromGrabbed(g, dir, path.join)).filter((p) => p.items.length > 0);
    if (added.length === 0) return [];
    const known = new Set(entry.file.get().flatMap((p) => p.items.map((i) => i.url)));
    const fresh = added
      .map((p) => ({ ...p, items: p.items.filter((i) => !known.has(i.url)), ...(addedBy ? { addedBy } : {}) }))
      .filter((p) => p.items.length > 0);
    if (fresh.length === 0) return [];
    entry.file.set([...entry.file.get(), ...fresh]);
    this.pump(entry);
    this.notify(entry);
    return fresh;
  }

  /**
   * Queues the files an AI agent found, after the person approved them (the Command Bar's run panel
   * asks for queue_downloads; agent() asks MCP clients' requests in a dialog). Programs are never
   * queued for an agent.
   */
  addAgentLinks(runtime: ProfileRuntime, request: AgentDownloadRequest, client: string, source: string): AgentQueueResult {
    const { allowed, refused } = splitAgentLinks(request.links);
    if (allowed.length === 0) return { packages: [], refused, known: 0 };
    const grabbed = agentPackages({ ...request, links: allowed }, { source, now: Date.now(), newId: () => crypto.randomUUID() });
    const added = this.enqueue(this.entry(runtime), grabbed, client);
    const files = added.reduce((n, p) => n + p.items.length, 0);
    return { packages: added.map((p) => ({ id: p.id, name: p.name, files: p.items.length })), refused, known: allowed.length - files };
  }

  /** Smoke tests answer the approval dialog; null restores it. */
  setTestApprover(approver: ((approval: NativeApproval) => boolean) | null): void {
    this.testApprover = approver;
  }

  /**
   * The download_queue MCP tools: "list", "add" (asks the person in a dialog first) and "control"
   * (pause, resume, retry, remove or extract a package or file). Returns JSON text.
   */
  async agent(runtime: ProfileRuntime, request: Record<string, unknown>, client: string): Promise<string> {
    const action = request.action;
    if (action === "list") return JSON.stringify(this.agentView(runtime));
    if (action === "add") {
      const parsed = parseAgentDownloadRequest(request);
      const { allowed, refused } = splitAgentLinks(parsed.links);
      if (allowed.length === 0) throw new Error(`Corvus does not download programs for AI agents (${refused.length} refused). The person can download them from the page.`);
      const count = allowed.length;
      const approval: NativeApproval = {
        allow: tr("Download"),
        title: tr("AI agent wants to download files"),
        message:
          count === 1
            ? parsed.packageName
              ? tr("Let “{client}” download 1 file into “{name}” with Corvus's download queue?", { client, name: parsed.packageName })
              : tr("Let “{client}” download 1 file with Corvus's download queue?", { client })
            : parsed.packageName
              ? tr("Let “{client}” download {count} files into “{name}” with Corvus's download queue?", { client, count, name: parsed.packageName })
              : tr("Let “{client}” download {count} files with Corvus's download queue?", { client, count }),
        detail: `${describeAgentLinks(allowed)}\n\n${tr("They go to {dir}.", { dir: this.ctx.downloads.directory() })}`,
      };
      const ok = this.testApprover ? this.testApprover(approval) : await askNativeApproval(this.ctx, approval);
      if (!ok) throw new Error("The user declined these downloads.");
      return JSON.stringify(this.addAgentLinks(runtime, { ...parsed, links: allowed }, client, `mcp:${client}`));
    }
    if (action === "control") {
      const id = typeof request.id === "string" ? request.id : "";
      const op = request.op;
      const found = this.entry(runtime).file.get().find((p) => p.id === id || p.items.some((i) => i.id === id));
      if (!found) throw new Error(`No package or file ${JSON.stringify(id)} in the queue. Call download_queue to see the ids.`);
      if (op === "extract") this.extract(runtime, found.id, typeof request.password === "string" ? request.password : undefined);
      else if (op === "pause" || op === "resume" || op === "retry" || op === "remove") this.act(runtime, id, op);
      else throw new Error("op must be pause, resume, retry, remove or extract");
      return JSON.stringify(this.agentView(runtime).filter((p) => p.id === found.id));
    }
    throw new Error("action must be list, add or control");
  }

  /** The queue as agents see it: ids, states and progress. */
  private agentView(runtime: ProfileRuntime) {
    return this.list(runtime).packages.map((p) => ({
      id: p.id,
      name: p.name,
      folder: p.dir,
      ...(p.addedBy ? { addedBy: p.addedBy } : {}),
      files: p.items.map((i) => ({
        id: i.id,
        name: i.filename,
        state: i.state,
        ...(i.hoster ? { host: i.hoster } : {}),
        ...(i.reason ? { reason: REASON_TEXT[i.reason] } : {}),
        ...(i.state === "waiting" && i.retryAt ? { secondsToWait: Math.max(0, Math.ceil((i.retryAt - Date.now()) / 1000)) } : {}),
        received: i.receivedBytes,
        total: i.totalBytes,
        ...(i.error ? { error: i.error } : {}),
        ...(i.checked ? { checksum: i.checked } : {}),
      })),
      ...(p.extraction
        ? { extraction: { state: p.extraction.state, files: p.extraction.archives.reduce((n, a) => n + (a.files ?? 0), 0), ...(p.extraction.error ? { error: p.extraction.error } : {}) } }
        : {}),
      ...(p.speed ? { bytesPerSecond: p.speed } : {}),
      ...(p.eta !== null ? { secondsLeft: p.eta } : {}),
    }));
  }

  act(runtime: ProfileRuntime, id: string, action: QueueAction): void {
    const entry = this.entry(runtime);
    const before = entry.file.get();
    const removed = action === "remove" ? before.flatMap((p) => (p.id === id ? p.items : p.items.filter((i) => i.id === id))) : [];
    const { packages, stop } = applyQueueAction(before, id, action);
    entry.file.set(packages);
    for (const itemId of stop) this.running.get(itemId)?.abort.abort();
    this.scheduleWake(entry);
    // A removed download that never finished leaves no part file behind.
    for (const item of removed) {
      if (item.state !== "done" && item.savePath) fs.rm(`${item.savePath}.part`, { force: true }, () => undefined);
      if (item.savePath) this.reserved.delete(item.savePath);
    }
    this.pump(entry);
    this.notify(entry);
  }

  move(runtime: ProfileRuntime, id: string, delta: -1 | 1): void {
    const entry = this.entry(runtime);
    entry.file.set(movePackage(entry.file.get(), id, delta));
    this.notify(entry);
  }

  /** Removes finished packages. */
  clearDone(runtime: ProfileRuntime): void {
    const entry = this.entry(runtime);
    entry.file.set(entry.file.get().filter((p) => p.items.some((i) => i.state !== "done")));
    this.notify(entry);
  }

  private update(entry: ProfileQueue, itemId: string, patch: Partial<QueueItem>): QueueItem | undefined {
    let updated: QueueItem | undefined;
    entry.file.set(
      entry.file.get().map((p) => ({
        ...p,
        items: p.items.map((i) => {
          if (i.id !== itemId) return i;
          updated = { ...i, ...patch };
          return updated;
        }),
      })),
    );
    return updated;
  }

  private find(entry: ProfileQueue, itemId: string): { pkg: QueuePackage; item: QueueItem } | undefined {
    for (const pkg of entry.file.get()) {
      const item = pkg.items.find((i) => i.id === itemId);
      if (item) return { pkg, item };
    }
    return undefined;
  }

  private pump(entry: ProfileQueue): void {
    for (const item of nextToStart(entry.file.get(), this.limits())) {
      this.update(entry, item.id, { state: "running" });
      void this.run(entry, item.id);
    }
  }

  private async run(entry: ProfileQueue, itemId: string): Promise<void> {
    const abort = new AbortController();
    const meter = new SpeedMeter();
    this.running.set(itemId, { abort, meter, profileId: entry.runtime.profile.id });
    let packageId: string | null = null;
    try {
      let found = this.find(entry, itemId);
      if (!found) return;
      packageId = found.pkg.id;
      const resolved = found.item.resolved;
      if (found.item.kind === "hoster" && (!resolved || Date.now() - resolved.at > RESOLVED_TTL_MS)) {
        // Waiting, needing the person, a folder's files queued instead, or gone: nothing to fetch now.
        found = (await this.lookUp(entry, itemId, abort.signal)) ?? undefined;
        if (!found) return;
      }
      const { pkg, item } = found;
      fs.mkdirSync(pkg.dir, { recursive: true });
      const savePath =
        item.segments && item.segments.length > 0 && item.savePath && item.totalBytes !== null
          ? await this.fetchSegments(entry, itemId, item.resolved?.url ?? item.url, item.savePath, item.segments, abort.signal, meter, item.resolved?.mega)
          : await this.fetchFile(entry, pkg, itemId, abort.signal, meter);
      fs.renameSync(`${savePath}.part`, savePath);
      this.reserved.delete(savePath);
      const size = fs.statSync(savePath).size;
      this.update(entry, itemId, { state: "done", receivedBytes: size, totalBytes: size, finishedAt: Date.now(), attempts: 0 });
    } catch (err) {
      if (this.closing) return;
      const current = this.find(entry, itemId)?.item;
      // Paused or removed: the action already set the state.
      if (current && current.state === "running" && err instanceof HostWaitError) {
        this.update(entry, itemId, { state: "waiting", retryAt: Date.now() + err.seconds * 1000, reason: err.reason });
        this.scheduleWake(entry);
      } else if (current && current.state === "running") {
        const attempts = current.attempts + 1;
        const message = abort.signal.aborted ? "Stopped" : err instanceof Error ? err.message : String(err);
        // An expired file address is looked up again on the next try.
        const expired = err instanceof LinkExpiredError ? { resolved: undefined } : {};
        if (attempts < MAX_ATTEMPTS && !abort.signal.aborted && !(err instanceof FatalDownloadError)) {
          this.update(entry, itemId, { ...expired, state: "paused", attempts, error: message });
          // Retry after a short wait (longer each time), from where it stopped.
          setTimeout(() => {
            const again = this.find(entry, itemId)?.item;
            if (again?.state === "paused" && again.error === message) {
              this.update(entry, itemId, { state: "queued" });
              this.pump(entry);
            }
          }, 2000 * attempts).unref();
        } else if (err instanceof LinkExpiredError) {
          this.update(entry, itemId, { ...expired, state: "attention", reason: "page", attempts, error: message });
          this.askPerson(entry, itemId);
        } else {
          this.update(entry, itemId, { state: "failed", attempts, error: message });
        }
      }
    } finally {
      this.running.delete(itemId);
      if (!this.closing) {
        this.pump(entry);
        this.notify(entry);
        if (packageId) void this.finishPackage(entry, packageId);
      }
    }
  }

  /**
   * First connection to a file: picks its name, then either streams it whole (resuming a part file
   * by byte range) or, for a large file on a server that serves ranges, switches to parallel
   * segments, reading this first response as the first one. Returns the save path.
   */
  private async fetchFile(entry: ProfileQueue, pkg: QueuePackage, itemId: string, signal: AbortSignal, meter: SpeedMeter): Promise<string> {
    const item = this.find(entry, itemId)!.item;
    const url = item.resolved?.url ?? item.url;
    const mega = item.resolved?.mega;
    let savePath = item.savePath;
    const offset = savePath && fs.existsSync(`${savePath}.part`) ? fs.statSync(`${savePath}.part`).size : 0;
    // Asking for a range from the start tells whether the server serves ranges at all.
    const res = await entry.runtime.session.fetch(url, { headers: { Range: `bytes=${offset}-` }, signal });
    if (item.kind === "hoster") await this.checkHostAnswer(res);
    if (!res.ok) throw new Error(`The server answered ${res.status}`);
    const ranged = res.status === 206;
    if (!savePath) {
      const name = filenameFromDisposition(res.headers.get("content-disposition")) ?? item.filename;
      if (pkg.addedBy && isExecutableFilename(name)) {
        await res.body?.cancel().catch(() => undefined);
        throw new FatalDownloadError(`${name} is a program: Corvus does not download programs for AI agents`);
      }
      const taken = (n: string): boolean => this.reserved.has(path.join(pkg.dir, n)) || fs.existsSync(path.join(pkg.dir, n)) || fs.existsSync(path.join(pkg.dir, `${n}.part`));
      savePath = path.join(pkg.dir, uniqueFilename(name, taken));
      this.reserved.add(savePath);
    }
    const length = Number(res.headers.get("content-length"));
    const total = ranged ? totalFromRange(res.headers.get("content-range")) : Number.isFinite(length) && length > 0 ? length : null;

    const wanted = this.ctx.settings.get().downloads.segments;
    if (ranged && offset === 0 && total !== null && wanted > 1 && !item.resolved?.single) {
      const segments = planSegments(total, wanted);
      if (segments.length > 1) {
        this.update(entry, itemId, { savePath, filename: path.basename(savePath), totalBytes: total, receivedBytes: 0, segments });
        return this.fetchSegments(entry, itemId, url, savePath, segments, signal, meter, mega, res);
      }
    }

    const resumed = ranged && offset > 0;
    let received = resumed ? offset : 0;
    const decrypt = mega ? megaDecryptor(mega, received) : null;
    this.update(entry, itemId, { savePath, filename: path.basename(savePath), totalBytes: total, receivedBytes: received });
    this.notify(entry);
    const out = fs.createWriteStream(`${savePath}.part`, { flags: resumed ? "a" : "w" });
    try {
      const reader = res.body?.getReader();
      if (!reader) throw new Error("The server sent no file");
      let lastUpdate = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!out.write(decrypt ? decrypt(value) : value)) await new Promise<void>((r) => out.once("drain", () => r()));
        received += value.byteLength;
        const now = Date.now();
        meter.add(value.byteLength, now);
        if (now - lastUpdate > 250) {
          lastUpdate = now;
          this.update(entry, itemId, { receivedBytes: received });
          this.notify(entry);
        }
      }
      await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())));
    } catch (err) {
      out.destroy();
      throw err;
    }
    if (total !== null && received !== total) throw new Error(`Incomplete: ${received} of ${total} bytes`);
    return savePath;
  }

  /**
   * Downloads a file's byte ranges in parallel into one part file (each written at its offset),
   * saving each range's progress so a pause or restart resumes every range where it stopped.
   */
  private async fetchSegments(
    entry: ProfileQueue,
    itemId: string,
    url: string,
    savePath: string,
    planned: readonly Segment[],
    signal: AbortSignal,
    meter: SpeedMeter,
    mega?: MegaCipher,
    first?: Response,
  ): Promise<string> {
    const part = `${savePath}.part`;
    const segments = planned.map((s) => ({ ...s }));
    const fh = await fs.promises.open(part, fs.existsSync(part) ? "r+" : "w");
    const local = new AbortController();
    const stopAll = (): void => local.abort();
    signal.addEventListener("abort", stopAll);
    let lastSave = 0;
    const save = (force: boolean): void => {
      const now = Date.now();
      if (!force && now - lastSave < 250) return;
      lastSave = now;
      this.update(entry, itemId, { segments: segments.map((s) => ({ ...s })), receivedBytes: segmentsReceived(segments) });
      this.notify(entry);
    };
    const one = async (seg: Segment, index: number): Promise<void> => {
      const length = seg.end - seg.start + 1;
      if (seg.received >= length) return;
      let pos = seg.start + seg.received;
      const res = index === 0 && first && pos === 0 ? first : await entry.runtime.session.fetch(url, { headers: { Range: `bytes=${pos}-${seg.end}` }, signal: local.signal });
      if (res !== first && res.status !== 206) throw new Error(`The server stopped serving byte ranges (${res.status})`);
      const decrypt = mega ? megaDecryptor(mega, pos) : null;
      const reader = res.body?.getReader();
      if (!reader) throw new Error("The server sent no file");
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        // The first response is open-ended: keep only this range's bytes.
        const chunk = value.byteLength > seg.end - pos + 1 ? value.subarray(0, seg.end - pos + 1) : value;
        const data = decrypt ? decrypt(chunk) : chunk;
        await fh.write(data, 0, data.byteLength, pos);
        pos += chunk.byteLength;
        seg.received += chunk.byteLength;
        meter.add(chunk.byteLength, Date.now());
        save(false);
        if (pos > seg.end) {
          await reader.cancel().catch(() => undefined);
          break;
        }
      }
      if (seg.received < length) throw new Error("A part of the file ended early");
    };
    try {
      const results = await Promise.allSettled(segments.map((s, i) => one(s, i).catch((err: unknown) => (stopAll(), Promise.reject(err)))));
      const failed = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
      if (failed) throw failed.reason;
    } finally {
      signal.removeEventListener("abort", stopAll);
      await fh.close().catch(() => undefined);
      save(true);
    }
    return savePath;
  }

  /**
   * Finds the file behind a hoster link (through the profile's session, so the person's sign-ins
   * count). Returns the item ready to fetch, or null when it waits, needs the person, became its
   * folder's files, or is gone (its state says which).
   */
  private async lookUp(entry: ProfileQueue, itemId: string, signal: AbortSignal): Promise<{ pkg: QueuePackage; item: QueueItem } | null> {
    const item = this.find(entry, itemId)!.item;
    this.update(entry, itemId, { resolving: true });
    this.notify(entry);
    let result;
    try {
      result = await resolveLink(item.url, sessionNet(entry.runtime.session, signal));
    } finally {
      this.update(entry, itemId, { resolving: undefined });
    }
    if (signal.aborted) throw new Error("Stopped");
    switch (result.type) {
      case "file": {
        const current = this.find(entry, itemId)?.item;
        if (!current) return null;
        const named = result.filename ?? (looksLikeFile(result.url) ? filenameOf(result.url) : undefined);
        this.update(entry, itemId, {
          resolved: { url: result.url, at: Date.now(), ...(result.mega ? { mega: result.mega } : {}), ...(result.segments === false ? { single: true } : {}) },
          // The host's name for the file, unless saving it already started under another.
          ...(named && !current.savePath ? { filename: safeFileName(named) } : {}),
          ...(result.size !== undefined && current.totalBytes === null ? { totalBytes: result.size } : {}),
          reason: undefined,
        });
        return this.find(entry, itemId) ?? null;
      }
      case "folder":
        entry.file.set(
          expandFolder(entry.file.get(), itemId, result.entries, {
            newId: () => crypto.randomUUID(),
            ...(result.name ? { folderName: result.name } : {}),
            join: path.join,
            dirname: path.dirname,
          }),
        );
        return null;
      case "wait":
        this.update(entry, itemId, { state: "waiting", retryAt: Date.now() + result.seconds * 1000, reason: result.reason });
        this.scheduleWake(entry);
        return null;
      case "attention":
        this.update(entry, itemId, { state: "attention", reason: result.reason });
        this.askPerson(entry, itemId);
        return null;
      case "offline":
        this.update(entry, itemId, { state: "failed", reason: "offline", error: REASON_TEXT.offline });
        return null;
    }
  }

  /** A hoster's file address that answers "wait", "gone" or with a page instead of the file. */
  private async checkHostAnswer(res: Response): Promise<void> {
    const drop = (): Promise<void> => res.body?.cancel().catch(() => undefined) ?? Promise.resolve();
    if (res.status === 429 || res.status === 503 || res.status === 509) {
      await drop();
      throw new HostWaitError(retryAfter(res) ?? (res.status === 509 ? 30 * 60 : 60), res.status === 509 ? "quota" : "busy");
    }
    if (res.status === 401 || res.status === 403 || res.status === 404 || res.status === 410) {
      await drop();
      throw new LinkExpiredError(`The file host answered ${res.status}`);
    }
    const type = res.headers.get("content-type") ?? "";
    if (res.ok && /text\/html/i.test(type) && !/attachment/i.test(res.headers.get("content-disposition") ?? "")) {
      await drop();
      throw new LinkExpiredError("The file host sent a page instead of the file");
    }
  }

  /** Puts the items whose wait is over back in the queue, at the right time. */
  private scheduleWake(entry: ProfileQueue): void {
    if (entry.wakeTimer) clearTimeout(entry.wakeTimer);
    entry.wakeTimer = null;
    const at = nextWake(entry.file.get());
    if (at === null || this.closing) return;
    entry.wakeTimer = setTimeout(() => {
      entry.wakeTimer = null;
      entry.file.set(wakeWaiting(entry.file.get(), Date.now()));
      this.pump(entry);
      this.notify(entry);
      this.scheduleWake(entry);
    }, Math.min(Math.max(0, at - Date.now()), 2 ** 31 - 1));
    entry.wakeTimer.unref();
  }

  /** A file host needs the person: a notification when Corvus is in the background (at most one a minute). */
  private askPerson(entry: ProfileQueue, itemId: string): void {
    const item = this.find(entry, itemId)?.item;
    const windows = this.ctx.windows.forProfile(entry.runtime.profile.id);
    if (!item || windows.some((w) => !w.win.isDestroyed() && w.win.isFocused()) || !Notification.isSupported() || Date.now() - this.lastAsk < 60_000) return;
    this.lastAsk = Date.now();
    const n = new Notification({ title: tr("A file host needs you"), body: `${item.hoster ?? item.host}: ${tr(REASON_TEXT[item.reason ?? "page"])}` });
    n.on("click", () => {
      const win = windows.find((w) => !w.win.isDestroyed());
      if (!win) return;
      win.win.show();
      win.win.focus();
      win.openSingleton("corvus://downloads/");
    });
    n.show();
  }

  /**
   * "Open page" on a file that needs the person: its page opens in a tab, and the download the
   * page starts there (or in a tab it opens) lands in the queue item, in the package's folder.
   */
  openPage(win: BrowserWindowCtl, itemId: string): void {
    const found = this.find(this.entry(win.profile), itemId);
    if (!found) throw new Error("No such file in the queue");
    const tab = win.createTab(found.item.url, { activate: true });
    this.pageTabs.set(tab.id, { profileId: win.profile.profile.id, itemId });
  }

  /** The browser started a download in a tab opened with "Open page": the queue takes it. */
  claimDownload(runtime: ProfileRuntime, win: BrowserWindowCtl, tabId: TabId, download: DownloadItem): boolean {
    const opener = win.openerOf(tabId);
    const link = this.pageTabs.get(tabId) ?? (opener ? this.pageTabs.get(opener) : undefined);
    if (!link || link.profileId !== runtime.profile.id) return false;
    const entry = this.entry(runtime);
    const found = this.find(entry, link.itemId);
    if (!found || found.item.state === "done" || found.item.state === "running") return false;
    const { pkg, item } = found;
    const name = safeFileName(download.getFilename() || item.filename);
    // Programs for an AI agent's package go through the browser's own check instead.
    if (pkg.addedBy && isExecutableFilename(name)) return false;
    for (const [tab, l] of this.pageTabs) if (l.itemId === item.id) this.pageTabs.delete(tab);
    fs.mkdirSync(pkg.dir, { recursive: true });
    const savePath = path.join(pkg.dir, uniqueFilename(name, (n) => this.reserved.has(path.join(pkg.dir, n)) || fs.existsSync(path.join(pkg.dir, n))));
    this.reserved.add(savePath);
    download.setSavePath(savePath);
    const abort = new AbortController();
    const meter = new SpeedMeter();
    abort.signal.addEventListener("abort", () => download.cancel());
    this.running.set(item.id, { abort, meter, profileId: runtime.profile.id });
    this.update(entry, item.id, {
      state: "running",
      inPage: true,
      reason: undefined,
      error: undefined,
      retryAt: undefined,
      segments: undefined,
      savePath,
      filename: path.basename(savePath),
      receivedBytes: 0,
      totalBytes: download.getTotalBytes() || null,
    });
    let last = 0;
    download.on("updated", () => {
      const received = download.getReceivedBytes();
      meter.add(Math.max(0, received - last), Date.now());
      last = received;
      this.update(entry, item.id, { receivedBytes: received, totalBytes: download.getTotalBytes() || null });
      this.notify(entry);
    });
    download.once("done", (_event, state) => {
      this.running.delete(item.id);
      this.reserved.delete(savePath);
      const current = this.find(entry, item.id)?.item;
      if (current && state === "completed") {
        const size = fs.existsSync(savePath) ? fs.statSync(savePath).size : download.getReceivedBytes();
        this.update(entry, item.id, { state: "done", inPage: undefined, receivedBytes: size, totalBytes: size, finishedAt: Date.now(), attempts: 0 });
      } else if (current && current.state === "running") {
        this.update(entry, item.id, { state: "attention", inPage: undefined, reason: "expired" });
      } else if (current) {
        this.update(entry, item.id, { inPage: undefined });
      }
      this.pump(entry);
      this.notify(entry);
      void this.finishPackage(entry, pkg.id);
    });
    this.notify(entry);
    return true;
  }

  /**
   * Once every file of a package is in, checks them against the package's checksum file
   * (.sfv, .md5, .sha1, .sha256) when it has one. A file that does not match fails, and a retry
   * downloads it again from the start.
   */
  private async verifyPackage(entry: ProfileQueue, packageId: string): Promise<void> {
    const pkg = entry.file.get().find((p) => p.id === packageId);
    if (!pkg || !pkg.items.every((i) => i.state === "done")) return;
    const lists = pkg.items.filter((i) => isChecksumFile(i.filename) && i.savePath && fs.existsSync(i.savePath));
    if (lists.length === 0) return;
    const expected = new Map<string, { algorithm: ChecksumAlgorithm; hash: string }>();
    for (const list of lists) for (const [name, sum] of parseChecksums(list.filename, fs.readFileSync(list.savePath!, "utf8"))) expected.set(name, sum);
    for (const item of pkg.items) {
      const sum = expected.get(item.filename.toLowerCase());
      if (!sum || !item.savePath || item.checked) continue;
      const actual = await hashFile(item.savePath, sum.algorithm);
      if (actual === sum.hash) {
        this.update(entry, item.id, { checked: "ok" });
      } else {
        this.update(entry, item.id, { checked: "mismatch", state: "failed", error: `Checksum mismatch (${sum.algorithm} ${actual}, expected ${sum.hash})` });
      }
    }
    this.notify(entry);
  }

  /** After a file finishes: checks the package's checksums, then extracts it once complete. */
  private async finishPackage(entry: ProfileQueue, packageId: string): Promise<void> {
    await this.verifyPackage(entry, packageId);
    const pkg = entry.file.get().find((p) => p.id === packageId);
    if (!this.closing && pkg && shouldAutoExtract(pkg, this.ctx.settings.get().downloads.extractArchives)) this.startExtraction(entry, pkg);
  }

  /** Extracts a finished package's archives now, trying `password` first when given. */
  extract(runtime: ProfileRuntime, packageId: string, password?: string): void {
    const entry = this.entry(runtime);
    const pkg = entry.file.get().find((p) => p.id === packageId);
    if (!pkg) throw new Error("No such package");
    if (!packageComplete(pkg)) throw new Error("Not every file of the package is in yet");
    if (pkg.extraction?.state === "running") return;
    this.startExtraction(entry, pkg, password?.trim() || undefined);
  }

  private setExtraction(entry: ProfileQueue, packageId: string, extraction: PackageExtraction): void {
    entry.file.set(entry.file.get().map((p) => (p.id === packageId ? { ...p, extraction } : p)));
    this.notify(entry);
  }

  /** Queues a package's extraction: packages extract one at a time, each in its own 7-Zip process. */
  private startExtraction(entry: ProfileQueue, pkg: QueuePackage, typed?: string): void {
    const sets = packageArchives(pkg);
    if (sets.length === 0) return;
    // Archives an earlier run already extracted are kept as they are.
    const kept = pkg.extraction?.archives.filter((a) => a.state === "done") ?? [];
    this.setExtraction(entry, pkg.id, { state: "running", archives: kept, ...(pkg.extraction?.password ? { password: pkg.extraction.password } : {}) });
    this.extractions = this.extractions.then(() => this.runExtraction(entry, pkg.id, sets, typed)).catch(() => undefined);
  }

  private async runExtraction(entry: ProfileQueue, packageId: string, sets: readonly ArchiveSet[], typed?: string): Promise<void> {
    const pkg = entry.file.get().find((p) => p.id === packageId);
    if (!pkg || this.closing) return;
    const settings = this.ctx.settings.get().downloads;
    const candidates = passwordCandidates({ typed, found: pkg.passwords, packageName: pkg.name, archives: sets.map((s) => s.entry), saved: settings.archivePasswords });
    const results: ArchiveResult[] = [...(pkg.extraction?.archives ?? [])];
    let password = pkg.extraction?.password;
    let error: string | undefined;
    let extractor: SevenZipProcess | null = null;
    try {
      extractor = new SevenZipProcess(pkg.dir);
      this.extractor = extractor;
      for (const set of sets) {
        if (results.some((r) => r.entry === set.entry)) continue;
        // The password that opened one archive is the likeliest for the next.
        const order = password ? [password, ...candidates.filter((c) => c !== password)] : candidates;
        const outcome = await extractArchive(extractor.run, set, order);
        if (outcome.status === "done") {
          if (outcome.password !== null) password = outcome.password;
          let deleted = false;
          if (settings.deleteArchives) {
            for (const volume of set.volumes) await fs.promises.rm(path.join(pkg.dir, volume), { force: true });
            deleted = true;
          }
          results.push({ entry: set.entry, state: "done", files: outcome.files, ...(deleted ? { deleted } : {}) });
        } else {
          results.push(outcome.status === "password" ? { entry: set.entry, state: "password" } : { entry: set.entry, state: "failed", error: outcome.error });
        }
        this.setExtraction(entry, packageId, { state: "running", archives: [...results], ...(password ? { password } : {}) });
      }
    } catch (err) {
      if (this.closing) return;
      error = err instanceof Error ? err.message : String(err);
    } finally {
      extractor?.close();
      if (this.extractor === extractor) this.extractor = null;
    }
    this.setExtraction(entry, packageId, { state: extractionState(results, error), archives: results, ...(password ? { password } : {}), ...(error ? { error } : {}) });
    // A password you typed that worked joins your list, for the next packages from the same place.
    if (typed && password === typed && !settings.archivePasswords.includes(typed)) {
      this.ctx.settings.update({ downloads: { archivePasswords: cleanPasswords([...this.ctx.settings.get().downloads.archivePasswords, typed]) } });
    }
  }

  /** Refresh corvus://downloads and the toolbar's downloads button at most a few times a second. */
  private notify(entry: ProfileQueue): void {
    if (entry.notifyTimer) return;
    entry.notifyTimer = setTimeout(() => {
      entry.notifyTimer = null;
      for (const w of this.ctx.windows.forProfile(entry.runtime.profile.id)) {
        w.notifyInternalPages({ type: "downloads-changed" }, ["downloads"]);
        w.pushState();
      }
    }, 250);
  }

  flush(): void {
    this.closing = true;
    for (const entry of this.profiles.values()) if (entry.wakeTimer) clearTimeout(entry.wakeTimer);
    for (const r of this.running.values()) r.abort.abort();
    this.extractor?.close();
    for (const entry of this.profiles.values()) entry.file.flush();
  }
}
