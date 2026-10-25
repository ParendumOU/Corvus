import { absolute, anchors, attr, forms, hasCaptcha, isChallenge, metaRefresh, pageTitle, parseSize, waitSeconds } from "./html";
import { attention, file, offline, wait, type FolderEntry, type HostResponse, type HosterNet, type Resolution } from "./types";

/**
 * Resolvers for the file hosts with their own way to the file: a public API, or a download button
 * whose address is written in the page. Each reads only what the host shows any visitor (or the
 * person, when signed in), waits when the host asks to, and leaves CAPTCHAs to the person.
 */

const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
const num = (v: unknown): number | undefined => {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : undefined;
};
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});

/** What a page says when it is not the file: gone, a check, a CAPTCHA. Null when it may hold the file. */
function pageBlock(res: HostResponse, html: string, gone: RegExp): Resolution | null {
  if (res.status === 404 || res.status === 410 || gone.test(html)) return offline();
  if (isChallenge(html)) return attention("challenge");
  if (res.status === 429 || res.status === 503) return wait(60, "busy");
  return null;
}

// ------------------------------------------------------------------------------------- MediaFire

/** The download button's address: plain, or base64 in data-scrambled-url. */
export function mediafireLink(html: string): string | null {
  const tag = /<a\b[^>]*id=["']downloadButton["'][^>]*>/i.exec(html)?.[0];
  if (tag) {
    const scrambled = attr(tag, "data-scrambled-url");
    if (scrambled) {
      const decoded = Buffer.from(scrambled, "base64").toString("utf8");
      if (/^https?:\/\//.test(decoded)) return decoded;
    }
    const href = attr(tag, "href");
    if (href && /^https?:\/\//.test(href)) return href;
  }
  return /https?:\/\/download\d+\.mediafire\.com\/[^"'\s<>]+/i.exec(html)?.[0] ?? null;
}

const MEDIAFIRE_API = "https://www.mediafire.com/api/1.5/folder";

async function mediafireFolder(net: HosterNet, key: string, depth = 0, seen = new Set<string>()): Promise<FolderEntry[]> {
  if (depth > 3 || seen.has(key)) return [];
  seen.add(key);
  const out: FolderEntry[] = [];
  for (let chunk = 1; chunk <= 50; chunk++) {
    const res = await net.fetch(`${MEDIAFIRE_API}/get_content.php?folder_key=${encodeURIComponent(key)}&content_type=files&chunk=${chunk}&response_format=json`);
    const content = obj(obj(obj(await res.json()).response).folder_content);
    for (const f of Array.isArray(content.files) ? content.files : []) {
      const quickkey = str(obj(f).quickkey);
      const filename = str(obj(f).filename);
      if (!quickkey) continue;
      out.push({ url: `https://www.mediafire.com/file/${quickkey}/${encodeURIComponent(filename ?? "file")}/file`, ...(filename ? { filename } : {}), ...(num(obj(f).size) !== undefined ? { size: num(obj(f).size)! } : {}) });
    }
    if (content.more_chunks !== "yes") break;
  }
  const res = await net.fetch(`${MEDIAFIRE_API}/get_content.php?folder_key=${encodeURIComponent(key)}&content_type=folders&response_format=json`);
  const folders = obj(obj(obj(await res.json()).response).folder_content).folders;
  for (const sub of Array.isArray(folders) ? folders : []) {
    const subKey = str(obj(sub).folderkey);
    if (subKey) out.push(...(await mediafireFolder(net, subKey, depth + 1, seen)));
  }
  return out;
}

export async function resolveMediafire(raw: string, net: HosterNet): Promise<Resolution> {
  const url = new URL(raw);
  const folder = /^\/folder\/([a-z0-9]+)/i.exec(url.pathname)?.[1];
  if (folder) {
    const info = obj(obj(obj(await (await net.fetch(`${MEDIAFIRE_API}/get_info.php?folder_key=${folder}&response_format=json`)).json()).response).folder_info);
    const entries = await mediafireFolder(net, folder);
    return entries.length > 0 ? { type: "folder", ...(str(info.name) ? { name: str(info.name)! } : {}), entries } : offline();
  }
  const res = await net.fetch(raw);
  if (res.isFile) {
    await res.cancel();
    return file(res.url);
  }
  const html = await res.text();
  if (/\/error\.php/.test(res.url)) return offline();
  const blocked = pageBlock(res, html, /error\.php|Invalid or Deleted File|File Removed for Violation|has been removed/i);
  if (blocked) return blocked;
  if (/id=["']pwd["']|password protected/i.test(html) && !mediafireLink(html)) return attention("password");
  const link = mediafireLink(html);
  if (!link) return hasCaptcha(html) ? attention("captcha") : attention("page");
  const name = /<div class=["']filename["'][^>]*>([^<]+)</i.exec(html)?.[1]?.trim();
  return file(link, name ? { filename: name } : {});
}

// ------------------------------------------------------------------------------------ Pixeldrain

export async function resolvePixeldrain(raw: string, net: HosterNet): Promise<Resolution> {
  const url = new URL(raw);
  const origin = "https://pixeldrain.com";
  const list = /^\/(?:l|api\/list)\/([\w-]+)/.exec(url.pathname)?.[1];
  if (list) {
    const res = await net.fetch(`${origin}/api/list/${list}`);
    if (res.status === 404) return offline();
    const data = obj(await res.json());
    const files = Array.isArray(data.files) ? data.files : [];
    const entries = files.flatMap((f): FolderEntry[] => {
      const id = str(obj(f).id);
      return id ? [{ url: `${origin}/api/file/${id}?download`, direct: true, ...(str(obj(f).name) ? { filename: str(obj(f).name)! } : {}), ...(num(obj(f).size) !== undefined ? { size: num(obj(f).size)! } : {}) }] : [];
    });
    return entries.length > 0 ? { type: "folder", ...(str(data.title) ? { name: str(data.title)! } : {}), entries } : offline();
  }
  const id = /^\/(?:u|api\/file)\/([\w-]+)/.exec(url.pathname)?.[1];
  if (!id) return attention("page");
  const res = await net.fetch(`${origin}/api/file/${id}/info`);
  if (res.status === 404) return offline();
  const info = obj(await res.json());
  const availability = str(info.availability) ?? "";
  if (/captcha/i.test(availability)) return attention("captcha");
  if (availability && /limit|rate/i.test(availability)) return wait(15 * 60, "limit");
  return file(`${origin}/api/file/${id}?download`, { ...(str(info.name) ? { filename: str(info.name)! } : {}), ...(num(info.size) !== undefined ? { size: num(info.size)! } : {}) });
}

// ---------------------------------------------------------------------------------- Google Drive

export function driveFileId(raw: string): string | null {
  const url = new URL(raw);
  return /\/file\/d\/([\w-]{10,})/.exec(url.pathname)?.[1] ?? (url.pathname.includes("/folders/") ? null : url.searchParams.get("id"));
}

/** The "can't scan this file for viruses" page: its form leads to the file. */
export function driveConfirmLink(html: string, base: string): string | null {
  const form = forms(html, base).find((f) => /download/i.test(f.action) && "id" in f.fields);
  if (!form) {
    const href = anchors(html, base).find((a) => /[?&]confirm=/.test(a.href) && /download|uc\?/.test(a.href))?.href;
    return href ?? null;
  }
  const url = new URL(form.action);
  for (const [k, v] of Object.entries(form.fields)) url.searchParams.set(k, v);
  return url.href;
}

async function driveFolder(net: HosterNet, id: string, depth = 0): Promise<{ name?: string; entries: FolderEntry[] }> {
  const res = await net.fetch(`https://drive.google.com/embeddedfolderview?id=${encodeURIComponent(id)}`);
  const html = await res.text();
  const entries: FolderEntry[] = [];
  for (const chunk of html.split(/class=["']flip-entry["']/).slice(1)) {
    const href = /href=["']([^"']+)["']/.exec(chunk)?.[1] ?? "";
    const title = /class=["']flip-entry-title["'][^>]*>([^<]*)</.exec(chunk)?.[1]?.trim();
    const fileId = /\/file\/d\/([\w-]+)/.exec(href)?.[1];
    const folderId = /\/folders\/([\w-]+)/.exec(href)?.[1];
    if (fileId) entries.push({ url: `https://drive.google.com/file/d/${fileId}/view`, ...(title ? { filename: title } : {}) });
    else if (folderId && depth < 2) entries.push(...(await driveFolder(net, folderId, depth + 1)).entries);
  }
  const name = pageTitle(html)?.replace(/\s*[–-]\s*Google Drive$/i, "");
  return { ...(name ? { name } : {}), entries };
}

export async function resolveDrive(raw: string, net: HosterNet): Promise<Resolution> {
  const folder = /\/folders\/([\w-]{10,})/.exec(new URL(raw).pathname)?.[1];
  if (folder) {
    const { name, entries } = await driveFolder(net, folder);
    return entries.length > 0 ? { type: "folder", ...(name ? { name } : {}), entries } : attention("login");
  }
  const id = driveFileId(raw);
  if (!id) return attention("page");
  const direct = `https://drive.usercontent.google.com/download?id=${encodeURIComponent(id)}&export=download`;
  const res = await net.fetch(direct);
  if (res.isFile) {
    await res.cancel();
    return file(res.url);
  }
  const html = await res.text();
  if (res.status === 404) return offline();
  if (/accounts\.google\.com/.test(res.url) || /ServiceLogin/.test(html)) return attention("login");
  if (/Too many users have viewed or downloaded|download quota|Quota exceeded/i.test(html)) return wait(60 * 60, "quota");
  const confirm = driveConfirmLink(html, res.url);
  if (!confirm) return /request access|You need access/i.test(html) ? attention("login") : attention("page");
  const name = /class=["']uc-name-size["'][^>]*>\s*<a[^>]*>([^<]+)</.exec(html)?.[1]?.trim();
  const size = /class=["']uc-name-size["'][^>]*>[\s\S]*?\(([^)]+)\)/.exec(html)?.[1];
  return file(confirm, { ...(name ? { filename: name } : {}), ...(size && parseSize(size) ? { size: parseSize(size)! } : {}) });
}

// --------------------------------------------------------------------------------------- Dropbox

export async function resolveDropbox(raw: string, net: HosterNet): Promise<Resolution> {
  let url = new URL(raw);
  // db.tt short links lead to the share page.
  if (url.hostname.replace(/^www\./, "") === "db.tt") {
    const res = await net.fetch(raw);
    await res.cancel();
    url = new URL(res.url);
  }
  url.searchParams.delete("raw");
  url.searchParams.set("dl", "1");
  return file(url.href);
}

// -------------------------------------------------------------------------------------- OneDrive

export async function resolveOnedrive(raw: string, net: HosterNet): Promise<Resolution> {
  const token = `u!${Buffer.from(raw).toString("base64").replace(/=+$/, "").replace(/\//g, "_").replace(/\+/g, "-")}`;
  const res = await net.fetch(`https://api.onedrive.com/v1.0/shares/${token}/driveItem?$expand=children`, { headers: { Prefer: "autoredeem" } });
  if (res.status === 404) return offline();
  if (res.status !== 200) return attention("login");
  const item = obj(await res.json());
  const link = (i: Record<string, unknown>): string | undefined => str(i["@content.downloadUrl"]) ?? str(i["@microsoft.graph.downloadUrl"]);
  if (item.folder) {
    const children = Array.isArray(item.children) ? item.children.map(obj) : [];
    const entries = children.flatMap((c): FolderEntry[] => {
      const href = c.file ? link(c) : undefined;
      return href ? [{ url: href, direct: true, ...(str(c.name) ? { filename: str(c.name)! } : {}), ...(num(c.size) !== undefined ? { size: num(c.size)! } : {}) }] : [];
    });
    return entries.length > 0 ? { type: "folder", ...(str(item.name) ? { name: str(item.name)! } : {}), entries } : attention("page");
  }
  const href = link(item);
  return href ? file(href, { ...(str(item.name) ? { filename: str(item.name)! } : {}), ...(num(item.size) !== undefined ? { size: num(item.size)! } : {}) }) : attention("page");
}

// ------------------------------------------------------------------------------------ WeTransfer

export async function resolveWetransfer(raw: string, net: HosterNet): Promise<Resolution> {
  // we.tl short links lead to wetransfer.com/downloads/<transfer>/[<recipient>/]<hash>.
  const page = await net.fetch(raw);
  const html = await page.text();
  const parts = /\/downloads\/([0-9a-f]+)\/(?:([0-9a-f]+)\/)?([0-9a-f]+)/.exec(new URL(page.url).pathname);
  if (!parts) return page.status === 404 ? offline() : attention("page");
  const [, transfer, recipient, hash] = parts;
  const csrf = /<meta\s+name=["']csrf-token["']\s+content=["']([^"']+)["']/i.exec(html)?.[1];
  const res = await net.fetch(`https://wetransfer.com/api/v4/transfers/${transfer}/download`, {
    method: "POST",
    headers: { "x-requested-with": "XMLHttpRequest", ...(csrf ? { "x-csrf-token": csrf } : {}) },
    json: { intent: "entire_transfer", security_hash: hash, ...(recipient ? { recipient_id: recipient } : {}) },
  });
  if (res.status === 404 || res.status === 410) return offline();
  const link = str(obj(await res.json().catch(() => ({}))).direct_link);
  return link ? file(link, { segments: false }) : attention("page");
}

// ---------------------------------------------------------------------------------------- Gofile

/**
 * Gofile lists a folder through its API with an account token: the person's own (signed in on
 * gofile.io), or a guest one the API hands out, kept as the session's gofile.io cookie as the site
 * itself does. Its download links need that cookie.
 */
export async function resolveGofile(raw: string, net: HosterNet): Promise<Resolution> {
  const code = /^\/d\/([\w-]+)/.exec(new URL(raw).pathname)?.[1];
  if (!code) return attention("page");
  let token = await net.cookie("https://gofile.io/", "accountToken");
  if (!token) {
    const created = obj(await (await net.fetch("https://api.gofile.io/accounts", { method: "POST" })).json());
    token = str(obj(created.data).token) ?? null;
    if (!token) return wait(60, "busy");
    await net.setCookie("https://gofile.io/", "accountToken", token);
  }
  const script = await (await net.fetch("https://gofile.io/dist/js/global.js")).text();
  const wt = /\bwt\s*[:=]\s*["']([^"']+)["']/.exec(script)?.[1] ?? "4fd6sg89d7s6";
  const list = async (id: string, depth: number): Promise<{ name?: string; entries: FolderEntry[] } | Resolution> => {
    const res = await net.fetch(`https://api.gofile.io/contents/${id}?wt=${encodeURIComponent(wt)}&cache=true`, { headers: { Authorization: `Bearer ${token}` } });
    const body = obj(await res.json().catch(() => ({})));
    const status = str(body.status) ?? "";
    if (status === "error-notFound") return offline();
    if (status === "error-passwordRequired") return attention("password");
    if (status !== "ok") return attention("page");
    const data = obj(body.data);
    const entries: FolderEntry[] = [];
    for (const child of Object.values(obj(data.children)).map(obj)) {
      if (child.type === "file" && str(child.link)) {
        entries.push({ url: str(child.link)!, direct: true, ...(str(child.name) ? { filename: str(child.name)! } : {}), ...(num(child.size) !== undefined ? { size: num(child.size)! } : {}) });
      } else if (child.type === "folder" && str(child.id) && depth < 3) {
        const sub = await list(str(child.id)!, depth + 1);
        if ("entries" in sub) entries.push(...sub.entries);
      }
    }
    return { ...(str(data.name) ? { name: str(data.name)! } : {}), entries };
  };
  const found = await list(code, 0);
  if (!("entries" in found)) return found;
  return found.entries.length > 0 ? { type: "folder", ...(found.name ? { name: found.name } : {}), entries: found.entries } : offline();
}

// ----------------------------------------------------------------------------------- Yandex Disk

export async function resolveYandex(raw: string, net: HosterNet): Promise<Resolution> {
  const key = encodeURIComponent(raw);
  const meta = await net.fetch(`https://cloud-api.yandex.net/v1/disk/public/resources?public_key=${key}&limit=0`);
  if (meta.status === 404) return offline();
  const info = obj(await meta.json().catch(() => ({})));
  const res = await net.fetch(`https://cloud-api.yandex.net/v1/disk/public/resources/download?public_key=${key}`);
  if (res.status === 404) return offline();
  const href = str(obj(await res.json().catch(() => ({}))).href);
  if (!href) return attention("page");
  // A folder comes as one ZIP.
  const name = str(info.name);
  return file(href, { ...(name ? { filename: info.type === "dir" ? `${name}.zip` : name } : {}), ...(info.type !== "dir" && num(info.size) !== undefined ? { size: num(info.size)! } : {}) });
}

// ----------------------------------------------------------------------------------- SourceForge

export async function resolveSourceforge(raw: string, net: HosterNet): Promise<Resolution> {
  const url = new URL(raw);
  if (!/\/download\/?$/.test(url.pathname)) url.pathname = `${url.pathname.replace(/\/$/, "")}/download`;
  const res = await net.fetch(url.href);
  if (res.isFile) {
    await res.cancel();
    return file(res.url);
  }
  const html = await res.text();
  const blocked = pageBlock(res, html, /Error 404|No such file/i);
  if (blocked) return blocked;
  const direct = anchors(html, res.url).find((a) => /^https:\/\/downloads\.sourceforge\.net\//.test(a.href))?.href ?? metaRefresh(html, res.url);
  return direct ? file(direct) : attention("page");
}

// -------------------------------------------------------------------------------------- 1fichier

export function onefichierLink(html: string, base: string): string | null {
  const links = anchors(html, base);
  return (
    links.find((a) => /\bok\b[^"']*btn-general|btn-orange/.test(a.tag) && /1fichier\.com\//.test(a.href))?.href ??
    links.find((a) => /^https:\/\/[a-z0-9-]+\.1fichier\.com\/[a-z0-9]{8,}/i.test(a.href) && !/^https:\/\/(www\.)?1fichier\.com\//.test(a.href))?.href ??
    null
  );
}

export async function resolveOnefichier(raw: string, net: HosterNet): Promise<Resolution> {
  const res = await net.fetch(raw);
  if (res.isFile) {
    await res.cancel();
    return file(res.url, { segments: false });
  }
  const html = await res.text();
  const blocked = pageBlock(res, html, /The requested file (?:does not exist|has been deleted)|Le fichier demandé n'existe pas|File not found/i);
  if (blocked) return blocked;
  const limit = /You must wait|Vous devez attendre|without subscription/i.test(html) ? waitSeconds(html) : null;
  if (limit) return wait(limit, "limit");
  // Signed in with a premium account, the page may already hold the file.
  const ready = onefichierLink(html, res.url);
  if (ready) return file(ready, { segments: false });
  const form = forms(html, res.url).find((f) => f.method === "POST" && ("adz" in f.fields || /dl_no_ssl|dlinline/.test(f.html)));
  if (!form) return /name=["']pass["']/i.test(html) ? attention("password") : hasCaptcha(html) ? attention("captcha") : attention("page");
  if (/name=["']pass["']/i.test(form.html)) return attention("password");
  const next = await net.fetch(form.action, { method: "POST", form: { ...form.fields, dl_no_ssl: "on", dlinline: "on" } });
  if (next.isFile) {
    await next.cancel();
    return file(next.url, { segments: false });
  }
  const page = await next.text();
  const after = /You must wait|Vous devez attendre/i.test(page) ? waitSeconds(page) : null;
  if (after) return wait(after, "limit");
  const link = onefichierLink(page, next.url);
  return link ? file(link, { segments: false }) : hasCaptcha(page) ? attention("captcha") : attention("page");
}

// ----------------------------------------------------------------------------------- KrakenFiles

export async function resolveKrakenfiles(raw: string, net: HosterNet): Promise<Resolution> {
  const res = await net.fetch(raw);
  const html = await res.text();
  const blocked = pageBlock(res, html, /File not found|has been deleted/i);
  if (blocked) return blocked;
  const form = forms(html, res.url).find((f) => /\/download\//.test(f.action) && "token" in f.fields);
  if (!form) return hasCaptcha(html) ? attention("captcha") : attention("page");
  const hash = /\/download\/([\w-]+)/.exec(form.action)?.[1] ?? "";
  const answer = obj(await (await net.fetch(form.action, { method: "POST", headers: { hash }, form: { token: form.fields.token! } })).json().catch(() => ({})));
  const url = str(answer.url);
  return url ? file(absolute(url, res.url) ?? url, { segments: false }) : attention("page");
}

// ------------------------------------------------------------------------------------- SendSpace

export async function resolveSendspace(raw: string, net: HosterNet): Promise<Resolution> {
  const res = await net.fetch(raw);
  const html = await res.text();
  const blocked = pageBlock(res, html, /the file you requested is not available|file has been deleted/i);
  if (blocked) return blocked;
  const tag = /<a\b[^>]*id=["']download_button["'][^>]*>/i.exec(html)?.[0];
  const link = absolute(tag ? attr(tag, "href") : null, res.url);
  return link ? file(link, { segments: false }) : attention("page");
}

// ------------------------------------------------------------------------------------ Solidfiles

export async function resolveSolidfiles(raw: string, net: HosterNet): Promise<Resolution> {
  const res = await net.fetch(raw);
  const html = await res.text();
  const blocked = pageBlock(res, html, /File not found|This file has been deleted/i);
  if (blocked) return blocked;
  const found = /"downloadUrl"\s*:\s*"([^"]+)"/.exec(html)?.[1];
  const link = found ? found.replace(/\\\//g, "/").replace(/\\u0026/g, "&") : null;
  return link && /^https?:\/\//.test(link) ? file(link, { segments: false }) : attention("page");
}

// ----------------------------------------------------------------------------------- BuzzHeavier

export async function resolveBuzzheavier(raw: string, net: HosterNet): Promise<Resolution> {
  const url = new URL(raw);
  const id = /^\/([\w-]+)/.exec(url.pathname)?.[1];
  if (!id) return attention("page");
  const res = await net.fetch(`${url.origin}/${id}/download`, { headers: { "hx-request": "true", referer: url.href } });
  if (res.status === 404) return offline();
  const link = absolute(res.header("hx-redirect"), url.href);
  await res.cancel();
  return link ? file(link) : attention("page");
}
