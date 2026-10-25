import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  SpeedMeter,
  applyQueueAction,
  etaSeconds,
  filenameFromDisposition,
  formatBytes,
  isChecksumFile,
  movePackage,
  nextToStart,
  packageProgress,
  parseChecksums,
  planSegments,
  queueFromGrabbed,
  reviveQueue,
  safeName,
  segmentsReceived,
  type QueueItem,
  type QueuePackage,
} from "../src/shared/download-queue";
import { buildPackages } from "../src/shared/link-grabber";

let n = 0;
const item = (host: string, state: QueueItem["state"] = "queued", over: Partial<QueueItem> = {}): QueueItem => ({
  id: `i${++n}`,
  url: `https://${host}/f${n}`,
  filename: `f${n}`,
  host,
  kind: "file",
  state,
  receivedBytes: 0,
  totalBytes: null,
  attempts: 0,
  ...over,
});
const pkg = (id: string, items: QueueItem[]): QueuePackage => ({ id, name: id, source: "x", passwords: [], dir: `/dl/${id}`, addedAt: 1, items });

describe("download queue", () => {
  it("starts files in queue order within the overall and per-host limits", () => {
    const a = pkg("A", [item("one.example", "running"), item("one.example"), item("one.example"), item("two.example")]);
    const b = pkg("B", [item("three.example"), item("three.example")]);
    const next = nextToStart([a, b], { parallel: 4, perHost: 2 });
    expect(next.map((i) => i.host)).toEqual(["one.example", "two.example", "three.example"]);
    expect(nextToStart([a, b], { parallel: 1, perHost: 2 })).toEqual([]);
  });

  it("queues a grabbed package's file links into a folder named after it", () => {
    const [grabbed] = buildPackages(["https://cdn.example/Set.part1.rar", "https://cdn.example/Set.part2.rar"], {
      source: "https://forum.example/t",
      text: "Password: pw",
      now: 5,
      newId: () => `g${++n}`,
    });
    const queued = queueFromGrabbed(grabbed!, "/downloads", path.posix.join);
    expect(queued).toMatchObject({ name: "Set", dir: "/downloads/Set", passwords: ["pw"] });
    expect(queued.items.map((i) => [i.filename, i.part, i.state])).toEqual([
      ["Set.part1.rar", 1, "queued"],
      ["Set.part2.rar", 2, "queued"],
    ]);
    expect(safeName('A: "bad" / name...')).toBe("A bad name");
    expect(safeName("CON")).toBe("Download");
  });

  it("pauses, resumes, retries and removes packages or single files", () => {
    const running = item("h", "running");
    const failed = item("h", "failed", { error: "HTTP 500", attempts: 3 });
    const queued = item("h");
    const list = [pkg("A", [running, queued]), pkg("B", [failed])];
    const paused = applyQueueAction(list, "A", "pause");
    expect(paused.stop).toEqual([running.id]);
    expect(paused.packages[0]?.items.map((i) => i.state)).toEqual(["paused", "paused"]);
    expect(applyQueueAction(paused.packages, queued.id, "resume").packages[0]?.items.map((i) => i.state)).toEqual(["paused", "queued"]);
    const retried = applyQueueAction(list, "B", "retry").packages[1]?.items[0];
    expect(retried).toMatchObject({ state: "queued", attempts: 0 });
    expect(retried?.error).toBeUndefined();
    const removed = applyQueueAction(list, running.id, "remove");
    expect(removed.stop).toEqual([running.id]);
    expect(applyQueueAction(list, "B", "remove").packages.map((p) => p.id)).toEqual(["A"]);
  });

  it("resumes after a restart, reorders packages and adds up progress", () => {
    const list = [pkg("A", [item("h", "running", { receivedBytes: 50, totalBytes: 100 }), item("h", "done", { receivedBytes: 100, totalBytes: 100 })]), pkg("B", [])];
    expect(reviveQueue(list)[0]?.items.map((i) => i.state)).toEqual(["queued", "done"]);
    expect(movePackage(list, "B", -1).map((p) => p.id)).toEqual(["B", "A"]);
    expect(movePackage(list, "A", -1).map((p) => p.id)).toEqual(["A", "B"]);
    expect(packageProgress(list[0]!)).toEqual({ received: 150, total: 200, done: 1, failed: 0, running: 1, waiting: 0, attention: 0, count: 2 });
  });

  it("measures speed and time left", () => {
    const meter = new SpeedMeter(5000);
    meter.add(1000, 0);
    meter.add(1000, 1000);
    meter.add(2000, 2000);
    expect(meter.rate(2000)).toBe(2000);
    expect(meter.rate(60_000)).toBe(0);
    expect(etaSeconds(500, 1500, 100)).toBe(10);
    expect(etaSeconds(500, null, 100)).toBeNull();
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(5 * 1024 * 1024 * 1024)).toBe("5.0 GB");
  });

  it("splits large files into byte ranges and counts what arrived", () => {
    const mb = 1024 * 1024;
    expect(planSegments(4 * mb, 4)).toEqual([{ start: 0, end: 4 * mb - 1, received: 0 }]);
    const four = planSegments(40 * mb, 4);
    expect(four.map((s) => [s.start, s.end])).toEqual([
      [0, 10 * mb - 1],
      [10 * mb, 20 * mb - 1],
      [20 * mb, 30 * mb - 1],
      [30 * mb, 40 * mb - 1],
    ]);
    expect(planSegments(20 * mb, 8).length).toBe(2);
    const odd = planSegments(17 * mb + 3, 2);
    expect(odd[odd.length - 1]?.end).toBe(17 * mb + 2);
    expect(segmentsReceived([{ start: 0, end: 9, received: 4 }, { start: 10, end: 19, received: 10 }])).toBe(14);
  });

  it("reads .sfv, .md5 and .sha256 lists", () => {
    const sfv = parseChecksums("Set.sfv", "; made by tool\nSet.part1.rar 1A2B3C4D\nset.part2.rar  deadbeef\n");
    expect([...sfv]).toEqual([
      ["set.part1.rar", { algorithm: "crc32", hash: "1a2b3c4d" }],
      ["set.part2.rar", { algorithm: "crc32", hash: "deadbeef" }],
    ]);
    const md5 = parseChecksums("Set.md5", "d41d8cd98f00b204e9800998ecf8427e *Set.part1.rar\nbad line\n");
    expect(md5.get("set.part1.rar")).toEqual({ algorithm: "md5", hash: "d41d8cd98f00b204e9800998ecf8427e" });
    const sha = parseChecksums("Set.sha256", `${"a".repeat(64)}  Movie.mkv\n${"b".repeat(40)}  short.bin`);
    expect([...sha.keys()]).toEqual(["movie.mkv"]);
    expect(isChecksumFile("Set.SFV")).toBe(true);
    expect(isChecksumFile("Set.rar")).toBe(false);
  });

  it("starts a file that failed its checksum over, and resumes one that failed on the network", () => {
    const bad = item("h", "failed", { checked: "mismatch", receivedBytes: 100, totalBytes: 100, error: "Checksum mismatch" });
    const net = item("h", "failed", { receivedBytes: 40, segments: [{ start: 0, end: 99, received: 40 }], error: "reset" });
    const out = applyQueueAction([pkg("A", [bad, net])], "A", "retry").packages[0]!.items;
    expect(out[0]).toMatchObject({ state: "queued", receivedBytes: 0 });
    expect(out[0]?.checked).toBeUndefined();
    expect(out[1]).toMatchObject({ state: "queued", segments: [{ start: 0, end: 99, received: 40 }] });
  });

  it("takes the file name the server suggests, safely", () => {
    expect(filenameFromDisposition('attachment; filename="Movie.part1.rar"')).toBe("Movie.part1.rar");
    expect(filenameFromDisposition("attachment; filename*=UTF-8''caf%C3%A9.zip")).toBe("café.zip");
    expect(filenameFromDisposition('attachment; filename="../../evil.exe"')).toBe("evil.exe");
    expect(filenameFromDisposition("inline")).toBeNull();
    expect(filenameFromDisposition(null)).toBeNull();
  });
});
