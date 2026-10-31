/**
 * Passwords a browser protects itself (Chrome's app-bound encryption, a Firefox primary password)
 * come in through the browser's own export, guided from the same Import click: Corvus opens the
 * browser's password page, then, only while the person is on it and for a few minutes at most, looks
 * in Downloads for a new CSV whose header is a password export. It imports that file through the one
 * merge path and, unless the person unticked it, deletes it for good (it holds the passwords in plain
 * text). Nothing runs in the background otherwise; the person can also pick the file by hand.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { passwordExportPage, type PasswordImportSummary } from "../shared/browser-import";
import { isPasswordCsvHeader, parsePasswordCsv } from "../shared/password-import";
import type { BrowserImport } from "./browser-import";
import type { BrowserPasswords } from "./browser-passwords";
import type { ProfileRuntime } from "./profiles";

/** How long Corvus looks for the export after the person opened the browser's page. */
export const EXPORT_WAIT_MS = 5 * 60_000;
/** Larger files are not password exports. */
const MAX_CSV_BYTES = 50 * 1024 * 1024;

const WINDOWS_PATHS: Record<string, Array<[root: "pf" | "pf86" | "local", ...parts: string[]]>> = {
  chrome: [["pf", "Google", "Chrome", "Application", "chrome.exe"], ["pf86", "Google", "Chrome", "Application", "chrome.exe"], ["local", "Google", "Chrome", "Application", "chrome.exe"]],
  edge: [["pf86", "Microsoft", "Edge", "Application", "msedge.exe"], ["pf", "Microsoft", "Edge", "Application", "msedge.exe"]],
  brave: [["pf", "BraveSoftware", "Brave-Browser", "Application", "brave.exe"], ["local", "BraveSoftware", "Brave-Browser", "Application", "brave.exe"]],
  vivaldi: [["local", "Vivaldi", "Application", "vivaldi.exe"], ["pf", "Vivaldi", "Application", "vivaldi.exe"]],
  opera: [["local", "Programs", "Opera", "opera.exe"]],
  "opera-gx": [["local", "Programs", "Opera GX", "opera.exe"]],
  chromium: [["local", "Chromium", "Application", "chrome.exe"]],
  firefox: [["pf", "Mozilla Firefox", "firefox.exe"], ["pf86", "Mozilla Firefox", "firefox.exe"]],
};
const MAC_APPS: Record<string, string> = { chrome: "Google Chrome", edge: "Microsoft Edge", brave: "Brave Browser", vivaldi: "Vivaldi", opera: "Opera", "opera-gx": "Opera GX", chromium: "Chromium", firefox: "Firefox" };
const LINUX_BINARIES: Record<string, string[]> = {
  chrome: ["google-chrome", "google-chrome-stable"],
  edge: ["microsoft-edge", "microsoft-edge-stable"],
  brave: ["brave-browser", "brave"],
  vivaldi: ["vivaldi", "vivaldi-stable"],
  opera: ["opera"],
  chromium: ["chromium", "chromium-browser"],
  "chromium-snap": ["chromium"],
  firefox: ["firefox"],
};

/** How to open `sourceId` at its password page on this system, or null when it is not found. */
export function browserCommand(
  sourceId: string,
  platform: string,
  env: Record<string, string | undefined>,
  isFile: (p: string) => boolean,
): { file: string; args: string[] } | null {
  const page = passwordExportPage(sourceId);
  const id = sourceId.startsWith("firefox") ? "firefox" : sourceId;
  if (platform === "win32") {
    const roots = { pf: env.ProgramFiles ?? "C:\\Program Files", pf86: env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", local: env.LOCALAPPDATA ?? "" };
    for (const [root, ...parts] of WINDOWS_PATHS[id] ?? []) {
      if (!roots[root]) continue;
      const file = path.win32.join(roots[root], ...parts);
      if (isFile(file)) return { file, args: [page] };
    }
    return null;
  }
  if (platform === "darwin") return MAC_APPS[id] ? { file: "/usr/bin/open", args: ["-a", MAC_APPS[id]!, page] } : null;
  for (const name of LINUX_BINARIES[id] ?? []) {
    for (const dir of (env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
      const file = path.join(dir, name);
      if (isFile(file)) return { file, args: [page] };
    }
  }
  return null;
}

const isFile = (p: string): boolean => {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
};

/** Opens the browser (no shell). False when it is not found or does not start. */
function openBrowser(sourceId: string): boolean {
  const command = browserCommand(sourceId, process.platform, process.env, isFile);
  if (!command) return false;
  try {
    spawn(command.file, command.args, { detached: true, stdio: "ignore" }).unref();
    return true;
  } catch {
    return false;
  }
}

const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });

