/**
 * Link grabber: finds download links in a page or in copied text, recognises split archives
 * (name.part1.rar, name.r00, name.7z.001, name.z01, name.001), groups the parts of one file into a
 * package, and picks up archive passwords written next to the links ("Password: abc").
 * Pure, so the rules are unit tested.
 */
import { isHosterDownloadLink } from "./hosters";

/** "hoster": a file host's page (or any page added by hand), resolved into its file by the queue. */
export type LinkKind = "file" | "archive-part" | "hoster";

export interface GrabbedLink {
  id: string;
  url: string;
  /** File name from the address (may be a guess for hoster links). */
  filename: string;
  kind: LinkKind;
  host: string;
  /** Volume number for split archives (1 = first). */
  part?: number;
}

export interface GrabbedPackage {
  id: string;
  name: string;
  /** Where the links came from: a page address, or "clipboard". */
  source: string;
  links: GrabbedLink[];
  /** Candidate archive passwords found next to the links, most likely first. */
  passwords: string[];
  addedAt: number;
}

const FILE_EXT =
  /\.(zip|rar|7z|tar|gz|tgz|bz2|xz|zst|iso|img|dmg|exe|msi|apk|deb|rpm|appimage|pdf|epub|mobi|cbz|cbr|mp3|flac|wav|ogg|m4a|mp4|mkv|avi|mov|webm|wmv|m4v|ts|jpg|jpeg|png|gif|webp|psd|docx?|xlsx?|pptx?|csv|srt|torrent|bin|cue|sfv|md5|sha256)$/i;

export interface SplitInfo {
  /** The archive's name without volume numbering, shared by every part. */
  base: string;
  part: number;
  format: "rar" | "7z" | "zip" | "split";
}

/** Volume info of a split archive part, or null for a single file. */
export function splitArchive(filename: string): SplitInfo | null {
  let m = /^(.+)\.part0*(\d+)\.rar$/i.exec(filename);
  if (m) return { base: m[1]!, part: Number(m[2]), format: "rar" };
  // Old RAR naming: name.rar is the first volume, then name.r00, name.r01, ...
  m = /^(.+)\.r(\d{2,3})$/i.exec(filename);
  if (m) return { base: m[1]!, part: Number(m[2]) + 2, format: "rar" };
  m = /^(.+)\.(7z|zip|rar)\.(\d{3})$/i.exec(filename);
  if (m) return { base: m[1]!, part: Number(m[3]), format: m[2]!.toLowerCase() === "7z" ? "7z" : m[2]!.toLowerCase() === "zip" ? "zip" : "rar" };
  // Split ZIP: name.z01, name.z02, ... and name.zip last.
  m = /^(.+)\.z(\d{2})$/i.exec(filename);
  if (m) return { base: m[1]!, part: Number(m[2]), format: "zip" };
  m = /^(.+)\.(\d{3})$/.exec(filename);
  if (m) return { base: m[1]!, part: Number(m[2]), format: "split" };
  return null;
}

function hostOf(url: URL): string {
  return url.hostname.replace(/^www\./, "").toLowerCase();
}

/** The file name an address points to; hoster pages often end in "name.ext.html". */
export function filenameOf(raw: string): string {
  try {
    const url = new URL(raw);
    const segments = url.pathname.split("/").filter(Boolean);
    // MediaFire: /file/<key>/<name>/file
    const last = (segments.length >= 3 && segments[segments.length - 1] === "file" && segments[0] === "file" ? segments[segments.length - 2] : segments.pop()) ?? "";
    let name = decodeURIComponent(last);
    if (/\.(html?|php)$/i.test(name) && FILE_EXT.test(name.replace(/\.(html?|php)$/i, ""))) name = name.replace(/\.(html?|php)$/i, "");
    return name.slice(0, 255);
  } catch {
    return "";
  }
}

/** What kind of download link this is, or null for an ordinary page. */
export function classifyLink(raw: string): LinkKind | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  // A hoster page named like an archive part is still a page: the queue resolves it first.
  if (isHosterDownloadLink(raw)) return "hoster";
  const name = filenameOf(raw);
  if (splitArchive(name)) return "archive-part";
  if (FILE_EXT.test(name)) return "file";
  return null;
}

/** The address ends in a file name (an archive part or a known file type). */
export function looksLikeFile(raw: string): boolean {
  const name = filenameOf(raw);
  return Boolean(splitArchive(name)) || FILE_EXT.test(name);
}

