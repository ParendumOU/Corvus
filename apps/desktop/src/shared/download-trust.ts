/**
 * Programs in downloads: the file types Corvus warns about, the ones the person trusts (from one
 * site or from any site), what it learns from their Keep choices, who started a download in a tab
 * an AI agent drives, and what becomes of the tab a download came from. Pure and unit tested.
 */

export type DangerousTypeGroupId = "windows" | "scripts" | "java" | "system" | "mac-linux" | "android";

export interface DangerousTypeGroup {
  id: DangerousTypeGroupId;
  extensions: readonly string[];
}

/** File types that run code when opened, by kind (the settings page says why each kind is risky). */
export const DANGEROUS_TYPE_GROUPS: readonly DangerousTypeGroup[] = [
  { id: "windows", extensions: ["exe", "msi", "msix", "msixbundle", "appx", "appxbundle", "com", "scr", "pif", "application", "gadget", "msp", "mst"] },
  { id: "scripts", extensions: ["bat", "cmd", "ps1", "psm1", "vbs", "vbe", "js", "jse", "wsf", "wsh", "hta", "sh", "bash", "zsh", "command", "py", "pyw", "pl", "rb"] },
  { id: "java", extensions: ["jar"] },
  { id: "system", extensions: ["lnk", "reg", "dll", "sys", "inf", "cpl"] },
  { id: "mac-linux", extensions: ["app", "dmg", "pkg", "mpkg", "deb", "rpm", "appimage", "snap", "flatpakref", "run", "bin"] },
  { id: "android", extensions: ["apk", "xapk"] },
];

const DANGEROUS = new Set(DANGEROUS_TYPE_GROUPS.flatMap((g) => g.extensions));

/** "Report.PDF " -> "pdf", ".bashrc" -> "bashrc", "README" -> "". */
export function fileExtension(name: string): string {
  const base = name.trim().toLowerCase().replace(/[.\s]+$/, "");
  const dot = base.lastIndexOf(".");
  return dot < 0 ? "" : base.slice(dot + 1);
}

export function isDangerousExtension(ext: string): boolean {
  return DANGEROUS.has(ext);
}

/** A file type the person keeps without being asked. `site` "" = from any site. */
export interface TrustedType {
  ext: string;
  site: string;
  addedAt: number;
}

export interface DownloadChoices {
  /** Newest first. */
  trusted: TrustedType[];
  /** How often the person kept a warned-about file: extension -> site ("" = none) -> times. */
  keeps: Record<string, Record<string, number>>;
}

/** "Always keep" scope: the site the file comes from, or any site. */
export type TrustScope = "site" | "any";

/** Keeps of one type after which the next warning offers "Always keep" already ticked. */
export const KEEPS_TO_SUGGEST = 2;
const MAX_TRUSTED = 500;
const MAX_SITES_PER_TYPE = 50;

export function emptyDownloadChoices(): DownloadChoices {
  return { trusted: [], keeps: {} };
}

