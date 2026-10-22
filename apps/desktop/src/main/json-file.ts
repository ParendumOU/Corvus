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
  ) {}

  static load<T>(filePath: string, fallback: () => T, revive: (raw: unknown) => T = (raw) => raw as T, debounceMs = 250): JsonFile<T> {
    let value: T;
    try {
      value = revive(JSON.parse(fs.readFileSync(filePath, "utf8")));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        const backup = `${filePath}.corrupt-${Date.now()}`;
        try {
          fs.renameSync(filePath, backup);
          console.warn(`[corvus] ${filePath} was unreadable, moved to ${backup}`);
        } catch {
          // nothing to back up
        }
      }
      value = fallback();
    }
    return new JsonFile(filePath, value, debounceMs);
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
    if (!this.dirty) return;
    this.dirty = false;
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.value), "utf8");
    fs.renameSync(tmp, this.filePath);
  }
}
