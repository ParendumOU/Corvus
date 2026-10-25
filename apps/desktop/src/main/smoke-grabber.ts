import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import zlib from "node:zlib";
import type { AddressInfo } from "node:net";
import { clipboard, type WebContents } from "electron";
import type { AppContext } from "./context";
import type { BrowserWindowCtl } from "./window";

interface GrabberSmokeHelpers {
  win: BrowserWindowCtl;
  check: (name: string, ok: boolean, detail?: unknown) => void;
  capture: (name: string, wc: WebContents) => Promise<void>;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const BIG = Buffer.from(Array.from({ length: 1536 * 1024 }, (_, i) => (i * 31 + 7) % 251));
const LARGE = Buffer.alloc(20 * 1024 * 1024);
for (let i = 0; i < LARGE.length; i += 4) LARGE.writeUInt32LE((i * 2654435761) >>> 0, i);
const CHECK_PART = (n: string): Buffer => Buffer.from(`checksum smoke part ${n}\n`.repeat(100));
const crc = (b: Buffer): string => (zlib.crc32(b) >>> 0).toString(16).padStart(8, "0");
/** Archives the unit tests use too (smoke.sh runs from apps/desktop). */
const ARCHIVES = path.resolve(process.cwd(), "test/fixtures/archives");
const PAYLOAD_SHA256 = "3649d9bfc363a45a7f5834cdbf4fcfb2729d0f05df0e67631eeb76d1ff397cb1";
const sha256 = (file: string): string => (fs.existsSync(file) ? crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex") : "");

async function waitFor<T>(fn: () => T | undefined | null | false, timeoutMs = 10_000): Promise<T | undefined> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const value = fn();
    if (value) return value;
    await sleep(150);
  }
  return undefined;
}

async function poll(wc: WebContents, expr: string, timeoutMs = 8000): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if ((await wc.executeJavaScript(`Boolean(${expr})`).catch(() => false)) === true) return true;
    await sleep(120);
  }
  return false;
}

/**
 * Link grabber: the download links of a forum-like page grouped into packages (the volumes of a
 * split archive in order, its password found next to the links, ordinary links left out), copied
 * links offered in a toolbar chip, and a package downloaded part by part. Pages and files come
 * from a local server.
 */
