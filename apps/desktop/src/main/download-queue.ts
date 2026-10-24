import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import type { ProfileId } from "@corvus/shared";
import {
  DEFAULT_LIMITS,
  MAX_ATTEMPTS,
  SpeedMeter,
  applyQueueAction,
  etaSeconds,
  extractionState,
  filenameFromDisposition,
  isChecksumFile,
  movePackage,
  nextToStart,
  packageComplete,
  packageProgress,
  parseChecksums,
  planSegments,
  queueFromGrabbed,
  reviveQueue,
  segmentsReceived,
  shouldAutoExtract,
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
import type { GrabbedPackage } from "../shared/link-grabber";
import { askNativeApproval, type NativeApproval } from "./approval-dialog";
import { SevenZipProcess, extractArchive } from "./archive-extractor";
import type { AppContext } from "./context";
import { JsonFile } from "./json-file";
import type { ProfileRuntime } from "./profiles";

interface ProfileQueue {
  runtime: ProfileRuntime;
  file: JsonFile<QueuePackage[]>;
  notifyTimer: NodeJS.Timeout | null;
}

interface Running {
  abort: AbortController;
  meter: SpeedMeter;
  profileId: ProfileId;
}

/** A failure retrying cannot fix (the download stops at once). */
class FatalDownloadError extends Error {}

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

  constructor(private readonly ctx: AppContext) {}

  private entry(runtime: ProfileRuntime): ProfileQueue {
    let entry = this.profiles.get(runtime.profile.id);
    if (!entry) {
      entry = { runtime, file: JsonFile.load(path.join(runtime.dataDir, "download-queue.json"), () => [], revive, 500), notifyTimer: null };
      this.profiles.set(runtime.profile.id, entry);
    }
    return entry;
  }

  /** Resumes what was queued when Corvus last closed. */
  attach(runtime: ProfileRuntime): void {
    this.pump(this.entry(runtime));
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
      const count = `${allowed.length} ${allowed.length === 1 ? "file" : "files"}`;
      const approval: NativeApproval = {
        allow: "Download",
        title: "AI agent wants to download files",
        message: `Let “${client}” download ${count}${parsed.packageName ? ` into “${parsed.packageName}”` : ""} with Corvus's download queue?`,
        detail: `${describeAgentLinks(allowed)}\n\nThey go to ${this.ctx.downloads.directory()}.`,
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
      const found = this.find(entry, itemId);
      if (!found) return;
      const { pkg, item } = found;
      packageId = pkg.id;
      fs.mkdirSync(pkg.dir, { recursive: true });
      const savePath =
        item.segments && item.segments.length > 0 && item.savePath && item.totalBytes !== null
          ? await this.fetchSegments(entry, itemId, item.url, item.savePath, item.segments, abort.signal, meter)
          : await this.fetchFile(entry, pkg, itemId, abort.signal, meter);
      fs.renameSync(`${savePath}.part`, savePath);
      this.reserved.delete(savePath);
      const size = fs.statSync(savePath).size;
      this.update(entry, itemId, { state: "done", receivedBytes: size, totalBytes: size, finishedAt: Date.now(), attempts: 0 });
    } catch (err) {
      if (this.closing) return;
      const current = this.find(entry, itemId)?.item;
      // Paused or removed: the action already set the state.
      if (current && current.state === "running") {
        const attempts = current.attempts + 1;
        const message = abort.signal.aborted ? "Stopped" : err instanceof Error ? err.message : String(err);
        if (attempts < MAX_ATTEMPTS && !abort.signal.aborted && !(err instanceof FatalDownloadError)) {
          this.update(entry, itemId, { state: "paused", attempts, error: message });
          // Retry after a short wait (longer each time), from where it stopped.
          setTimeout(() => {
            const again = this.find(entry, itemId)?.item;
            if (again?.state === "paused" && again.error === message) {
              this.update(entry, itemId, { state: "queued" });
              this.pump(entry);
            }
          }, 2000 * attempts).unref();
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
    let savePath = item.savePath;
    const offset = savePath && fs.existsSync(`${savePath}.part`) ? fs.statSync(`${savePath}.part`).size : 0;
    // Asking for a range from the start tells whether the server serves ranges at all.
    const res = await entry.runtime.session.fetch(item.url, { headers: { Range: `bytes=${offset}-` }, signal });
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
    if (ranged && offset === 0 && total !== null && wanted > 1) {
      const segments = planSegments(total, wanted);
      if (segments.length > 1) {
        this.update(entry, itemId, { savePath, filename: path.basename(savePath), totalBytes: total, receivedBytes: 0, segments });
        return this.fetchSegments(entry, itemId, item.url, savePath, segments, signal, meter, res);
      }
    }

    const resumed = ranged && offset > 0;
    let received = resumed ? offset : 0;
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
        if (!out.write(value)) await new Promise<void>((r) => out.once("drain", () => r()));
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
      const reader = res.body?.getReader();
      if (!reader) throw new Error("The server sent no file");
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        // The first response is open-ended: keep only this range's bytes.
        const chunk = value.byteLength > seg.end - pos + 1 ? value.subarray(0, seg.end - pos + 1) : value;
        await fh.write(chunk, 0, chunk.byteLength, pos);
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

  /** Refresh corvus://downloads at most a few times a second. */
  private notify(entry: ProfileQueue): void {
    if (entry.notifyTimer) return;
    entry.notifyTimer = setTimeout(() => {
      entry.notifyTimer = null;
      for (const w of this.ctx.windows.forProfile(entry.runtime.profile.id)) w.notifyInternalPages({ type: "downloads-changed" }, ["downloads"]);
    }, 250);
  }

  flush(): void {
    this.closing = true;
    for (const r of this.running.values()) r.abort.abort();
    this.extractor?.close();
    for (const entry of this.profiles.values()) entry.file.flush();
  }
}
