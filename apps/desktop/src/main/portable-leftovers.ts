import fs from "node:fs";
import path from "node:path";

const APP_EXE = "Corvus.exe";
const MIN_AGE_MS = 60 * 60 * 1000;

/**
 * What older portable launchers left in the temp folder when they were stopped before cleaning up
 * (Windows shutting down with Corvus open, a killed launcher), about half a gigabyte each: the
 * unpacked app (a 27-character build id holding Corvus.exe and its app.asar) and the launcher's
 * own work folder (ns*.tmp holding 7z-out\Corvus.exe). Launchers now unpack each build once, into
 * %LOCALAPPDATA%\Corvus-portable, and leave nothing behind.
 */
export function isPortableLeftover(name: string, exists: (relative: string) => boolean): boolean {
  if (/^ns[0-9a-z]+\.tmp$/i.test(name)) return exists(path.join("7z-out", APP_EXE));
  if (/^[0-9A-Za-z]{27}$/.test(name)) return exists(APP_EXE) && exists(path.join("resources", "app.asar"));
  return false;
}

/**
 * Removes those folders once they are an hour old (a launcher or installer at work uses a newer
 * one) and no Corvus runs from them. Returns how many it removed. In Electron, `files` must be
 * original-fs: Electron's own fs reads app.asar files as folders and cannot delete them.
 */
export async function removePortableLeftovers(tempDir: string, files: typeof fs = fs, now = Date.now()): Promise<number> {
  let entries: fs.Dirent[];
  try {
    entries = await files.promises.readdir(tempDir, { withFileTypes: true });
  } catch {
    return 0;
  }
  let removed = 0;
  for (const entry of entries) {
    const dir = path.join(tempDir, entry.name);
    if (!entry.isDirectory() || !isPortableLeftover(entry.name, (relative) => files.existsSync(path.join(dir, relative)))) continue;
    try {
      if (now - (await files.promises.stat(dir)).mtimeMs < MIN_AGE_MS || (await inUse(files, path.join(dir, APP_EXE)))) continue;
      await files.promises.rm(dir, { recursive: true, force: true });
      removed++;
    } catch {
      // Left for the next start.
    }
  }
  return removed;
}

/** Windows refuses to open a running program's file for writing. */
async function inUse(files: typeof fs, file: string): Promise<boolean> {
  try {
    await (await files.promises.open(file, "r+")).close();
    return false;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "ENOENT";
  }
}