/**
 * The first CSV that appears in `dir` after `since` and starts with a password export's header, once
 * its size has settled; null on timeout or abort. Other files are never read past their first bytes.
 */
export async function waitForExport(dir: string, since: number, opts: { signal: AbortSignal; timeoutMs?: number; pollMs?: number; now?: () => number }): Promise<string | null> {
  const now = opts.now ?? Date.now;
  const pollMs = opts.pollMs ?? 1000;
  const until = now() + (opts.timeoutMs ?? EXPORT_WAIT_MS);
  const ruledOut = new Set<string>();
  const sizes = new Map<string, number>();
  while (!opts.signal.aborted && now() < until) {
    const names = await fs.promises.readdir(dir).catch(() => [] as string[]);
    for (const name of names) {
      if (!/\.csv$/i.test(name) || ruledOut.has(name)) continue;
      const file = path.join(dir, name);
      const stat = await fs.promises.stat(file).catch(() => null);
      if (!stat?.isFile() || stat.mtimeMs < since - 2000 || stat.size > MAX_CSV_BYTES) {
        ruledOut.add(name);
        continue;
      }
      if (stat.size === 0) continue;
      // Wait one more look for the browser to finish writing.
      if (sizes.get(name) !== stat.size) {
        sizes.set(name, stat.size);
        continue;
      }
      const head = await readHead(file);
      if (head !== null && isPasswordCsvHeader(head)) return file;
      ruledOut.add(name);
    }
    await sleep(pollMs, opts.signal);
  }
  return null;
}

async function readHead(file: string): Promise<string | null> {
  const handle = await fs.promises.open(file, "r").catch(() => null);
  if (!handle) return null;
  try {
    const buf = Buffer.alloc(4096);
    const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
    return buf.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

export interface CsvImport {
  summary: PasswordImportSummary;
  /** The file's name (no folder), and whether Corvus deleted it. */
  file: string;
  deleted: boolean;
}

/** Imports a password export through the one merge path, then deletes it when asked. */
export async function importPasswordCsv(imports: BrowserImport, runtime: ProfileRuntime, file: string, deleteAfter: boolean, browser?: string): Promise<CsvImport> {
  const parsed = parsePasswordCsv(await fs.promises.readFile(file, "utf8"));
  const read: BrowserPasswords = { logins: parsed.logins, protected: [], skipped: parsed.skippedRows.map((r) => ({ site: r.site, username: r.username, reason: r.reason })) };
  const summary = imports.mergePasswords(runtime, read, browser);
  let deleted = false;
  if (deleteAfter) {
    try {
      await fs.promises.rm(file, { force: true });
      deleted = !fs.existsSync(file);
    } catch {
      deleted = false;
    }
  }
  return { summary, file: path.basename(file), deleted };
}

export type ExportOutcome = { status: "imported"; opened: boolean; import: CsvImport } | { status: "timeout" | "canceled"; opened: boolean };

/** One guided export at a time, started by the person's click. */
export class PasswordExports {
  private running: AbortController | null = null;
  private testOpen: ((sourceId: string) => boolean) | null = null;
  private testDownloads: string | null = null;

  constructor(private readonly downloads: () => string) {}

  /** Tests replace opening the browser (no real browser ever starts) and the Downloads folder. */
  setTest(open: ((sourceId: string) => boolean) | null, downloads: string | null): void {
    this.testOpen = open;
    this.testDownloads = downloads;
  }

  async run(imports: BrowserImport, runtime: ProfileRuntime, source: { id: string; name: string }, deleteAfter: boolean, timeoutMs = EXPORT_WAIT_MS): Promise<ExportOutcome> {
    this.cancel();
    const controller = new AbortController();
    this.running = controller;
    const since = Date.now();
    try {
      const opened = (this.testOpen ?? openBrowser)(source.id);
      const file = await waitForExport(this.testDownloads ?? this.downloads(), since, { signal: controller.signal, timeoutMs });
      if (!file) return { status: controller.signal.aborted ? "canceled" : "timeout", opened };
      return { status: "imported", opened, import: await importPasswordCsv(imports, runtime, file, deleteAfter, source.name) };
    } finally {
      if (this.running === controller) this.running = null;
    }
  }

  cancel(): void {
    this.running?.abort();
    this.running = null;
  }
}
