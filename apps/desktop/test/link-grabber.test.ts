import { describe, expect, it } from "vitest";
import {
  buildPackages,
  classifyLink,
  downloadLinksIn,
  extractUrls,
  filenameOf,
  findPasswords,
  mergePackages,
  splitArchive,
} from "../src/shared/link-grabber";

let n = 0;
const opts = (source: string, text = "") => ({ source, text, now: 1, newId: () => `id${++n}` });

describe("split archives", () => {
  it("recognises every common volume naming", () => {
    expect(splitArchive("Movie.2024.part01.rar")).toEqual({ base: "Movie.2024", part: 1, format: "rar" });
    expect(splitArchive("Movie.part12.rar")).toEqual({ base: "Movie", part: 12, format: "rar" });
    expect(splitArchive("backup.r00")).toEqual({ base: "backup", part: 2, format: "rar" });
    expect(splitArchive("game.7z.003")).toEqual({ base: "game", part: 3, format: "7z" });
    expect(splitArchive("docs.zip.001")).toEqual({ base: "docs", part: 1, format: "zip" });
    expect(splitArchive("docs.z02")).toEqual({ base: "docs", part: 2, format: "zip" });
    expect(splitArchive("disk.img.001")).toEqual({ base: "disk.img", part: 1, format: "split" });
    expect(splitArchive("single.rar")).toBeNull();
    expect(splitArchive("photo.jpg")).toBeNull();
  });
});

describe("links", () => {
  it("knows file links, archive parts and file hosters, and leaves ordinary pages out", () => {
    expect(classifyLink("https://cdn.example/files/setup.exe")).toBe("file");
    expect(classifyLink("https://cdn.example/a/Movie.part2.rar?token=1")).toBe("archive-part");
    expect(classifyLink("https://rapidgator.net/file/abc123/Movie.part1.rar.html")).toBe("archive-part");
    expect(classifyLink("https://mega.nz/file/AbCd#key")).toBe("hoster");
    expect(classifyLink("https://www.mediafire.com/file/x/thing")).toBe("hoster");
    expect(classifyLink("https://news.example/article")).toBeNull();
    expect(classifyLink("ftp://files.example/a.zip")).toBeNull();
    expect(filenameOf("https://rapidgator.net/file/abc123/Movie.part1.rar.html")).toBe("Movie.part1.rar");
    expect(filenameOf("https://cdn.example/My%20File.zip?x=1")).toBe("My File.zip");
  });

  it("finds addresses and passwords in copied text", () => {
    const text = `Download (3 parts): https://cdn.example/a.part1.rar, https://cdn.example/a.part2.rar.
Mirror: https://cdn.example/a.part3.rar
Password: corvus2026
Contraseña = otra.clave
pw:*****`;
    expect(extractUrls(text)).toEqual(["https://cdn.example/a.part1.rar", "https://cdn.example/a.part2.rar", "https://cdn.example/a.part3.rar"]);
    expect(findPasswords(text)).toEqual(["corvus2026", "otra.clave"]);
    expect(findPasswords("Bypass: no, compass: north")).toEqual([]);
    expect(downloadLinksIn("see https://news.example/x and https://cdn.example/b.zip")).toEqual(["https://cdn.example/b.zip"]);
  });
});

describe("packages", () => {
  it("groups the volumes of one archive (in order) and keeps single files apart", () => {
    const pkgs = buildPackages(
      [
        "https://cdn.example/Show.S01.part3.rar",
        "https://cdn.example/Show.S01.part1.rar",
        "https://cdn.example/Show.S01.part2.rar",
        "https://cdn.example/old.rar",
        "https://cdn.example/old.r00",
        "https://cdn.example/manual.pdf",
        "https://mega.nz/file/x#k",
        "https://news.example/page",
        "https://cdn.example/manual.pdf",
      ],
      opts("https://forum.example/thread/1", "Pass: s3cret"),
    );
    expect(pkgs.map((p) => [p.name, p.links.map((l) => l.filename || l.url)])).toEqual([
      ["Show.S01", ["Show.S01.part1.rar", "Show.S01.part2.rar", "Show.S01.part3.rar"]],
      ["old", ["old.rar", "old.r00"]],
      ["manual", ["manual.pdf"]],
      ["Links from mega.nz", ["https://mega.nz/file/x#k"]],
    ]);
    expect(pkgs[0]?.passwords).toEqual(["s3cret"]);
    expect(pkgs[0]?.source).toBe("https://forum.example/thread/1");
  });

  it("merges new links into the grabber without repeats", () => {
    const first = buildPackages(["https://cdn.example/Set.part1.rar"], opts("clipboard"));
    const second = buildPackages(["https://cdn.example/Set.part1.rar", "https://cdn.example/Set.part2.rar"], opts("clipboard", "password: pw1"));
    const merged = mergePackages(first, second);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.links.map((l) => l.part)).toEqual([1, 2]);
    expect(merged[0]?.passwords).toEqual(["pw1"]);
    expect(first[0]?.links).toHaveLength(1);
  });
});