/** The site a download comes from, for trust: its host without "www." ("" for data: and the like). */
export function downloadSite(url: string): string {
  try {
    let u = new URL(url);
    if (u.protocol === "blob:") u = new URL(u.pathname);
    if (!/^(https?|ftp):$/.test(u.protocol)) return "";
    return u.hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

/** A type typed in Settings (".JAR", "*.jar", "jar") as stored, or null when Corvus does not warn about it. */
export function cleanExtension(input: string): string | null {
  const ext = input.trim().toLowerCase().replace(/^\*?\./, "");
  return isDangerousExtension(ext) ? ext : null;
}

/** A site typed in Settings ("https://www.example.com/x", "*.example.com") as stored; "" = any site; null when it is not one. */
export function cleanSite(input: string): string | null {
  const raw = input.trim().toLowerCase().replace(/^\*\./, "");
  if (raw === "") return "";
  return downloadSite(/^[a-z][a-z0-9+.-]*:\/\//.test(raw) ? raw : `https://${raw}`) || null;
}

/** A trusted site covers itself and its subdomains; "" covers every site. */
export function siteMatches(trusted: string, site: string): boolean {
  return trusted === "" || site === trusted || site.endsWith(`.${trusted}`);
}

export function isTrusted(choices: DownloadChoices, ext: string, site: string): boolean {
  return choices.trusted.some((t) => t.ext === ext && siteMatches(t.site, site));
}

export function trustType(choices: DownloadChoices, ext: string, site: string, now: number): DownloadChoices {
  const rest = choices.trusted.filter((t) => t.ext !== ext || t.site !== site);
  return { ...choices, trusted: [{ ext, site, addedAt: now }, ...rest].slice(0, MAX_TRUSTED) };
}

export function untrustType(choices: DownloadChoices, ext: string, site: string): DownloadChoices {
  return { ...choices, trusted: choices.trusted.filter((t) => t.ext !== ext || t.site !== site) };
}

/** The person kept a file Corvus warned about. */
export function recordKeep(choices: DownloadChoices, ext: string, site: string): DownloadChoices {
  const counts = { ...(choices.keeps[ext] ?? {}) };
  counts[site] = (counts[site] ?? 0) + 1;
  const sites = Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_SITES_PER_TYPE);
  return { ...choices, keeps: { ...choices.keeps, [ext]: Object.fromEntries(sites) } };
}

/**
 * What the next warning for a type offers: "Always keep" ticked once the person kept that type
 * twice (they still confirm it with Keep), from any site once they kept it from two sites.
 */
export function keepSuggestion(choices: DownloadChoices, ext: string): { ticked: boolean; scope: TrustScope } {
  const counts = choices.keeps[ext] ?? {};
  const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
  const sites = Object.keys(counts).filter((s) => s !== "").length;
  return { ticked: total >= KEEPS_TO_SUGGEST, scope: sites >= 2 ? "any" : "site" };
}

export function reviveDownloadChoices(raw: unknown): DownloadChoices {
  const r = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const trusted: TrustedType[] = [];
  for (const t of Array.isArray(r.trusted) ? r.trusted : []) {
    if (typeof t !== "object" || t === null) continue;
    const { ext, site, addedAt } = t as Record<string, unknown>;
    if (typeof ext !== "string" || !isDangerousExtension(ext) || typeof site !== "string" || cleanSite(site) !== site) continue;
    if (trusted.some((x) => x.ext === ext && x.site === site)) continue;
    trusted.push({ ext, site, addedAt: typeof addedAt === "number" && Number.isFinite(addedAt) ? addedAt : 0 });
  }
  const keeps: Record<string, Record<string, number>> = {};
  const rawKeeps = typeof r.keeps === "object" && r.keeps !== null ? (r.keeps as Record<string, unknown>) : {};
  for (const [ext, sites] of Object.entries(rawKeeps)) {
    if (!isDangerousExtension(ext) || typeof sites !== "object" || sites === null) continue;
    const counts = Object.entries(sites as Record<string, unknown>).filter((e): e is [string, number] => typeof e[1] === "number" && e[1] > 0 && Number.isFinite(e[1]));
    if (counts.length > 0) keeps[ext] = Object.fromEntries(counts.slice(0, MAX_SITES_PER_TYPE).map(([s, n]) => [s, Math.floor(n)]));
  }
  return { trusted: trusted.slice(0, MAX_TRUSTED), keeps };
}

// ------------------------------------------------------------------ downloads from tabs

/** What decides whose a download from a tab is. */
export interface TabActivity {
  agentControlled: boolean;
  /** The person's last click or key press in it (none while an agent acts). */
  personInputAt?: number;
  /** The last time an agent acted on it. */
  agentActedAt?: number;
}

/** A tab has a page of its own once one committed; the blank page a new tab starts on does not count. */
export function hasOwnPage(pageUrl: string | undefined): boolean {
  return pageUrl !== undefined && pageUrl !== "about:blank";
}

/**
 * Whether a download from a tab an AI agent drives is the agent's doing. The person's own click or
 * key press after the agent's last action makes it theirs: in the tab itself, or, for a tab without
 * a page yet (a link opened in a new tab), in the tab it was opened from. Without one it is the agent's.
 */
export function downloadedByAgent(tab: TabActivity, hasPage: boolean, opener?: TabActivity): boolean {
  if (!tab.agentControlled) return false;
  const source = hasPage ? tab : opener;
  if (source?.personInputAt === undefined) return true;
  const agentAt = Math.max(tab.agentActedAt ?? 0, hasPage ? 0 : (opener?.agentActedAt ?? 0));
  return source.personInputAt <= agentAt;
}

export interface DownloadTabFacts {
  /** What its address bar says. */
  url: string;
  /** The page it shows, once one committed. */
  pageUrl?: string;
  active: boolean;
  /** The tab it was opened from, while that one is open. */
  openerId?: string;
  /** The only tab of its window. */
  onlyTab: boolean;
}

export type DownloadTabStep =
  /** It was opened only for the file: it closes, and the tab it came from is shown again when it was shown. */
  | { kind: "close"; activate?: string }
  /** The same, but it is its window's only tab: it shows the New Tab page instead. */
  | { kind: "new-tab" }
  /** It has a page: the address bar goes back to that page's address. */
  | { kind: "restore"; url: string }
  | { kind: "keep" };

/** What becomes of a tab once a navigation in it turned into a download (Chrome does the same). */
export function downloadTabStep(f: DownloadTabFacts): DownloadTabStep {
  if (hasOwnPage(f.pageUrl)) return f.url === f.pageUrl ? { kind: "keep" } : { kind: "restore", url: f.pageUrl as string };
  if (f.onlyTab) return { kind: "new-tab" };
  return { kind: "close", ...(f.active && f.openerId ? { activate: f.openerId } : {}) };
}
