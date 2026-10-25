import crypto from "node:crypto";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveLink, pageDownloadLink } from "../src/main/hosters";
import { anchors, forms, metaRefresh, parseSize, waitSeconds } from "../src/main/hosters/html";
import { megaDecryptor, megaFileCipher, parseMegaLink } from "../src/main/hosters/mega";
import { driveConfirmLink, mediafireLink } from "../src/main/hosters/sites";
import type { FetchInit, HosterNet, Resolution } from "../src/main/hosters/types";
import { xfsCountdown } from "../src/main/hosters/xfs";
import {
  applyQueueAction,
  expandFolder,
  nextToStart,
  nextWake,
  queueFromGrabbed,
  reviveQueue,
  safeFileName,
  wakeWaiting,
  type QueueItem,
  type QueuePackage,
} from "../src/shared/download-queue";
import { hosterFor, isHosterDownloadLink, knownHosterDomains } from "../src/shared/hosters";
import { buildPackages, classifyLink, filenameOf } from "../src/shared/link-grabber";

interface Route {
  status?: number;
  /** Final address (after redirects). */
  url?: string;
  body?: unknown;
  headers?: Record<string, string>;
  file?: boolean;
}
type Handler = Route | ((init: FetchInit, url: string) => Route);

/** A file host on paper: answers by "METHOD address" (or an address prefix), records what was asked. */
function fakeNet(routes: Record<string, Handler>) {
  const calls: Array<{ url: string; init: FetchInit }> = [];
  const slept: number[] = [];
  const cookies = new Map<string, string>();
  const net: HosterNet = {
    async fetch(url, init = {}) {
      calls.push({ url, init });
      const method = init.method ?? "GET";
      const key = Object.keys(routes).find((k) => k === `${method} ${url}` || k === url) ?? Object.keys(routes).find((k) => `${method} ${url}`.startsWith(k));
      if (!key) throw new Error(`unexpected ${method} ${url}`);
      const handler = routes[key]!;
      const r = typeof handler === "function" ? handler(init, url) : handler;
      const text = typeof r.body === "string" ? r.body : JSON.stringify(r.body ?? "");
      return {
        status: r.status ?? 200,
        url: r.url ?? url,
        header: (name: string) => r.headers?.[name.toLowerCase()] ?? null,
        isFile: r.file === true,
        text: async () => text,
        json: async () => JSON.parse(text) as unknown,
        cancel: async () => undefined,
      };
    },
    cookie: async (_url, name) => cookies.get(name) ?? null,
    setCookie: async (_url, name, value) => void cookies.set(name, value),
    sleep: async (ms) => void slept.push(ms),
  };
  return { net, calls, slept, cookies };
}

const page = (body: string, extra: Partial<Route> = {}): Route => ({ body, headers: { "content-type": "text/html" }, ...extra });