export async function runGrabberSmoke(ctx: AppContext, h: GrabberSmokeHelpers): Promise<void> {
  const { win, check, capture } = h;
  const profile = win.profile;
  const ranges: string[] = [];
  const segRanges: string[] = [];
  const server = http.createServer((req, res) => {
    const route = (req.url ?? "/").split("?")[0] ?? "/";
    if (route === "/seg/Large.bin") {
      // 20 MB served by byte range ("bytes=a-" or "bytes=a-b"), throttled so a pause lands mid-way.
      const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? "");
      if (m) segRanges.push(req.headers.range!);
      const start = m ? Number(m[1]) : 0;
      const end = m && m[2] ? Number(m[2]) : LARGE.length - 1;
      const body = LARGE.subarray(start, end + 1);
      res.writeHead(m ? 206 : 200, {
        "Content-Type": "application/octet-stream",
        "Content-Length": String(body.length),
        "Accept-Ranges": "bytes",
        ...(m ? { "Content-Range": `bytes ${start}-${end}/${LARGE.length}` } : {}),
      });
      let offset = 0;
      const timer = setInterval(() => {
        if (res.destroyed || offset >= body.length) {
          clearInterval(timer);
          if (!res.destroyed) res.end();
          return;
        }
        res.write(body.subarray(offset, offset + 128 * 1024));
        offset += 128 * 1024;
      }, 20);
      req.on("close", () => clearInterval(timer));
      return;
    }
    if (route === "/check/Check.sfv") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      // The second part's checksum is wrong on purpose.
      res.end(`Check.part1.rar ${crc(CHECK_PART("1"))}\nCheck.part2.rar 00000000\n`);
      return;
    }
    if (route.startsWith("/rar/") || route.startsWith("/locked/")) {
      // The volumes of a password-protected RAR5 (test/fixtures/archives), under either name.
      const volume = /part(\d)\.rar$/.exec(route)?.[1];
      res.writeHead(200, { "Content-Type": "application/octet-stream" });
      res.end(fs.readFileSync(path.join(ARCHIVES, `Secret.part${volume}.rar`)));
      return;
    }
    if (route.startsWith("/check/")) {
      res.writeHead(200, { "Content-Type": "application/octet-stream" });
      res.end(CHECK_PART(route.slice(-5, -4)));
      return;
    }
    if (route === "/slow/Big.bin") {
      // 1.5 MB in small slices, honouring "Range: bytes=N-" so a paused download resumes.
      const start = Number(/bytes=(\d+)-/.exec(req.headers.range ?? "")?.[1] ?? 0);
      if (req.headers.range) ranges.push(req.headers.range);
      const body = BIG.subarray(start);
      res.writeHead(start > 0 ? 206 : 200, {
        "Content-Type": "application/octet-stream",
        "Content-Length": String(body.length),
        "Accept-Ranges": "bytes",
        ...(start > 0 ? { "Content-Range": `bytes ${start}-${BIG.length - 1}/${BIG.length}` } : {}),
      });
      let offset = 0;
      const timer = setInterval(() => {
        if (res.destroyed || offset >= body.length) {
          clearInterval(timer);
          if (!res.destroyed) res.end();
          return;
        }
        res.write(body.subarray(offset, offset + 32 * 1024));
        offset += 32 * 1024;
      }, 40);
      req.on("close", () => clearInterval(timer));
      return;
    }
    if (route === "/grab") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<!doctype html><title>Release thread</title><body>
        <p>Three parts, extract with the password below.</p>
        <a href="/files/Archive.part2.rar">Part 2</a> <a href="/files/Archive.part1.rar">Part 1</a> <a href="/files/Archive.part3.rar">Part 3</a>
        <a href="/files/manual.pdf">Manual</a> <a href="https://mega.nz/file/smokeId#key">Mirror</a> <a href="/about">About us</a>
        <p>Password: smoke-pass</p></body>`);
      return;
    }
    if (route.startsWith("/files/")) {
      res.writeHead(200, { "Content-Type": "application/octet-stream" });
      res.end(`corvus grabber smoke ${route}\n`);
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  ctx.grabber.clear(profile);

  try {
    // ------------------------------------------------------------------ grab a page
    const page = win.createTab(`${base}/grab`);
    await poll(page.view.webContents, "document.readyState === 'complete' && document.querySelector('a')");
    await ctx.grabber.grabTab(win, page.id);
    const pkgs = ctx.grabber.list(profile);
    const archive = pkgs.find((p) => p.name === "Archive");
    check(
      "link grabber: a page's download links grouped into packages, parts in order, password found",
      archive?.links.map((l) => l.filename).join() === "Archive.part1.rar,Archive.part2.rar,Archive.part3.rar" &&
        archive.passwords.join() === "smoke-pass" &&
        pkgs.some((p) => p.name === "manual") &&
        pkgs.some((p) => p.name === "Links from mega.nz") &&
        !pkgs.some((p) => p.links.some((l) => l.url.endsWith("/about"))),
      pkgs.map((p) => `${p.name}: ${p.links.map((l) => l.filename || l.url).join(" | ")} [${p.passwords.join()}]`),
    );

    const grabber = win.createTab("corvus://downloads/#grabber");
    const shown = await poll(grabber.view.webContents, "document.querySelectorAll('.grab-package').length >= 3 && document.body.innerText.includes('Password: smoke-pass')");
    check("link grabber: corvus://downloads shows the packages", shown);
    await capture("link-grabber", grabber.view.webContents);

    // ------------------------------------------------------------------ copied links
    ctx.settings.update({ downloads: { watchClipboard: true } });
    clipboard.writeText("nothing yet");
    await ctx.grabber.pollClipboard();
    clipboard.writeText(`Mirror (2 parts): ${base}/files/Other.7z.001 ${base}/files/Other.7z.002 — pass: other-pw`);
    await ctx.grabber.pollClipboard();
    const chip = await poll(win.chrome.webContents, "(document.querySelector('.copied-links-chip')?.textContent ?? '').includes('2 links')");
    check("link grabber: copied download links show up as a toolbar chip", ctx.grabber.copiedLinks() === 2 && chip);
    await capture("copied-links-chip", win.chrome.webContents);
    await win.chrome.webContents.executeJavaScript("document.querySelector('.copied-links-main')?.click()");
    const other = await waitFor(() => ctx.grabber.list(profile).find((p) => p.name === "Other"));
    check(
      "link grabber: the chip puts the copied links in the grabber",
      other?.links.map((l) => l.part).join() === "1,2" && other.passwords.join() === "other-pw" && ctx.grabber.copiedLinks() === 0,
      other,
    );
    ctx.settings.update({ downloads: { watchClipboard: false } });

    // ------------------------------------------------------------------ download a package (queue)
    const started = archive ? ctx.grabber.download(win, [archive.id]) : 0;
    const queued = () => ctx.queue.list(profile).packages.find((p) => p.name === "Archive");
    const done = await waitFor(() => (queued()?.items.every((i) => i.state === "done") ? queued() : undefined), 15_000);
    const contents = done?.items.map((i) => (i.savePath && fs.existsSync(i.savePath) ? fs.readFileSync(i.savePath, "utf8") : null)) ?? [];
    check(
      "download queue: a grabbed package downloads every part into its own folder and leaves the grabber",
      started === 3 &&
        done?.dir.endsWith(`${path.sep}Archive`) === true &&
        contents.join("") === ["1", "2", "3"].map((n) => `corvus grabber smoke /files/Archive.part${n}.rar\n`).join("") &&
        !ctx.grabber.list(profile).some((p) => p.name === "Archive"),
      { started, files: done?.items.map((i) => i.savePath) },
    );
    await grabber.view.webContents.executeJavaScript("location.hash = ''");
    const queueShown = await poll(grabber.view.webContents, "(document.querySelector('[data-queue-package=\"Archive\"]')?.innerText ?? '').includes('3 of 3 files')");
    check("download queue: corvus://downloads shows the package", queueShown);

    // ------------------------------------------------------------------ pause and resume (byte ranges)
    ctx.grabber.addText(profile, `${base}/slow/Big.bin`);
    const big = ctx.grabber.list(profile).find((p) => p.name === "Big");
    if (big) ctx.grabber.download(win, [big.id]);
    const bigPkg = () => ctx.queue.list(profile).packages.find((p) => p.name === "Big");
    await waitFor(() => (bigPkg()?.items[0]?.receivedBytes ?? 0) > 100_000);
    await capture("download-queue", grabber.view.webContents);
    if (big) ctx.queue.act(profile, big.id, "pause");
    await sleep(500);
    const pausedItem = bigPkg()?.items[0];
    const partSize = pausedItem?.savePath && fs.existsSync(`${pausedItem.savePath}.part`) ? fs.statSync(`${pausedItem.savePath}.part`).size : 0;
    if (big) ctx.queue.act(profile, big.id, "resume");
    const bigDone = await waitFor(() => (bigPkg()?.items[0]?.state === "done" ? bigPkg()?.items[0] : undefined), 20_000);
    const same = bigDone?.savePath ? fs.readFileSync(bigDone.savePath).equals(BIG) : false;
    check(
      "download queue: a paused download resumes where it stopped (byte range) and the file is intact",
      pausedItem?.state === "paused" && partSize > 0 && partSize < BIG.length && ranges.some((r) => r === `bytes=${partSize}-`) && same,
      { paused: pausedItem?.state, partSize, ranges, same },
    );

    // ------------------------------------------------------------------ parallel segments
    ctx.grabber.addText(profile, `${base}/seg/Large.bin`);
    const large = ctx.grabber.list(profile).find((p) => p.name === "Large");
    if (large) ctx.grabber.download(win, [large.id]);
    const largeItem = () => ctx.queue.list(profile).packages.find((p) => p.name === "Large")?.items[0];
    await waitFor(() => (largeItem()?.receivedBytes ?? 0) > 4 * 1024 * 1024, 15_000);
    if (large) ctx.queue.act(profile, large.id, "pause");
    await sleep(400);
    const pausedSegments = largeItem()?.segments?.map((s) => s.received) ?? [];
    const before = segRanges.length;
    if (large) ctx.queue.act(profile, large.id, "resume");
    const largeDone = await waitFor(() => (largeItem()?.state === "done" ? largeItem() : undefined), 30_000);
    const intact = largeDone?.savePath ? fs.readFileSync(largeDone.savePath).equals(LARGE) : false;
    const resumedFrom = segRanges.slice(before);
    check(
      "download queue: a large file comes in parallel byte ranges, pauses and resumes each range, and is intact",
      pausedSegments.length === 2 &&
        pausedSegments.every((r) => r > 0) &&
        segRanges.some((r) => /^bytes=\d+-\d+$/.test(r)) &&
        resumedFrom.length === 2 &&
        resumedFrom.every((r) => !/^bytes=(0|10485760)-/.test(r)) &&
        intact,
      { pausedSegments, segRanges, intact },
    );

    // ------------------------------------------------------------------ checksums
    ctx.grabber.addText(profile, ["1", "2"].map((n) => `${base}/check/Check.part${n}.rar`).join(" ") + ` ${base}/check/Check.sfv`);
    const checkPkg = ctx.grabber.list(profile).find((p) => p.name === "Check");
    if (checkPkg) ctx.grabber.download(win, [checkPkg.id]);
    const checked = await waitFor(() => {
      const p = ctx.queue.list(profile).packages.find((x) => x.name === "Check");
      return p?.items.some((i) => i.checked === "mismatch") ? p : undefined;
    }, 15_000);
    const byName = new Map(checked?.items.map((i) => [i.filename, i]) ?? []);
    check(
      "download queue: files are checked against the package's .sfv; a mismatch fails the file",
      byName.get("Check.part1.rar")?.checked === "ok" && byName.get("Check.part2.rar")?.state === "failed" && /Checksum mismatch/.test(byName.get("Check.part2.rar")?.error ?? ""),
      checked?.items.map((i) => `${i.filename}: ${i.state} ${i.checked ?? ""} ${i.error ?? ""}`),
    );

    // ------------------------------------------------------------------ extraction
    ctx.settings.update({ downloads: { extractArchives: true, deleteArchives: true, archivePasswords: [] } });
    ctx.grabber.addText(profile, `${base}/rar/Secret.part1.rar ${base}/rar/Secret.part2.rar Password: corvus-rar`);
    const secret = ctx.grabber.list(profile).find((p) => p.name === "Secret");
    if (secret) ctx.grabber.download(win, [secret.id]);
    const secretPkg = () => ctx.queue.list(profile).packages.find((p) => p.name === "Secret");
    const extracted = await waitFor(() => (secretPkg()?.extraction && secretPkg()?.extraction?.state !== "running" ? secretPkg() : undefined), 30_000);
    check(
      "download queue: a finished package's multi-part RAR is extracted with the password next to its links, then deleted",
      extracted?.extraction?.state === "done" &&
        extracted.extraction.password === "corvus-rar" &&
        sha256(path.join(extracted.dir, "payload.bin")) === PAYLOAD_SHA256 &&
        !fs.existsSync(path.join(extracted.dir, "Secret.part1.rar")) &&
        !fs.existsSync(path.join(extracted.dir, "Secret.part2.rar")),
      extracted?.extraction,
    );

    ctx.settings.update({ downloads: { deleteArchives: false } });
    ctx.grabber.addText(profile, `${base}/locked/Locked.part1.rar ${base}/locked/Locked.part2.rar`);
    const locked = ctx.grabber.list(profile).find((p) => p.name === "Locked");
    if (locked) ctx.grabber.download(win, [locked.id]);
    const lockedPkg = () => ctx.queue.list(profile).packages.find((p) => p.name === "Locked");
    const asks = await waitFor(() => (lockedPkg()?.extraction?.state === "password" ? lockedPkg() : undefined), 30_000);
    const asksShown = await poll(grabber.view.webContents, "document.querySelector('[data-queue-package=\"Locked\"] [data-queue-extraction=\"password\"] input') !== null");
    await capture("download-queue-password", grabber.view.webContents);
    if (asks) ctx.queue.extract(profile, asks.id, "corvus-rar");
    const opened = await waitFor(() => (lockedPkg()?.extraction?.state === "done" ? lockedPkg() : undefined), 30_000);
    check(
      "download queue: an archive no known password opens asks for one, extracts with the typed one and saves it",
      asks !== undefined &&
        asksShown &&
        opened?.extraction?.password === "corvus-rar" &&
        sha256(path.join(opened.dir, "payload.bin")) === PAYLOAD_SHA256 &&
        fs.existsSync(path.join(opened.dir, "Locked.part1.rar")) &&
        ctx.settings.get().downloads.archivePasswords.includes("corvus-rar"),
      { asks: asks?.extraction, asksShown, opened: opened?.extraction, saved: ctx.settings.get().downloads.archivePasswords },
    );
    ctx.settings.update({ downloads: { deleteArchives: false, archivePasswords: [] } });

    for (const p of ctx.queue.list(profile).packages) ctx.queue.act(profile, p.id, "remove");
    win.closeTab(grabber.id);
    win.closeTab(page.id);
  } finally {
    ctx.settings.update({ downloads: { watchClipboard: false, deleteArchives: false, archivePasswords: [] } });
    ctx.grabber.clear(profile);
    server.close();
  }
}
