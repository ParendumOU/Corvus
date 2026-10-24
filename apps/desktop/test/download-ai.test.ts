import { describe, expect, it } from "vitest";
import { classifyAction } from "../src/shared/agent-safety";
import { summarizeArgs } from "../src/shared/agent-activity";
import { agentPackages, describeAgentLinks, downloadAiTask, parseAgentDownloadRequest, splitAgentLinks } from "../src/shared/download-ai";

let n = 0;
const ids = () => `id${++n}`;

describe("agent download requests", () => {
  it("keeps http(s) links once, with an optional package name and password", () => {
    expect(
      parseAgentDownloadRequest({ links: [" https://a.example/x.rar", "https://a.example/x.rar", "http://b.example/y.zip"], packageName: " Movie ", password: "pw" }),
    ).toEqual({ links: ["https://a.example/x.rar", "http://b.example/y.zip"], packageName: "Movie", password: "pw" });
    expect(parseAgentDownloadRequest({ links: ["https://a.example/x.rar"], packageName: "", password: null })).toEqual({ links: ["https://a.example/x.rar"] });
  });

  it("refuses anything else", () => {
    expect(() => parseAgentDownloadRequest({ links: [] })).toThrow(/non-empty/);
    expect(() => parseAgentDownloadRequest({ links: "https://a.example/x" })).toThrow();
    expect(() => parseAgentDownloadRequest({ links: ["file:///etc/passwd"] })).toThrow(/http/);
    expect(() => parseAgentDownloadRequest({ links: ["javascript:alert(1)"] })).toThrow(/http/);
    expect(() => parseAgentDownloadRequest({ links: ["not a url"] })).toThrow(/Not a URL/);
    expect(() => parseAgentDownloadRequest({ links: Array.from({ length: 201 }, (_, i) => `https://a.example/${i}.zip`) })).toThrow(/At most/);
    expect(() => parseAgentDownloadRequest({ links: ["https://a.example/x.zip"], packageName: "x".repeat(121) })).toThrow(/packageName/);
  });

  it("never queues programs for an agent", () => {
    expect(splitAgentLinks(["https://a.example/setup.exe", "https://a.example/movie.mkv", "https://a.example/tool.msi?x=1", "https://cdn.example/dl/abc"])).toEqual({
      allowed: ["https://a.example/movie.mkv", "https://cdn.example/dl/abc"],
      refused: ["https://a.example/setup.exe", "https://a.example/tool.msi?x=1"],
    });
  });
});

describe("agent packages", () => {
  it("groups the volumes of an archive and counts a file host's direct link as a file", () => {
    const pkgs = agentPackages(
      { links: ["https://dl3.rapidgator.net/x/Movie.part2.rar", "https://dl3.rapidgator.net/x/Movie.part1.rar", "https://cdn.example/notes.pdf"], password: "pw" },
      { source: "https://forum.example/t/1", now: 5, newId: ids },
    );
    expect(pkgs.map((p) => ({ name: p.name, passwords: p.passwords, links: p.links.map((l) => `${l.filename}:${l.kind}:${l.part ?? ""}`) }))).toEqual([
      { name: "Movie", passwords: ["pw"], links: ["Movie.part1.rar:archive-part:1", "Movie.part2.rar:archive-part:2"] },
      { name: "notes", passwords: ["pw"], links: ["notes.pdf:file:"] },
    ]);
  });

  it("puts every link in one package when the agent names it", () => {
    const pkgs = agentPackages({ links: ["https://a.example/a.zip", "https://b.example/dl?id=7"], packageName: "Course" }, { source: "x", now: 1, newId: ids });
    expect(pkgs).toHaveLength(1);
    expect(pkgs[0]).toMatchObject({ name: "Course", passwords: [] });
    expect(pkgs[0]!.links.map((l) => l.kind)).toEqual(["file", "file"]);
  });

  it("describes the files for an approval", () => {
    expect(describeAgentLinks(["https://a.example/x/Movie.part1.rar", "https://b.example/"])).toBe("Movie.part1.rar (a.example)\n/ (b.example)");
    expect(describeAgentLinks(Array.from({ length: 14 }, (_, i) => `https://a.example/${i}.zip`)).split("\n").at(-1)).toBe("and 2 more");
  });
});

describe("the queue_downloads gate", () => {
  it("always asks, naming the files and the package", () => {
    const risk = classifyAction("queue_downloads", { links: ["https://a.example/Movie.part1.rar", "https://a.example/Movie.part2.rar"], packageName: "Movie" });
    expect(risk).toMatchObject({ risky: true, alwaysAsk: true, handoff: false });
    expect(risk.reason).toBe('Downloads 2 files into "Movie" with the download queue: Movie.part1.rar, Movie.part2.rar.');
    expect(summarizeArgs("queue_downloads", { links: ["a", "b", "c"], packageName: "Movie" })).toBe('3 files as "Movie"');
  });
});

describe("Download with AI task", () => {
  it("says what to download, with the known password, within the Command Bar's limit", () => {
    expect(downloadAiTask({ pageUrl: "https://forum.example/t/1" })).toBe(
      "Download the files offered on https://forum.example/t/1. Find each file's real download link (through file-host pages and mirrors) and queue them with queue_downloads.",
    );
    const task = downloadAiTask({ packageName: "Movie", links: ["https://mega.nz/file/a", "https://rapidgator.net/file/b"], passwords: ["pw"] });
    expect(task.split("\n")).toEqual([
      'Download "Movie". Find each file\'s real download link (through file-host pages and mirrors) and queue them with queue_downloads. Archive password: pw.',
      "Links:",
      "https://mega.nz/file/a",
      "https://rapidgator.net/file/b",
    ]);
    const long = downloadAiTask({ links: Array.from({ length: 100 }, (_, i) => `https://hoster.example/file/${"x".repeat(40)}${i}`) });
    expect(long.length).toBeLessThanOrEqual(2000);
    expect(downloadAiTask({ text: "Mirror: https://a.example/x.rar pass: y" })).toContain("Copied text:\nMirror: https://a.example/x.rar pass: y");
  });
});
