/**
 * Archive reconstruction for the download queue: which downloaded files make up one archive (its
 * volumes, first one first), which passwords to try and in what order, and what 7-Zip's output
 * says. Pure, so the naming rules are unit tested; 7-Zip itself runs in main/archive-extractor.ts.
 */

export type ArchiveKind = "rar" | "7z" | "zip" | "split";

export interface ArchiveSet {
  /** The file 7-Zip opens: the first volume. */
  entry: string;
  kind: ArchiveKind;
  /** Every file of the archive, the entry first. */
  volumes: string[];
}

interface Volume {
  key: string;
  kind: ArchiveKind;
  /** Order within the archive; the entry is the lowest. */
  order: number;
  /** Whether this volume is the one 7-Zip opens. */
  first: boolean;
  /** The name shared by every volume, for passwords named after the archive. */
  base: string;
}

/** The archive a file is a volume of, or null when it is not one. */
function volumeOf(filename: string): Volume | null {
  const name = filename.toLowerCase();
  let m: RegExpExecArray | null;
  // name.part1.rar, name.part01.rar, ...
  if ((m = /^(.+)\.part(\d+)\.rar$/.exec(name))) {
    const n = Number(m[2]);
    return { key: `rar-parts:${m[1]}`, kind: "rar", order: n, first: n === 1, base: filename.slice(0, m[1]!.length) };
  }
  // name.rar, then name.r00, name.r01, ...
  if ((m = /^(.+)\.rar$/.exec(name))) return { key: `rar:${m[1]}`, kind: "rar", order: -1, first: true, base: filename.slice(0, m[1]!.length) };
  if ((m = /^(.+)\.r(\d{2,3})$/.exec(name))) return { key: `rar:${m[1]}`, kind: "rar", order: Number(m[2]), first: false, base: filename.slice(0, m[1]!.length) };
  // name.zip, with name.z01, name.z02, ... for a spanned zip
  if ((m = /^(.+)\.zip$/.exec(name))) return { key: `zip:${m[1]}`, kind: "zip", order: -1, first: true, base: filename.slice(0, m[1]!.length) };
  if ((m = /^(.+)\.z(\d{2,3})$/.exec(name))) return { key: `zip:${m[1]}`, kind: "zip", order: Number(m[2]), first: false, base: filename.slice(0, m[1]!.length) };
  if ((m = /^(.+)\.7z$/.exec(name))) return { key: `7z:${m[1]}`, kind: "7z", order: 0, first: true, base: filename.slice(0, m[1]!.length) };
  // name.7z.001, name.zip.001, name.rar.001 and any other file cut into name.ext.001, .002, ...
  if ((m = /^(.+?)(\.(7z|zip|rar))?\.(\d{3})$/.exec(name))) {
    const n = Number(m[4]);
    const kind: ArchiveKind = m[3] === "7z" ? "7z" : m[3] === "zip" ? "zip" : m[3] === "rar" ? "rar" : "split";
    const joined = m[1]! + (m[2] ?? "");
    return { key: `split:${joined}`, kind, order: n, first: n === 1, base: filename.slice(0, m[1]!.length) };
  }
  return null;
}

/**
 * The archives among a package's files, each with its volumes. An archive whose first volume is
 * missing is left out (7-Zip can only open it from there).
 */
export function archiveSets(filenames: readonly string[]): ArchiveSet[] {
  const groups = new Map<string, Array<{ filename: string; volume: Volume }>>();
  for (const filename of filenames) {
    const volume = volumeOf(filename);
    if (!volume) continue;
    const list = groups.get(volume.key) ?? [];
    list.push({ filename, volume });
    groups.set(volume.key, list);
  }
  const out: ArchiveSet[] = [];
  for (const list of groups.values()) {
    list.sort((a, b) => a.volume.order - b.volume.order);
    const entry = list.find((v) => v.volume.first);
    if (!entry) continue;
    out.push({ entry: entry.filename, kind: entry.volume.kind, volumes: [entry.filename, ...list.filter((v) => v !== entry).map((v) => v.filename)] });
  }
  return out.sort((a, b) => a.entry.localeCompare(b.entry));
}

/** The name an archive's volumes share ("Movie" for "Movie.part1.rar"). */
export function archiveBase(entry: string): string {
  return volumeOf(entry)?.base ?? entry;
}

/** Saved archive passwords as kept in settings: trimmed, no blanks or repeats, a sane amount. */
export function cleanPasswords(passwords: readonly string[]): string[] {
  const out: string[] = [];
  for (const raw of passwords) {
    const p = raw.trim().slice(0, 200);
    if (p && !out.includes(p)) out.push(p);
  }
  return out.slice(0, 500);
}

/**
 * Passwords to try on a package's archives, in order: one you typed, the ones found next to the
 * links (page or copied text), the package and archive names, then your saved list.
 */
export function passwordCandidates(input: { typed?: string; found: readonly string[]; packageName: string; archives: readonly string[]; saved: readonly string[] }): string[] {
  return cleanPasswords([...(input.typed ? [input.typed] : []), ...input.found, input.packageName, ...input.archives.map(archiveBase), ...input.saved]);
}

/** 7-Zip says the password is wrong (or that it needs one to open the archive at all). */
export function isWrongPassword(lines: readonly string[]): boolean {
  return lines.some((l) => /wrong password|cannot open encrypted archive/i.test(l));
}

/** The first error 7-Zip reported, for a message (or a generic one). */
export function sevenZipError(lines: readonly string[], code: number): string {
  const line = lines.find((l) => /^ERROR:|^Can(no|')t |Unexpected end|Missing volume|is not archive|Headers Error|Data Error|CRC Failed/i.test(l.trim()));
  return line ? line.trim().replace(/^ERROR:\s*/i, "") : `7-Zip stopped with code ${code}`;
}

export interface ArchiveEntry {
  path: string;
  size: number;
  folder: boolean;
  encrypted: boolean;
}

/** The entries of `7z l -slt` output (the blocks after the "----------" line). */
export function parseListing(lines: readonly string[]): ArchiveEntry[] {
  const start = lines.findIndex((l) => l.trim() === "----------");
  if (start < 0) return [];
  const out: ArchiveEntry[] = [];
  let current: Record<string, string> = {};
  const flush = (): void => {
    if (current.Path !== undefined) {
      out.push({ path: current.Path, size: Number(current.Size) || 0, folder: current.Folder === "+" || /D/.test(current.Attributes ?? ""), encrypted: current.Encrypted === "+" });
    }
    current = {};
  };
  for (const line of lines.slice(start + 1)) {
    if (!line.trim()) {
      flush();
      continue;
    }
    const m = /^([A-Za-z ]+?) = (.*)$/.exec(line);
    if (m) current[m[1]!] = m[2]!;
  }
  flush();
  return out;
}