describe("hoster catalog", () => {
  it("knows the file hosts and which of their addresses are files or folders", () => {
    expect(hosterFor("https://mega.nz/file/AbCdEfGh#key")).toEqual({ id: "mega", name: "MEGA", slots: 2 });
    expect(hosterFor("https://www.mediafire.com/file/abc/x.zip/file")?.name).toBe("MediaFire");
    expect(hosterFor("https://katfile.com/abc/x.rar.html")).toEqual({ id: "xfs", name: "Katfile", slots: 1 });
    expect(hosterFor("https://rapidgator.net/file/abc")).toEqual({ id: "captcha", name: "Rapidgator", slots: 1 });
    expect(hosterFor("https://filecrypt.cc/Container/X.html")?.id).toBe("protector");
    expect(hosterFor("https://alterupload.com/?abc")?.id).toBe("1fichier");
    expect(hosterFor("https://news.example/")).toBeNull();
    expect(isHosterDownloadLink("https://mega.nz/")).toBe(false);
    expect(isHosterDownloadLink("https://mega.nz/#!AbCdEfGh!" + "k".repeat(43))).toBe(true);
    expect(isHosterDownloadLink("https://www.mediafire.com/folder/abc123/Stuff")).toBe(true);
    expect(isHosterDownloadLink("https://1fichier.com/?a1b2c3d4e5")).toBe(true);
    expect(isHosterDownloadLink("https://drive.google.com/drive/folders/1AbCdEfGhIjK")).toBe(true);
    expect(knownHosterDomains().length).toBeGreaterThan(60);
  });

  it("treats a hoster page named like an archive part as a page, and a host's own file link as a file", () => {
    expect(classifyLink("https://rapidgator.net/file/abc123/Movie.part1.rar.html")).toBe("hoster");
    expect(classifyLink("https://download1234.mediafire.com/xyz/abc/Movie.part1.rar")).toBe("archive-part");
    expect(classifyLink("https://mega.nz/")).toBeNull();
    expect(filenameOf("https://www.mediafire.com/file/abc123/Show.S01.part2.rar/file")).toBe("Show.S01.part2.rar");
    const [pkg] = buildPackages(["https://www.mediafire.com/file/a/Set.part1.rar/file", "https://www.mediafire.com/file/b/Set.part2.rar/file"], { source: "s", now: 1, newId: () => crypto.randomUUID() });
    expect(pkg!.links.map((l) => [l.kind, l.part])).toEqual([
      ["hoster", 1],
      ["hoster", 2],
    ]);
  });

  it("keeps any page the person picks by hand", () => {
    expect(buildPackages(["https://blog.example/post/42"], { source: "s", now: 1, newId: () => "x" })).toEqual([]);
    const [pkg] = buildPackages(["https://blog.example/post/42"], { source: "s", now: 1, newId: () => "x", all: true });
    expect(pkg!.links[0]).toMatchObject({ kind: "hoster", url: "https://blog.example/post/42" });
  });
});

describe("reading hoster pages", () => {
  it("finds forms, links, refreshes, waits and sizes", () => {
    const html = `<form method="POST" action="/go"><input type="hidden" name="op" value="download1"><input type="hidden" name="id" value="abc">
      <input type="submit" name="method_free" value="Free Download"><input type="checkbox" name="x"></form>
      <a href="/d/abcdef123456/file.zip" class="btn">Download &amp; enjoy</a>
      <meta http-equiv="refresh" content="5; url=https://dl.example/f.zip">`;
    expect(forms(html, "https://h.example/abc")).toEqual([
      expect.objectContaining({ action: "https://h.example/go", method: "POST", fields: { op: "download1", id: "abc", method_free: "Free Download" } }),
    ]);
    expect(anchors(html, "https://h.example/abc")[0]).toMatchObject({ href: "https://h.example/d/abcdef123456/file.zip", text: "Download & enjoy" });
    expect(metaRefresh(html, "https://h.example/")).toBe("https://dl.example/f.zip");
    expect(waitSeconds("You must wait 16 minutes between downloads")).toBe(960);
    expect(waitSeconds("Vous devez attendre encore 3 minutes")).toBe(180);
    expect(waitSeconds("nothing here")).toBeNull();
    expect(parseSize("Download (1.5 GB)")).toBe(Math.round(1.5 * 1024 ** 3));
    expect(xfsCountdown(`<span id="countdown"><span class="seconds">30</span></span>`)).toBe(30);
  });

  it("picks the one download link of an ordinary page", () => {
    expect(pageDownloadLink(`<a href="/about">About</a><a href="/files/tool.zip">Download</a>`, "https://s.example/p")).toBe("https://s.example/files/tool.zip");
    expect(pageDownloadLink(`<a href="/a.zip">a</a><a href="/b.zip">b</a>`, "https://s.example/p")).toBeNull();
    expect(pageDownloadLink(`<a href="/a.zip">a</a><a href="/b.zip" download>Download</a>`, "https://s.example/p")).toBe("https://s.example/b.zip");
  });
});

