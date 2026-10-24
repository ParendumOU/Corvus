import { describe, expect, it } from "vitest";
import { archiveBase, archiveSets, cleanPasswords, isWrongPassword, parseListing, passwordCandidates, sevenZipError } from "../src/shared/archives";
import { extractionState, packageComplete, reviveQueue, shouldAutoExtract, type QueueItem, type QueuePackage } from "../src/shared/download-queue";

describe("archive sets", () => {
  it("groups each archive's volumes, the one 7-Zip opens first", () => {
    const sets = archiveSets([
      "Movie.part2.rar",
      "Movie.part10.rar",
      "Movie.part1.rar",
      "Old.r01",
      "Old.rar",
      "Old.r00",
      "Backup.7z.002",
      "Backup.7z.001",
      "Spanned.z01",
      "Spanned.zip",
      "video.mkv.002",
      "video.mkv.001",
      "Single.7z",
      "notes.txt",
      "Check.sfv",
    ]);
    expect(sets).toEqual([
      { entry: "Backup.7z.001", kind: "7z", volumes: ["Backup.7z.001", "Backup.7z.002"] },
      { entry: "Movie.part1.rar", kind: "rar", volumes: ["Movie.part1.rar", "Movie.part2.rar", "Movie.part10.rar"] },
      { entry: "Old.rar", kind: "rar", volumes: ["Old.rar", "Old.r00", "Old.r01"] },
      { entry: "Single.7z", kind: "7z", volumes: ["Single.7z"] },
      { entry: "Spanned.zip", kind: "zip", volumes: ["Spanned.zip", "Spanned.z01"] },
      { entry: "video.mkv.001", kind: "split", volumes: ["video.mkv.001", "video.mkv.002"] },
    ]);
  });

  it("leaves out an archive whose first volume is missing", () => {
    expect(archiveSets(["Movie.part2.rar", "Movie.part3.rar", "Backup.7z.002"])).toEqual([]);
  });

  it("matches names whatever their case and keeps the name an archive's volumes share", () => {
    expect(archiveSets(["SHOW.PART01.RAR", "SHOW.PART02.RAR"])[0]).toEqual({ entry: "SHOW.PART01.RAR", kind: "rar", volumes: ["SHOW.PART01.RAR", "SHOW.PART02.RAR"] });
    expect(archiveBase("My Movie.part1.rar")).toBe("My Movie");
    expect(archiveBase("Backup.7z.001")).toBe("Backup");
    expect(archiveBase("plain.txt")).toBe("plain.txt");
  });
});

describe("archive passwords", () => {
  it("tries the typed one, those next to the links, the names, then the saved list, without repeats", () => {
    expect(
      passwordCandidates({ typed: " typed ", found: ["page-pw", "typed"], packageName: "Movie", archives: ["Movie.part1.rar", "Extras.7z"], saved: ["saved", "page-pw", ""] }),
    ).toEqual(["typed", "page-pw", "Movie", "Extras", "saved"]);
    expect(passwordCandidates({ found: [], packageName: "Pkg", archives: [], saved: [] })).toEqual(["Pkg"]);
  });

  it("keeps a saved list clean", () => {
    expect(cleanPasswords(["  a ", "", "b", "a", "x".repeat(300)])).toEqual(["a", "b", "x".repeat(200)]);
    expect(cleanPasswords(Array.from({ length: 600 }, (_, i) => `p${i}`))).toHaveLength(500);
  });
});

describe("7-Zip output", () => {
  it("reads a technical listing", () => {
    const lines = [
      "Listing archive: Movie.part1.rar",
      "--",
      "Path = Movie.part1.rar",
      "Type = Rar5",
      "",
      "----------",
      "Path = Movie",
      "Folder = +",
      "Size = 0",
      "Encrypted = -",
      "",
      "Path = Movie/movie.mkv",
      "Folder = -",
      "Size = 123456",
      "Encrypted = +",
      "",
    ];
    expect(parseListing(lines)).toEqual([
      { path: "Movie", size: 0, folder: true, encrypted: false },
      { path: "Movie/movie.mkv", size: 123456, folder: false, encrypted: true },
    ]);
    expect(parseListing(["no separator here"])).toEqual([]);
  });

  it("tells a wrong password from other errors", () => {
    expect(isWrongPassword(["ERROR: Movie.part1.rar", "Cannot open encrypted archive. Wrong password?"])).toBe(true);
    expect(isWrongPassword(["ERROR: Wrong password : movie.mkv"])).toBe(true);
    expect(isWrongPassword(["ERROR: Movie.part1.rar : Missing volume"])).toBe(false);
    expect(sevenZipError(["Scanning", "ERROR: Movie.part1.rar : Missing volume"], 2)).toBe("Movie.part1.rar : Missing volume");
    expect(sevenZipError(["Open ERROR: Can not open the file as [Rar5] archive", "Is not archive"], 2)).toMatch(/archive/);
    expect(sevenZipError([], 7)).toBe("7-Zip stopped with code 7");
  });
});

describe("package extraction state", () => {
  const item = (state: QueueItem["state"]): QueueItem => ({ id: state, url: "https://h/x", filename: "x", host: "h", kind: "archive-part", state, receivedBytes: 0, totalBytes: null, attempts: 0 });
  const pkg = (items: QueueItem[], extraction?: QueuePackage["extraction"]): QueuePackage => ({
    id: "p",
    name: "p",
    source: "x",
    passwords: [],
    dir: "/dl/p",
    addedAt: 1,
    items,
    ...(extraction ? { extraction } : {}),
  });

  it("extracts on its own once every file is in, unless it already did or is doing it", () => {
    expect(packageComplete(pkg([item("done"), item("done")]))).toBe(true);
    expect(shouldAutoExtract(pkg([item("done"), item("running")]), true)).toBe(false);
    expect(shouldAutoExtract(pkg([item("done")]), true)).toBe(true);
    expect(shouldAutoExtract(pkg([item("done")]), false)).toBe(false);
    expect(shouldAutoExtract(pkg([item("done")], { state: "running", archives: [] }), true)).toBe(false);
    expect(shouldAutoExtract(pkg([item("done")], { state: "done", archives: [] }), true)).toBe(false);
    // A file downloaded again after a failed extraction gives it another go.
    expect(shouldAutoExtract(pkg([item("done")], { state: "failed", archives: [] }), true)).toBe(true);
  });

  it("sums up the archives' results", () => {
    expect(extractionState([{ entry: "a", state: "done" }])).toBe("done");
    expect(extractionState([{ entry: "a", state: "done" }, { entry: "b", state: "password" }])).toBe("password");
    expect(extractionState([{ entry: "a", state: "password" }, { entry: "b", state: "failed" }])).toBe("failed");
    expect(extractionState([{ entry: "a", state: "done" }], "The extractor stopped")).toBe("failed");
  });

  it("marks an extraction Corvus quit in the middle of as failed", () => {
    const [revived] = reviveQueue([pkg([item("done")], { state: "running", archives: [{ entry: "a.rar", state: "done", files: 2 }] })]);
    expect(revived?.extraction).toEqual({ state: "failed", archives: [{ entry: "a.rar", state: "done", files: 2 }], error: "Corvus closed while extracting" });
  });
});
