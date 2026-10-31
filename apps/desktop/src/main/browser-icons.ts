import { execFile } from "node:child_process";
import fs from "node:fs";
import { WINDOWS_APP_PATHS, browserIconSources, desktopEntryIcon, linuxIconFiles, parseRegDefault, type IconRoots } from "../shared/browser-icons";

/** Makes a small PNG data URL: Electron's in the app, a fake in tests; null when there is no picture. */
export interface IconLoader {
  /** The icon the system shows for a program (a Windows .exe, a macOS .app). */
  program(file: string): Promise<string | null>;
  /** A picture file (a Linux icon theme's PNG). */
  image(file: string): Promise<string | null>;
}

interface Entry {
  /** The program or picture the icon came from; null when none was found. */
  path: string | null;
  icon: string | null;
  at: number;
}

/** A browser whose icon was not found is looked for again after this (it may be installed meanwhile). */
const LOOK_AGAIN_MS = 10 * 60_000;

const exists = (file: string): boolean => {
  try {
    return fs.statSync(file).size > 0;
  } catch {
    return false;
  }
};

const readText = (file: string): string | null => {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
};

/** Windows: where App Paths says a program is (per user, for everyone, then the 32-bit view). */
function appPath(exe: string): Promise<string | null> {
  const key = `SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${exe}`;
  const query = (args: string[]): Promise<string | null> =>
    new Promise((resolve) => execFile("reg", ["query", ...args, "/ve"], { windowsHide: true, timeout: 5000 }, (err, stdout) => resolve(err ? null : parseRegDefault(String(stdout)))));
  return [[`HKCU\\${key}`], [`HKLM\\${key}`], [`HKLM\\${key}`, "/reg:32"]].reduce<Promise<string | null>>((found, args) => found.then((p) => p ?? query(args)), Promise.resolve(null));
}

/**
 * The other browsers' own small icons, for the mark that says a page came from Chrome or Firefox,
 * taken from the browser installed on this computer (never bundled): a PNG data URL per browser,
 * looked up once per run and again when its program moved or went away. A browser without one
 * keeps its letter mark.
 */
export class BrowserIcons {
  private readonly known = new Map<string, Entry>();
  private readonly pending = new Map<string, Promise<Entry>>();

  constructor(
    private readonly roots: () => IconRoots,
    private readonly loader: IconLoader,
    private readonly registry: (exe: string) => Promise<string | null> = appPath,
  ) {}

  /** The icons found for these browsers (by the mark of their pages), as PNG data URLs. */
  async icons(marks: Iterable<string>): Promise<Record<string, string>> {
    const found: Record<string, string> = {};
    await Promise.all(
      [...new Set(marks)].map(async (mark) => {
        const icon = (await this.entry(mark)).icon;
        if (icon) found[mark] = icon;
      }),
    );
    return found;
  }

  private async entry(mark: string): Promise<Entry> {
    const roots = this.roots();
    // Other roots (a test's fake browsers) are another computer as far as the cache goes.
    const key = `${roots.platform}\0${roots.home}\0${mark}`;
    const known = this.known.get(key);
    if (known && (known.path ? exists(known.path) : Date.now() - known.at < LOOK_AGAIN_MS)) return known;
    let pending = this.pending.get(key);
    if (!pending) {
      pending = this.find(mark, roots).finally(() => this.pending.delete(key));
      this.pending.set(key, pending);
    }
    const entry = await pending;
    this.known.set(key, entry);
    return entry;
  }

  private async find(mark: string, r: IconRoots): Promise<Entry> {
    const at = Date.now();
    if (r.platform !== "win32" && r.platform !== "darwin") {
      for (const entryFile of browserIconSources(mark, r)) {
        const name = desktopEntryIcon(readText(entryFile) ?? "");
        const file = name ? linuxIconFiles(name, r).find(exists) : undefined;
        const icon = file ? await this.loader.image(file).catch(() => null) : null;
        if (file && icon) return { path: file, icon, at };
      }
      return { path: null, icon: null, at };
    }
    let program = browserIconSources(mark, r).find(exists) ?? null;
    const exe = WINDOWS_APP_PATHS[mark];
    if (!program && r.platform === "win32" && exe) program = await this.registry(exe).catch(() => null);
    if (!program || !exists(program)) return { path: null, icon: null, at };
    return { path: program, icon: await this.loader.program(program).catch(() => null), at };
  }
}