describe("MEGA", () => {
  const fileKey = crypto.randomBytes(32);
  const keyText = fileKey.toString("base64url");
  const cipher = megaFileCipher(fileKey);

  /** Encrypts node attributes as MEGA does. */
  const attrs = (json: object, aes: Buffer): string => {
    const text = Buffer.from(`MEGA${JSON.stringify(json)}`);
    const padded = Buffer.concat([text, Buffer.alloc((16 - (text.length % 16)) % 16)]);
    const c = crypto.createCipheriv("aes-128-cbc", aes, Buffer.alloc(16));
    c.setAutoPadding(false);
    return Buffer.concat([c.update(padded), c.final()]).toString("base64url");
  };

  it("reads every link form", () => {
    expect(parseMegaLink(`https://mega.nz/file/AbCdEfGh#${keyText}`)).toEqual({ kind: "file", handle: "AbCdEfGh", key: keyText });
    expect(parseMegaLink(`https://mega.nz/#!AbCdEfGh!${keyText}`)).toEqual({ kind: "file", handle: "AbCdEfGh", key: keyText });
    const folderKey = crypto.randomBytes(16).toString("base64url");
    expect(parseMegaLink(`https://mega.nz/folder/FoLdEr12#${folderKey}`)).toEqual({ kind: "folder", handle: "FoLdEr12", key: folderKey });
    expect(parseMegaLink(`https://mega.nz/folder/FoLdEr12#${folderKey}/file/NoDe1234`)).toEqual({ kind: "folder", handle: "FoLdEr12", key: folderKey, node: "NoDe1234" });
    expect(parseMegaLink(`https://mega.nz/#F!FoLdEr12!${folderKey}`)).toMatchObject({ kind: "folder", handle: "FoLdEr12" });
    expect(parseMegaLink("https://mega.nz/file/AbCdEfGh")).toBeNull();
  });

  it("decrypts any part of a file on its own", () => {
    const plain = crypto.randomBytes(100_000);
    const iv = Buffer.from(cipher.iv, "hex");
    const c = crypto.createCipheriv("aes-128-ctr", Buffer.from(cipher.key, "hex"), iv);
    const encrypted = Buffer.concat([c.update(plain), c.final()]);
    for (const [start, end] of [
      [0, 100_000],
      [7, 4096],
      [33_333, 70_001],
    ] as const) {
      const decrypt = megaDecryptor(cipher, start);
      // In uneven chunks, as they come off the network.
      const out = Buffer.concat([decrypt(encrypted.subarray(start, start + 5)), decrypt(encrypted.subarray(start + 5, end))]);
      expect(out.equals(plain.subarray(start, end))).toBe(true);
    }
  });

  it("resolves a file link into its address, name, size and key", async () => {
    const { net, calls } = fakeNet({ "POST https://g.api.mega.co.nz/cs": { body: [{ s: 1234, at: attrs({ n: "Holiday.mp4" }, cipher.aes), g: "https://gfs.userstorage.mega.co.nz/dl/xyz" }] } });
    const res = await resolveLink(`https://mega.nz/file/AbCdEfGh#${keyText}`, net);
    expect(res).toEqual({ type: "file", url: "https://gfs.userstorage.mega.co.nz/dl/xyz", filename: "Holiday.mp4", size: 1234, mega: { key: cipher.key, iv: cipher.iv } });
    expect(calls[0]!.init.json).toEqual([{ a: "g", g: 1, ssl: 2, p: "AbCdEfGh" }]);
  });

  it("says when a file is gone or the quota is used up", async () => {
    expect(await resolveLink(`https://mega.nz/file/AbCdEfGh#${keyText}`, fakeNet({ "POST https://g.api.mega.co.nz/cs": { body: [-9] } }).net)).toEqual({ type: "offline", reason: "offline" });
    expect(await resolveLink(`https://mega.nz/file/AbCdEfGh#${keyText}`, fakeNet({ "POST https://g.api.mega.co.nz/cs": { body: [-17] } }).net)).toMatchObject({ type: "wait", reason: "quota" });
    expect(await resolveLink(`https://mega.nz/file/AbCdEfGh#${keyText}`, fakeNet({ "POST https://g.api.mega.co.nz/cs": { status: 402, body: "" } }).net)).toEqual({ type: "attention", reason: "challenge" });
  });

  it("lists a folder's files, then resolves each one", async () => {
    const folderKey = crypto.randomBytes(16);
    const ecb = (data: Buffer): string => {
      const c = crypto.createCipheriv("aes-128-ecb", folderKey, null);
      c.setAutoPadding(false);
      return Buffer.concat([c.update(data), c.final()]).toString("base64url");
    };
    const subKey = crypto.randomBytes(16);
    const nodes = [
      { h: "RoOt0001", p: "", t: 1, a: attrs({ n: "Trip" }, folderKey), k: `RoOt0001:${ecb(folderKey)}` },
      { h: "FiLe0001", p: "RoOt0001", t: 0, s: 10, a: attrs({ n: "a.part1.rar" }, cipher.aes), k: `RoOt0001:${ecb(fileKey)}` },
      { h: "SuBd0001", p: "RoOt0001", t: 1, a: attrs({ n: "More" }, subKey), k: `RoOt0001:${ecb(subKey)}` },
      { h: "FiLe0002", p: "SuBd0001", t: 0, s: 20, a: attrs({ n: "a.part2.rar" }, cipher.aes), k: `RoOt0001:${ecb(fileKey)}` },
    ];
    const handle = "FoLdEr99";
    const link = `https://mega.nz/folder/${handle}#${folderKey.toString("base64url")}`;
    const { net, calls } = fakeNet({
      "POST https://g.api.mega.co.nz/cs": (init) => ((init.json as Array<{ a: string }>)[0]!.a === "f" ? { body: [{ f: nodes }] } : { body: [{ g: "https://gfs.example/n1" }] }),
    });
    const folder = (await resolveLink(link, net)) as Extract<Resolution, { type: "folder" }>;
    expect(folder.type).toBe("folder");
    expect(folder.name).toBe("Trip");
    expect(folder.entries).toEqual([
      { url: `${link}/file/FiLe0001`, filename: "a.part1.rar", size: 10 },
      { url: `${link}/file/FiLe0002`, filename: "a.part2.rar", size: 20 },
    ]);
    expect(calls[0]!.url).toContain(`&n=${handle}`);
    const one = await resolveLink(folder.entries[0]!.url, net);
    expect(one).toMatchObject({ type: "file", url: "https://gfs.example/n1", filename: "a.part1.rar", size: 10, mega: { key: cipher.key } });
    // The folder's listing is kept a while: only the file's address was asked for.
    expect(calls.map((c) => (c.init.json as Array<{ a: string }>)[0]!.a)).toEqual(["f", "g"]);
  });
});

