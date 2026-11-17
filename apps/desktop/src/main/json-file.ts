import fs from "node:fs";
import path from "node:path";

/**
 * A JSON document persisted atomically (write to temp file + rename) with debounced saves.
 * Chosen over SQLite so the app has no native modules to rebuild per Electron ABI and can be
 * cross-built for Windows from a Linux container.
 */
export class JsonFile<T> {
  private timer: NodeJS.Timeout | null = null;
  private dirty = false;

  constructor(
    readonly filePath: string,
    private value: T,
    private readonly debounceMs = 250,
    /**
     * The file was missing or unreadable when loaded, so the value started from the fallback. A
     * synced store must then not report what it lacks as deleted (see sync-adapters.ts).
     */
    readonly fresh = false,
    /** False when an unreadable file could not be moved aside: it is then never written over. */
    private readonly writable = true,
  ) {}

  static load<T>(filePath: string, fallback: () => T, revive: (raw: unknown) => T = (raw) => raw as T, debounceMs = 250): JsonFile<T> {
    try {
      return new JsonFile(filePath, revive(JSON.parse(fs.readFileSync(filePath, "utf8"))), debounceMs);
    } catch (err) {
      let writable = true;
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        const backup = `${filePath}.corrupt-${Date.now()}`;
        try {
          fs.renameSync(filePath, backup);
          console.warn(`[corvus] ${filePath} was unreadable, moved to ${backup}`);
        } catch {
          // Still there (locked, or no rights): writing would destroy what it holds.
          writable = !fs.existsSync(filePath);
          if (!writable) console.warn(`[corvus] ${filePath} is unreadable and left as it is: changes to it are not saved until Corvus restarts`);
        }
      }
      return new JsonFile(filePath, fallback(), debounceMs, true, writable);
    }
  }

  get(): T {
    return this.value;
  }

  set(value: T): void {
    this.value = value;
    this.dirty = true;
    if (this.debounceMs === 0) {
      this.flush();
      return;
    }
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, this.debounceMs);
  }

  update(fn: (current: T) => T): T {
    this.set(fn(this.value));
    return this.value;
  }

  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.dirty || !this.writable) return;
    this.dirty = false;
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.value), "utf8");
    fs.renameSync(tmp, this.filePath);
  }
}
