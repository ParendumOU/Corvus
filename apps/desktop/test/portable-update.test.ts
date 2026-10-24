import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PortableUpdater, portableExecutable } from "../src/main/portable-updater";
import {
  compareVersions,
  fromGitHubRelease,
  pickPortableUpdate,
  sha256For,
  swapScript,
  updatedFileName,
  type ReleaseInfo,
} from "../src/shared/portable-update";

const release = (version: string, extra: Partial<ReleaseInfo> = {}, withExe = true): ReleaseInfo => ({
  version,
  prerelease: version.includes("-"),
  draft: false,
  notes: `notes ${version}`,
  assets: [
    ...(withExe ? [{ name: `Corvus-Portable-${version}.exe`, url: `https://dl.example/v${version}/Corvus-Portable-${version}.exe` }] : []),
    { name: `Corvus-Setup-${version}.exe`, url: `https://dl.example/v${version}/Corvus-Setup-${version}.exe` },
    { name: "SHA256SUMS.txt", url: `https://dl.example/v${version}/SHA256SUMS.txt` },
  ],
  ...extra,
});

describe("portable update rules", () => {
  it("orders versions like semver", () => {
    expect(compareVersions("0.4.10", "0.4.9")).toBe(1);
    expect(compareVersions("v0.5.0", "0.4.12")).toBe(1);
    expect(compareVersions("0.5.0", "0.5.0-beta.3")).toBe(1);
    expect(compareVersions("0.5.0-beta.10", "0.5.0-beta.9")).toBe(1);
    expect(compareVersions("0.4.2", "0.4.2")).toBe(0);
    expect(compareVersions("0.4.1", "0.4.2")).toBe(-1);
  });

  it("offers the newest release of the channel that ships a portable build", () => {
    const releases = [release("0.4.2"), release("0.5.0-beta.1"), release("0.4.3", {}, false), release("0.4.9", { draft: true }), release("0.4.1")];
    expect(pickPortableUpdate(releases, "stable", "0.4.1")?.version).toBe("0.4.2");
    expect(pickPortableUpdate(releases, "beta", "0.4.1")?.version).toBe("0.5.0-beta.1");
    expect(pickPortableUpdate(releases, "stable", "0.4.2")).toBeNull();
    // A beta build that switches to stable goes to the newest stable release, even an older one.
    expect(pickPortableUpdate(releases, "stable", "0.5.0-beta.1")?.version).toBe("0.4.2");
    const offer = pickPortableUpdate(releases, "stable", "0.4.1");
    expect(offer?.exe.name).toBe("Corvus-Portable-0.4.2.exe");
    expect(offer?.sums.url).toBe("https://dl.example/v0.4.2/SHA256SUMS.txt");
  });

  it("reads GitHub's release JSON", () => {
    const r = fromGitHubRelease({
      tag_name: "v0.4.2",
      prerelease: false,
      draft: false,
      body: " Keeps YouTube playing. ",
      assets: [{ name: "SHA256SUMS.txt", browser_download_url: "https://github.com/x/SHA256SUMS.txt" }, { name: 7 }],
    });
    expect(r).toEqual({ version: "0.4.2", prerelease: false, draft: false, notes: "Keeps YouTube playing.", assets: [{ name: "SHA256SUMS.txt", url: "https://github.com/x/SHA256SUMS.txt" }] });
    expect(fromGitHubRelease({ name: "no tag" })).toBeNull();
  });

  it("finds a file's checksum in both sha256sum formats", () => {
    const sums = `6c2c4254${"0".repeat(56)} *Corvus-0.4.2-x86_64.AppImage\r\nAFDF827D${"1".repeat(56)}  Corvus-Portable-0.4.2.exe\n`;
    expect(sha256For(sums, "Corvus-Portable-0.4.2.exe")).toBe(`afdf827d${"1".repeat(56)}`);
    expect(sha256For(sums, "Corvus-0.4.2-x86_64.AppImage")).toBe(`6c2c4254${"0".repeat(56)}`);
    expect(sha256For(sums, "Corvus-Setup-0.4.2.exe")).toBeNull();
  });

  it("names the updated copy after its release unless the person renamed it", () => {
    expect(updatedFileName("Corvus-Portable-0.4.1.exe", "0.4.2")).toBe("Corvus-Portable-0.4.2.exe");
    expect(updatedFileName("corvus-portable-0.4.1.exe", "0.5.0-beta.1")).toBe("Corvus-Portable-0.5.0-beta.1.exe");
    expect(updatedFileName("Corvus.exe", "0.4.2")).toBe("Corvus.exe");
  });

  it("writes a swap script that waits for Corvus, keeps the old copy on failure and refuses unsafe paths", () => {
    const script = swapScript(
      {
        current: "C:\\Program Files (x86)\\Corvus\\Corvus-Portable-0.4.1.exe",
        download: "C:\\Program Files (x86)\\Corvus\\Corvus-Portable-0.4.2.exe.download",
        target: "C:\\Program Files (x86)\\Corvus\\Corvus-Portable-0.4.2.exe",
      },
      4321,
    );
    expect(script).toContain("setlocal EnableDelayedExpansion");
    expect(script).toContain('set "CURRENT=C:\\Program Files (x86)\\Corvus\\Corvus-Portable-0.4.1.exe"');
    expect(script).toContain('tasklist /fi "PID eq 4321" 2>nul | find "4321" >nul || goto replace');
    expect(script).toContain('move /y "!CURRENT!.old" "!CURRENT!" >nul 2>&1');
    // Paths only ever appear through delayed expansion inside ( ... ) blocks.
    expect(script.split("\r\n").filter((l) => l.startsWith("  ")).some((l) => l.includes("%CURRENT%") || l.includes("%TARGET%"))).toBe(false);
    for (const bad of ["C:\\a\\100%\\x.exe", 'C:\\a\\"x.exe', "relative\\x.exe", "C:\\a\\x!.exe", "C:\\a&b\\x.exe"]) {
      expect(() => swapScript({ current: bad, download: "C:\\d.download", target: "C:\\t.exe" }, 1)).toThrow(/Cannot update/);
    }
    expect(() => swapScript({ current: "C:\\c.exe", download: "C:\\d.download", target: "C:\\t.exe" }, 0)).toThrow(/process id/);
  });

  it("knows the portable build by the launcher's variable, on Windows only", () => {
    expect(portableExecutable({ PORTABLE_EXECUTABLE_FILE: "C:\\x\\Corvus-Portable-0.4.2.exe" }, "win32")).toBe("C:\\x\\Corvus-Portable-0.4.2.exe");
    expect(portableExecutable({ PORTABLE_EXECUTABLE_FILE: "/x" }, "linux")).toBeNull();
    expect(portableExecutable({}, "win32")).toBeNull();
  });
});