describe("file hosts", () => {
  it("MediaFire: the download button, plain or scrambled, and folders through the API", async () => {
    const direct = "https://download2391.mediafire.com/abc/key/Set.part1.rar";
    expect(mediafireLink(`<a class="input popsok" aria-label="Download file" href="${direct}" id="downloadButton">Download</a>`)).toBe(direct);
    expect(mediafireLink(`<a href="javascript:void(0)" id="downloadButton" data-scrambled-url="${Buffer.from(direct).toString("base64")}">Download</a>`)).toBe(direct);
    const fileUrl = "https://www.mediafire.com/file/key/Set.part1.rar/file";
    const { net } = fakeNet({ [fileUrl]: page(`<div class="filename">Set.part1.rar</div><a id="downloadButton" href="${direct}">Download (1.2MB)</a>`) });
    expect(await resolveLink(fileUrl, net)).toEqual({ type: "file", url: direct, filename: "Set.part1.rar" });
    expect(await resolveLink(fileUrl, fakeNet({ [fileUrl]: page("x", { url: "https://www.mediafire.com/error.php?errno=320" }) }).net)).toEqual({ type: "offline", reason: "offline" });
    expect(await resolveLink(fileUrl, fakeNet({ [fileUrl]: page("<title>MediaFire</title> Invalid or Deleted File") }).net)).toEqual({ type: "offline", reason: "offline" });

    const api = "https://www.mediafire.com/api/1.5/folder";
    const folder = fakeNet({
      [`${api}/get_info.php?folder_key=fold123&response_format=json`]: { body: { response: { folder_info: { name: "Season 1" } } } },
      [`${api}/get_content.php?folder_key=fold123&content_type=files&chunk=1&response_format=json`]: {
        body: { response: { folder_content: { files: [{ quickkey: "q1", filename: "E01.mkv", size: "100" }], more_chunks: "no" } } },
      },
      [`${api}/get_content.php?folder_key=fold123&content_type=folders&response_format=json`]: { body: { response: { folder_content: { folders: [] } } } },
    });
    expect(await resolveLink("https://www.mediafire.com/folder/fold123/Season+1", folder.net)).toEqual({
      type: "folder",
      name: "Season 1",
      entries: [{ url: "https://www.mediafire.com/file/q1/E01.mkv/file", filename: "E01.mkv", size: 100 }],
    });
  });

  it("Pixeldrain: files, lists and its CAPTCHA", async () => {
    const { net } = fakeNet({ "https://pixeldrain.com/api/file/abc123/info": { body: { name: "a.zip", size: 5, availability: "" } } });
    expect(await resolveLink("https://pixeldrain.com/u/abc123", net)).toEqual({ type: "file", url: "https://pixeldrain.com/api/file/abc123?download", filename: "a.zip", size: 5 });
    const captcha = fakeNet({ "https://pixeldrain.com/api/file/abc123/info": { body: { name: "a.zip", availability: "file_rate_limited_captcha_required" } } });
    expect(await resolveLink("https://pixeldrain.com/u/abc123", captcha.net)).toEqual({ type: "attention", reason: "captcha" });
    const list = fakeNet({ "https://pixeldrain.com/api/list/L1": { body: { title: "Pack", files: [{ id: "f1", name: "1.jpg", size: 9 }] } } });
    expect(await resolveLink("https://pixeldrain.com/l/L1", list.net)).toEqual({
      type: "folder",
      name: "Pack",
      entries: [{ url: "https://pixeldrain.com/api/file/f1?download", direct: true, filename: "1.jpg", size: 9 }],
    });
  });

  it("Google Drive: a small file directly, a big one through its warning page", async () => {
    const direct = "https://drive.usercontent.google.com/download?id=1AbCdEfGhIjKlMn&export=download";
    expect(await resolveLink("https://drive.google.com/file/d/1AbCdEfGhIjKlMn/view?usp=sharing", fakeNet({ [direct]: { file: true } }).net)).toEqual({ type: "file", url: direct });
    const warning = `<form id="download-form" action="https://drive.usercontent.google.com/download" method="get">
      <input type="hidden" name="id" value="1AbCdEfGhIjKlMn"><input type="hidden" name="export" value="download"><input type="hidden" name="confirm" value="t"><input type="hidden" name="uuid" value="u-1"></form>
      <span class="uc-name-size"><a href="/open?id=1AbCdEfGhIjKlMn">Big.iso</a> (4.2G)</span>`;
    expect(driveConfirmLink(warning, direct)).toBe("https://drive.usercontent.google.com/download?id=1AbCdEfGhIjKlMn&export=download&confirm=t&uuid=u-1");
    expect(await resolveLink("https://drive.google.com/open?id=1AbCdEfGhIjKlMn", fakeNet({ [direct]: page(warning) }).net)).toMatchObject({ type: "file", filename: "Big.iso" });
    expect(await resolveLink("https://drive.google.com/open?id=1AbCdEfGhIjKlMn", fakeNet({ [direct]: page("Too many users have viewed or downloaded this file recently") }).net)).toMatchObject({ type: "wait", reason: "quota" });
  });

  it("Dropbox: the same link with dl=1", async () => {
    expect(await resolveLink("https://www.dropbox.com/scl/fi/abc/file.zip?rlkey=k&dl=0", fakeNet({}).net)).toEqual({ type: "file", url: "https://www.dropbox.com/scl/fi/abc/file.zip?rlkey=k&dl=1" });
  });

  it("1fichier: waits between free downloads, then posts the form", async () => {
    const url = "https://1fichier.com/?a1b2c3d4e5";
    const waiting = fakeNet({ [url]: page("Warning ! Without subscription, you can only download one file at a time... You must wait 12 minutes") });
    expect(await resolveLink(url, waiting.net)).toEqual({ type: "wait", seconds: 720, reason: "limit" });
    const ready = fakeNet({
      [`GET ${url}`]: page(`<form method="post" action="${url}"><input type="hidden" name="adz" value="9"><input type="checkbox" name="dl_no_ssl"></form>`),
      [`POST ${url}`]: (init) => {
        expect(init.form).toEqual({ adz: "9", dl_no_ssl: "on", dlinline: "on" });
        return page(`<a href="https://a-7.1fichier.com/c123456789abc" class="ok btn-general btn-orange">Click here to download the file</a>`);
      },
    });
    expect(await resolveLink(url, ready.net)).toEqual({ type: "file", url: "https://a-7.1fichier.com/c123456789abc", segments: false });
  });

  it("XFileSharing hosts: free form, countdown, second form, file", async () => {
    const url = "https://katfile.com/abc123/Set.part1.rar.html";
    const { net, slept, calls } = fakeNet({
      [`GET ${url}`]: page(`<form method="POST" action=""><input type="hidden" name="op" value="download1"><input type="hidden" name="id" value="abc123">
        <input type="submit" name="method_premium" value="Premium"></form>`),
      [`POST ${url}`]: (init) =>
        (init.form as Record<string, string>).op === "download1"
          ? page(`<span class="seconds">15</span><form method="POST"><input type="hidden" name="op" value="download2"><input type="hidden" name="id" value="abc123"><input type="hidden" name="rand" value="r1"></form>`)
          : page(`<a href="https://s12.katfile.com/d/abcdef123456/Set.part1.rar">Click here to download</a>`),
    });
    expect(await resolveLink(url, net)).toEqual({ type: "file", url: "https://s12.katfile.com/d/abcdef123456/Set.part1.rar", segments: false });
    expect(slept).toEqual([15_500]);
    expect(calls[1]!.init.form).toEqual({ op: "download1", id: "abc123", method_free: "Free Download" });
    const captcha = fakeNet({ [url]: page(`<div class="g-recaptcha" data-sitekey="x"></div>`) });
    expect(await resolveLink(url, captcha.net)).toEqual({ type: "attention", reason: "captcha" });
  });

  it("other pages: their download link, shorteners onto known hosts, checks, protectors", async () => {
    const { net } = fakeNet({ "https://files.example/get/42": page(`<a href="/nav">Home</a><a class="btn" href="/storage/Tool-1.2.zip">Download now</a>`) });
    expect(await resolveLink("https://files.example/get/42", net)).toEqual({ type: "file", url: "https://files.example/storage/Tool-1.2.zip" });
    const short = fakeNet({
      "https://bit.ly/abc": page("", { url: "https://www.mediafire.com/file/k/x.zip/file" }),
      "https://www.mediafire.com/file/k/x.zip/file": page(`<a id="downloadButton" href="https://download1.mediafire.com/a/k/x.zip">Download</a>`),
    });
    expect(await resolveLink("https://bit.ly/abc", short.net)).toMatchObject({ type: "file", url: "https://download1.mediafire.com/a/k/x.zip" });
    expect(await resolveLink("https://x.example/f", fakeNet({ "https://x.example/f": page("<title>Just a moment...</title>") }).net)).toEqual({ type: "attention", reason: "challenge" });
    expect(await resolveLink("https://rapidgator.net/file/abc", fakeNet({ "https://rapidgator.net/file/abc": page("<p>Free download</p>") }).net)).toEqual({ type: "attention", reason: "captcha" });
    expect(await resolveLink("https://filecrypt.cc/Container/ABC.html", fakeNet({}).net)).toEqual({ type: "attention", reason: "protector" });
    expect(await resolveLink("https://direct.example/a.bin", fakeNet({ "https://direct.example/a.bin": { file: true } }).net)).toEqual({ type: "file", url: "https://direct.example/a.bin" });
  });
});