/** Web addresses in free text, trailing punctuation removed, in order, without repeats. */
export function extractUrls(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/https?:\/\/[^\s<>"'`]+/gi)) {
    const url = m[0].replace(/[),.;:!?\]]+$/, "");
    if (!out.includes(url)) out.push(url);
  }
  return out;
}

const PASSWORD_RE = /(?:^|[^\p{L}])(?:password|passwort|passwd|pass|pwd|pw|contraseña|contrasena|clave|mot de passe|senha|parola|hasło)\s*[:=]\s*([^\s<>"']{2,64})/giu;

/** Candidate archive passwords written in the text ("Password: abc", "Contraseña = xyz"). */
export function findPasswords(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(PASSWORD_RE)) {
    const value = m[1]!.replace(/[),.;!?\]]+$/, "");
    if (value.length >= 2 && !/^\*+$/.test(value) && !out.includes(value)) out.push(value);
  }
  return out;
}

function stripExtension(name: string): string {
  return name.replace(/\.[a-z0-9]{1,5}$/i, "");
}

export interface GrabOptions {
  /** Page address, or "clipboard". */
  source: string;
  /** Text around the links (page text, or the copied text), searched for passwords. */
  text?: string;
  now: number;
  newId: () => string;
  /** Links the person picked one by one: an ordinary page is kept, and the queue looks for its file. */
  all?: boolean;
}

/**
 * Turns links into packages: the volumes of a split archive (and its .sfv/.md5) form one package
 * named after the archive, other files one package each; hoster links without a file name share a
 * package named after the source. Ordinary page links are left out.
 */
export function buildPackages(urls: readonly string[], opts: GrabOptions): GrabbedPackage[] {
  const passwords = findPasswords(opts.text ?? "");
  const packages = new Map<string, GrabbedPackage>();
  const seen = new Set<string>();
  for (const raw of urls) {
    const kind = classifyLink(raw) ?? (opts.all && /^https?:\/\//i.test(raw) ? "hoster" : null);
    if (!kind || seen.has(raw)) continue;
    seen.add(raw);
    const url = new URL(raw);
    // A hoster address often ends in an id, not a file name: the name is learnt when it downloads.
    const named = filenameOf(raw);
    const filename = kind === "hoster" && !FILE_EXT.test(named) && !splitArchive(named) ? "" : named;
    const split = splitArchive(filename);
    // name.rar is also the first volume of an old-style set (name.r00, ...): grouped below by base.
    const base = split?.base ?? (filename ? stripExtension(filename) : `Links from ${hostOf(url)}`);
    const key = base.toLowerCase();
    let pkg = packages.get(key);
    if (!pkg) {
      pkg = { id: opts.newId(), name: base, source: opts.source, links: [], passwords, addedAt: opts.now };
      packages.set(key, pkg);
    }
    pkg.links.push({ id: opts.newId(), url: raw, filename, kind, host: hostOf(url), ...(split ? { part: split.part } : /\.rar$/i.test(filename) ? { part: 1 } : {}) });
  }
  for (const pkg of packages.values()) pkg.links.sort((a, b) => (a.part ?? 0) - (b.part ?? 0) || a.filename.localeCompare(b.filename));
  return [...packages.values()];
}

/** Adds packages to the grabber list, merging links into a package of the same name and skipping known links. */
export function mergePackages(list: readonly GrabbedPackage[], added: readonly GrabbedPackage[]): GrabbedPackage[] {
  const known = new Set(list.flatMap((p) => p.links.map((l) => l.url)));
  const out = list.map((p) => ({ ...p, links: [...p.links], passwords: [...p.passwords] }));
  for (const pkg of added) {
    const links = pkg.links.filter((l) => !known.has(l.url));
    if (links.length === 0) continue;
    for (const l of links) known.add(l.url);
    const same = out.find((p) => p.name.toLowerCase() === pkg.name.toLowerCase());
    if (same) {
      same.links.push(...links);
      same.links.sort((a, b) => (a.part ?? 0) - (b.part ?? 0) || a.filename.localeCompare(b.filename));
      for (const pw of pkg.passwords) if (!same.passwords.includes(pw)) same.passwords.push(pw);
    } else {
      out.push({ ...pkg, links });
    }
  }
  return out;
}

/** How many grabbed links in copied text are worth offering (the toolbar chip shows it). */
export function downloadLinksIn(text: string): string[] {
  return extractUrls(text).filter((u) => classifyLink(u) !== null);
}