describe("PortableUpdater", () => {
  const body = Buffer.alloc(300_000, 7);
  const good = createHash("sha256").update(body).digest("hex");
  let server: http.Server;
  let base = "";
  let dir = "";
  let sums = "";

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      if (req.url?.endsWith("SHA256SUMS.txt")) return void res.end(sums);
      if (req.url?.endsWith(".exe")) {
        res.writeHead(200, { "content-length": String(body.length) });
        return void res.end(body);
      }
      if (req.url?.endsWith("latest.yml")) return void res.end("version: 0.4.9\nfiles:\n  - url: Corvus-Setup-0.4.9.exe\n");
      res.writeHead(404).end();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "portable-"));
  });
  afterAll(() => {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("checks a self-hosted feed, downloads next to the copy and verifies the checksum", async () => {
    const updater = new PortableUpdater(path.join(dir, "Corvus-Portable-0.4.1.exe"));
    const offer = await updater.check("stable", "0.4.1", base);
    expect(offer?.version).toBe("0.4.9");
    sums = `${good} *Corvus-Portable-0.4.9.exe\n`;
    const progress: number[] = [];
    const file = await updater.download(offer!, (p) => progress.push(p));
    expect(file).toBe(path.join(dir, "Corvus-Portable-0.4.9.exe.download"));
    expect(fs.readFileSync(file).equals(body)).toBe(true);
    expect(progress.at(-1)).toBe(100);
  });

  it("deletes a download that does not match its checksum", async () => {
    const updater = new PortableUpdater(path.join(dir, "Corvus-Portable-0.4.1.exe"));
    const offer = (await updater.check("stable", "0.4.1", base))!;
    sums = `${"0".repeat(64)} *Corvus-Portable-0.4.9.exe\n`;
    fs.rmSync(updater.downloadPath(offer), { force: true });
    await expect(updater.download(offer, () => undefined)).rejects.toThrow(/does not match/);
    expect(fs.existsSync(updater.downloadPath(offer))).toBe(false);
  });

  it("reads GitHub releases when no feed is set", async () => {
    const calls: string[] = [];
    const updater = new PortableUpdater("C:\\x\\Corvus-Portable-0.4.1.exe", async (url) => {
      calls.push(url);
      return new Response(JSON.stringify([{ tag_name: "v0.4.2", prerelease: false, draft: false, assets: release("0.4.2").assets.map((a) => ({ name: a.name, browser_download_url: a.url })) }]));
    });
    expect((await updater.check("stable", "0.4.1", ""))?.version).toBe("0.4.2");
    expect(calls).toEqual(["https://api.github.com/repos/ParendumOU/Corvus/releases?per_page=20"]);
  });
});
