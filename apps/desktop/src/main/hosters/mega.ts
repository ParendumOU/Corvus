import crypto from "node:crypto";
import { attention, file, offline, wait, type FolderEntry, type HosterNet, type MegaCipher, type Resolution } from "./types";

/**
 * MEGA links: a file (mega.nz/file/<handle>#<key>), a folder (mega.nz/folder/<handle>#<key>) or a
 * file inside one (…/folder/<handle>#<key>/file/<node>), old "#!" and "#F!" forms too. The key in
 * the link decrypts the names and the file, which MEGA's servers only ever see encrypted.
 */
export type MegaLink =
  | { kind: "file"; handle: string; key: string }
  | { kind: "folder"; handle: string; key: string; node?: string; subfolder?: string };

export function parseMegaLink(raw: string): MegaLink | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const hash = url.hash.replace(/^#/, "");
  const path = url.pathname;
  let m = /^\/(?:file|embed)\/([\w-]{8})$/.exec(path);
  if (m && /^[\w-]{43}$/.test(hash)) return { kind: "file", handle: m[1]!, key: hash };
  m = /^\/folder\/([\w-]{8})$/.exec(path);
  if (m) {
    const [key, sub, id] = hash.split("/");
    if (!key || !/^[\w-]{22}$/.test(key)) return null;
    return { kind: "folder", handle: m[1]!, key, ...(sub === "file" && id ? { node: id } : sub === "folder" && id ? { subfolder: id } : {}) };
  }
  m = /^!([\w-]{8})!([\w-]{43})$/.exec(hash);
  if (m) return { kind: "file", handle: m[1]!, key: m[2]! };
  m = /^F!([\w-]{8})!([\w-]{22})(?:!([\w-]{8}))?$/.exec(hash);
  if (m) return { kind: "folder", handle: m[1]!, key: m[2]!, ...(m[3] ? { node: m[3] } : {}) };
  return null;
}

