/**
 * Downloads an AI agent asks for: the links it found (from the Command Bar agent's queue_downloads
 * tool or an MCP client's download_queue_add), checked and turned into download-queue packages, and
 * the task Corvus hands its own agent for "Download with AI". Pure, so the rules are unit tested.
 */
import { isExecutableFilename } from "./downloads";
import { isHosterDownloadLink } from "./hosters";
import { filenameOf, splitArchive, type GrabbedLink, type GrabbedPackage } from "./link-grabber";

export const MAX_AGENT_LINKS = 200;

/** What an agent asked to download. */
export interface AgentDownloadRequest {
  links: string[];
  /** Name of the package (folder); default: the archive or file name. */
  packageName?: string;
  /** Archive password the page gave, tried first when extracting. */
  password?: string;
}

/** Validates an agent's request: http(s) links only, no repeats, bounded sizes. Throws on bad input. */
export function parseAgentDownloadRequest(input: unknown): AgentDownloadRequest {
  const raw = (input ?? {}) as { links?: unknown; packageName?: unknown; password?: unknown };
  if (!Array.isArray(raw.links) || raw.links.length === 0) throw new Error("links must be a non-empty list of http(s) URLs");
  if (raw.links.length > MAX_AGENT_LINKS) throw new Error(`At most ${MAX_AGENT_LINKS} links at once`);
  const links: string[] = [];
  for (const link of raw.links) {
    if (typeof link !== "string" || link.length > 8192) throw new Error("Every link must be an http(s) URL");
    let url: URL;
    try {
      url = new URL(link.trim());
    } catch {
      throw new Error(`Not a URL: ${link.slice(0, 200)}`);
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`Not an http(s) URL: ${link.slice(0, 200)}`);
    if (!links.includes(url.href)) links.push(url.href);
  }
  const text = (value: unknown, name: string, max: number): string | undefined => {
    if (value === undefined || value === null || value === "") return undefined;
    if (typeof value !== "string" || value.length > max) throw new Error(`${name} must be text of at most ${max} characters`);
    return value.trim() || undefined;
  };
  const packageName = text(raw.packageName, "packageName", 120);
  const password = text(raw.password, "password", 200);
  return { links, ...(packageName ? { packageName } : {}), ...(password ? { password } : {}) };
}

/** Programs an agent may not queue: the person downloads those themselves. */
export function splitAgentLinks(links: readonly string[]): { allowed: string[]; refused: string[] } {
  const allowed: string[] = [];
  const refused: string[] = [];
  for (const link of links) (isExecutableFilename(filenameOf(link)) ? refused : allowed).push(link);
  return { allowed, refused };
}

function stripExtension(name: string): string {
  return name.replace(/\.[a-z0-9]{1,5}$/i, "");
}

/**
 * Packages for links an agent says are files. A file host's download server (a CDN link of a hoster)
 * is a file; a host's file page (mega.nz/file/…) is resolved by the queue like a grabbed one. The
 * volumes of one archive share a package; with a package name, every link goes into that one package.
 */
export function agentPackages(request: AgentDownloadRequest, opts: { source: string; now: number; newId: () => string }): GrabbedPackage[] {
  const packages = new Map<string, GrabbedPackage>();
  const passwords = request.password ? [request.password] : [];
  for (const raw of request.links) {
    const url = new URL(raw);
    const filename = filenameOf(raw);
    const split = splitArchive(filename);
    const name = request.packageName ?? split?.base ?? (filename ? stripExtension(filename) : `Files from ${url.hostname.replace(/^www\./, "")}`);
    const key = name.toLowerCase();
    let pkg = packages.get(key);
    if (!pkg) {
      pkg = { id: opts.newId(), name, source: opts.source, links: [], passwords, addedAt: opts.now };
      packages.set(key, pkg);
    }
    const link: GrabbedLink = {
      id: opts.newId(),
      url: raw,
      filename,
      // A host's file page (mega.nz/file/…) is still resolved by the queue.
      kind: isHosterDownloadLink(raw) ? "hoster" : split ? "archive-part" : "file",
      host: url.hostname.replace(/^www\./, "").toLowerCase(),
      ...(split ? { part: split.part } : /\.rar$/i.test(filename) ? { part: 1 } : {}),
    };
    pkg.links.push(link);
  }
  for (const pkg of packages.values()) pkg.links.sort((a, b) => (a.part ?? 0) - (b.part ?? 0) || a.filename.localeCompare(b.filename));
  return [...packages.values()];
}

/** One line per file for an approval prompt: "Movie.part1.rar (example.com)", at most `max`. */
export function describeAgentLinks(links: readonly string[], max = 12): string {
  const lines = links.slice(0, max).map((l) => {
    const url = new URL(l);
    return `${filenameOf(l) || url.pathname || l} (${url.hostname})`;
  });
  if (links.length > max) lines.push(`and ${links.length - max} more`);
  return lines.join("\n");
}

const TASK_MAX = 2000;

/**
 * The task Corvus gives its own agent for "Download with AI": what to download (a page, links from the
 * grabber, or copied text) and the password already known, within the Command Bar's task limit.
 */
export function downloadAiTask(input: { pageUrl?: string; links?: readonly string[]; text?: string; packageName?: string; passwords?: readonly string[] }): string {
  const parts: string[] = [];
  if (input.pageUrl) parts.push(`Download the files offered on ${input.pageUrl}.`);
  else parts.push(input.packageName ? `Download "${input.packageName}".` : "Download these files.");
  parts.push("Find each file's real download link (through file-host pages and mirrors) and queue them with queue_downloads.");
  if (input.passwords?.length) parts.push(`Archive password: ${input.passwords.join(" or ")}.`);
  let task = parts.join(" ");
  const tail: string[] = [];
  if (input.links?.length) tail.push("Links:", ...input.links);
  else if (input.text) tail.push("Copied text:", input.text);
  for (const line of tail) {
    if (task.length + line.length + 1 > TASK_MAX) break;
    task += `\n${line}`;
  }
  return task;
}