describe("queue items from file hosts", () => {
  let n = 0;
  const newId = (): string => `id${++n}`;
  const base = (overrides: Partial<QueueItem> = {}): QueueItem => ({
    id: newId(),
    url: "https://mega.nz/folder/FoLdEr12#k",
    filename: "FoLdEr12",
    host: "mega.nz",
    kind: "hoster",
    hoster: "MEGA",
    slots: 2,
    state: "queued",
    receivedBytes: 0,
    totalBytes: null,
    attempts: 0,
    ...overrides,
  });
  const pkg = (items: QueueItem[], name = "Links from mega.nz"): QueuePackage => ({ id: newId(), name, source: "s", passwords: [], dir: `/dl/${name}`, addedAt: 1, items });

  it("queues hoster links with their host's name and free slots", () => {
    const [grabbed] = buildPackages(["https://katfile.com/a1/x.zip.html", "https://katfile.com/a2/y.zip.html"], { source: "s", now: 1, newId, all: false });
    const queued = queueFromGrabbed(grabbed!, "/dl", path.posix.join);
    expect(queued.items.map((i) => [i.kind, i.hoster, i.slots])).toEqual([["hoster", "Katfile", 1]]);
    const two = pkg([base({ host: "katfile.com", slots: 1 }), base({ host: "katfile.com", slots: 1 })]);
    expect(nextToStart([two], { parallel: 3, perHost: 2 })).toHaveLength(1);
  });

  it("replaces a folder link with its files, named after the folder", () => {
    const folder = base();
    const list = [pkg([folder])];
    const out = expandFolder(list, folder.id, [{ url: "u2", filename: "b.part2.rar", size: 2 }, { url: "u1", filename: "../b.part1.rar" }, { url: "d", filename: "c.txt", direct: true }], {
      newId,
      folderName: "Trip",
      join: path.posix.join,
      dirname: path.posix.dirname,
    });
    expect(out[0]).toMatchObject({ name: "Trip", dir: "/dl/Trip" });
    expect(out[0]!.items.map((i) => [i.filename, i.kind, i.part, i.totalBytes, i.hoster])).toEqual([
      ["b.part1.rar", "hoster", 1, null, "MEGA"],
      ["b.part2.rar", "hoster", 2, 2, "MEGA"],
      ["c.txt", "file", undefined, null, "MEGA"],
    ]);
    expect(safeFileName("..")).toBe("download");
  });

  it("wakes waiting files at their time, and retries look the file up again", () => {
    const waiting = base({ state: "waiting", retryAt: 500, reason: "limit" });
    const later = base({ state: "waiting", retryAt: 900, reason: "limit" });
    const list = [pkg([waiting, later])];
    expect(nextWake(list)).toBe(500);
    const woken = wakeWaiting(list, 600);
    expect(woken[0]!.items.map((i) => i.state)).toEqual(["queued", "waiting"]);
    expect(woken[0]!.items[0]!.reason).toBeUndefined();
    const stuck = base({ state: "attention", reason: "captcha", resolved: { url: "x", at: 1 } });
    const retried = applyQueueAction([pkg([stuck])], stuck.id, "retry").packages[0]!.items[0]!;
    expect(retried).toMatchObject({ state: "queued" });
    expect(retried.resolved).toBeUndefined();
    expect(retried.reason).toBeUndefined();
    const paused = applyQueueAction([pkg([base({ state: "waiting", retryAt: 5 })])], "none", "pause");
    expect(paused.packages[0]!.items[0]!.state).toBe("waiting");
  });

  it("after a restart, a download the page was doing asks for the page again", () => {
    const inPage = base({ state: "running", inPage: true });
    const resolving = base({ state: "running", resolving: true });
    const [revived] = reviveQueue([pkg([inPage, resolving])]);
    expect(revived!.items.map((i) => [i.state, i.reason, i.inPage, i.resolving])).toEqual([
      ["attention", "expired", undefined, undefined],
      ["queued", undefined, undefined, undefined],
    ]);
  });
});