export function base64urlDecode(text: string): Buffer {
  return Buffer.from(text.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

/** A file's 32-byte key: the AES key is its two halves XORed; the counter starts with bytes 16-23. */
export function megaFileCipher(fullKey: Buffer): MegaCipher & { aes: Buffer } {
  if (fullKey.length !== 32) throw new Error("Bad MEGA file key");
  const aes = Buffer.alloc(16);
  for (let i = 0; i < 16; i++) aes[i] = fullKey[i]! ^ fullKey[i + 16]!;
  const iv = Buffer.alloc(16);
  fullKey.copy(iv, 0, 16, 24);
  return { aes, key: aes.toString("hex"), iv: iv.toString("hex") };
}

/** Node attributes ("MEGA{"n":"name"}"), AES-CBC with a zero IV. */
export function decryptAttributes(encoded: string, aes: Buffer): { n?: string } | null {
  try {
    const data = base64urlDecode(encoded);
    const decipher = crypto.createDecipheriv("aes-128-cbc", aes, Buffer.alloc(16));
    decipher.setAutoPadding(false);
    const text = Buffer.concat([decipher.update(data.subarray(0, data.length - (data.length % 16))), decipher.final()]).toString("utf8");
    if (!text.startsWith("MEGA{")) return null;
    return JSON.parse(text.slice(4, text.lastIndexOf("}") + 1)) as { n?: string };
  } catch {
    return null;
  }
}

/** A node key inside a folder, encrypted with the folder's key (AES-ECB). */
export function decryptNodeKey(encrypted: string, folderKey: Buffer): Buffer {
  const data = base64urlDecode(encrypted);
  const decipher = crypto.createDecipheriv("aes-128-ecb", folderKey, null);
  decipher.setAutoPadding(false);
  return Buffer.concat([decipher.update(data), decipher.final()]);
}

/**
 * Decrypts bytes of a MEGA file that start at `pos` (any offset: CTR mode lets each part of a
 * file be decrypted on its own).
 */
export function megaDecryptor(cipher: MegaCipher, pos: number): (chunk: Uint8Array) => Buffer {
  const iv = Buffer.from(cipher.iv, "hex");
  iv.writeBigUInt64BE(BigInt(Math.floor(pos / 16)), 8);
  const decipher = crypto.createDecipheriv("aes-128-ctr", Buffer.from(cipher.key, "hex"), iv);
  const skip = pos % 16;
  if (skip) decipher.update(Buffer.alloc(skip));
  return (chunk) => decipher.update(chunk);
}

const API = "https://g.api.mega.co.nz/cs";
let sequence = Math.floor(Math.random() * 1e9);

/** MEGA's error codes that say what to do. */
function fromError(code: number): Resolution {
  if (code === -9 || code === -16 || code === -2 || code === -11) return offline();
  if (code === -17) return wait(30 * 60, "quota");
  return wait(60, "busy");
}

type Answer = { data: Record<string, unknown> } | { stop: Resolution };

async function api(net: HosterNet, request: Record<string, unknown>, folder?: string): Promise<Answer> {
  const res = await net.fetch(`${API}?id=${sequence++}${folder ? `&n=${folder}` : ""}`, { method: "POST", json: [request] });
  // 402: the API wants a proof of work before it answers; MEGA's own page does that.
  if (res.status === 402) return { stop: attention("challenge") };
  if (res.status === 509) return { stop: wait(30 * 60, "quota") };
  if (res.status >= 500 || res.status === 429) return { stop: wait(60, "busy") };
  const body = await res.json();
  const first = Array.isArray(body) ? body[0] : body;
  if (typeof first === "number") return { stop: fromError(first) };
  if (!first || typeof first !== "object") return { stop: wait(60, "busy") };
  const e = (first as { e?: unknown }).e;
  if (typeof e === "number" && e < 0) return { stop: fromError(e) };
  return { data: first as Record<string, unknown> };
}

interface FolderNode {
  h: string;
  p: string;
  t: number;
  a?: string;
  k?: string;
  s?: number;
}

/** Folder listings, kept a few minutes so each file of a big folder does not list it again. */
const listings = new Map<string, { at: number; nodes: FolderNode[] }>();
const LISTING_TTL_MS = 10 * 60 * 1000;

async function listFolder(net: HosterNet, handle: string): Promise<{ nodes: FolderNode[] } | { stop: Resolution }> {
  const cached = listings.get(handle);
  if (cached && Date.now() - cached.at < LISTING_TTL_MS) return { nodes: cached.nodes };
  const answer = await api(net, { a: "f", c: 1, ca: 1, r: 1 }, handle);
  if ("stop" in answer) return answer;
  const nodes = Array.isArray(answer.data.f) ? (answer.data.f as FolderNode[]).filter((n) => n && typeof n.h === "string") : [];
  listings.set(handle, { at: Date.now(), nodes });
  return { nodes };
}

/** The node's own key: the "<owner>:<key>" pair that the folder's key opens. */
function nodeKey(node: FolderNode, folderKey: Buffer): Buffer | null {
  for (const pair of (node.k ?? "").split("/")) {
    const encrypted = pair.split(":")[1];
    if (!encrypted) continue;
    try {
      const key = decryptNodeKey(encrypted, folderKey);
      if (key.length === (node.t === 0 ? 32 : 16)) return key;
    } catch {
      // try the next pair
    }
  }
  return null;
}

function nodeName(node: FolderNode, folderKey: Buffer): string | undefined {
  const key = nodeKey(node, folderKey);
  if (!key || !node.a) return undefined;
  return decryptAttributes(node.a, node.t === 0 ? megaFileCipher(key).aes : key)?.n;
}

async function resolveFile(net: HosterNet, link: Extract<MegaLink, { kind: "file" }>): Promise<Resolution> {
  const key = base64urlDecode(link.key);
  if (key.length !== 32) return offline();
  const cipher = megaFileCipher(key);
  const answer = await api(net, { a: "g", g: 1, ssl: 2, p: link.handle });
  if ("stop" in answer) return answer.stop;
  const { g, at, s } = answer.data;
  if (typeof g !== "string" || !g) return wait(60, "busy");
  const name = typeof at === "string" ? decryptAttributes(at, cipher.aes)?.n : undefined;
  return file(g, { ...(name ? { filename: name } : {}), ...(typeof s === "number" ? { size: s } : {}), mega: { key: cipher.key, iv: cipher.iv } });
}

async function resolveFolder(net: HosterNet, link: Extract<MegaLink, { kind: "folder" }>, url: URL): Promise<Resolution> {
  const folderKey = base64urlDecode(link.key);
  if (folderKey.length !== 16) return offline();
  const listed = await listFolder(net, link.handle);
  if ("stop" in listed) return listed.stop;
  const nodes = listed.nodes;
  if (nodes.length === 0) return offline();
  if (link.node) {
    const node = nodes.find((n) => n.h === link.node && n.t === 0);
    const key = node ? nodeKey(node, folderKey) : null;
    if (!node || !key) return offline();
    const cipher = megaFileCipher(key);
    const answer = await api(net, { a: "g", g: 1, ssl: 2, n: node.h }, link.handle);
    if ("stop" in answer) return answer.stop;
    const g = answer.data.g;
    if (typeof g !== "string" || !g) return wait(60, "busy");
    const name = nodeName(node, folderKey);
    return file(g, { ...(name ? { filename: name } : {}), ...(typeof node.s === "number" ? { size: node.s } : {}), mega: { key: cipher.key, iv: cipher.iv } });
  }
  // The folder's files (in a subfolder, when the link points at one), each its own queue item.
  const byHandle = new Map(nodes.map((n) => [n.h, n]));
  const top = link.subfolder ?? nodes.find((n) => n.t === 1 && !byHandle.has(n.p))?.h;
  const under = (n: FolderNode): boolean => {
    for (let p = n.p, depth = 0; p && depth < 64; p = byHandle.get(p)?.p ?? "", depth++) if (p === top) return true;
    return false;
  };
  const base = `${url.origin}/folder/${link.handle}#${link.key}`;
  const entries: FolderEntry[] = nodes
    .filter((n) => n.t === 0 && (!top || under(n)))
    .map((n) => {
      const name = nodeName(n, folderKey);
      return { url: `${base}/file/${n.h}`, ...(name ? { filename: name } : {}), ...(typeof n.s === "number" ? { size: n.s } : {}) };
    });
  const topNode = top ? byHandle.get(top) : undefined;
  const folderName = topNode ? nodeName(topNode, folderKey) : undefined;
  return { type: "folder", ...(folderName ? { name: folderName } : {}), entries };
}

export async function resolveMega(raw: string, net: HosterNet): Promise<Resolution> {
  const link = parseMegaLink(raw);
  if (!link) return attention("page");
  return link.kind === "file" ? resolveFile(net, link) : resolveFolder(net, link, new URL(raw));
}
