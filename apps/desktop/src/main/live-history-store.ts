import path from "node:path";
import { JsonFile } from "./json-file";
import { cleanLiveHistoryConfig, defaultLiveHistoryConfig, type LiveCursor, type LiveHistoryConfig, type LiveHistoryPatch } from "../shared/live-history";

/** A profile's "Live history from other browsers": on or off, which browser profiles, and where it is in each. */
export class LiveHistoryStore {
  private readonly file: JsonFile<LiveHistoryConfig>;

  constructor(dir: string) {
    this.file = JsonFile.load(path.join(dir, "live-history.json"), defaultLiveHistoryConfig, cleanLiveHistoryConfig, 1000);
  }

  get(): LiveHistoryConfig {
    return this.file.get();
  }

  /** Browser profiles no longer followed lose their cursor: following one again starts afresh. */
  set(patch: LiveHistoryPatch): LiveHistoryConfig {
    const current = this.file.get();
    const next = cleanLiveHistoryConfig({ ...current, ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}), ...(patch.sources ? { sources: patch.sources } : {}) });
    this.file.set(next);
    this.file.flush();
    return next;
  }

  cursor(key: string): LiveCursor | undefined {
    return this.file.get().cursors[key];
  }

  setCursor(key: string, cursor: LiveCursor): void {
    const current = this.file.get();
    if (!current.sources.includes(key)) return;
    this.file.set({ ...current, cursors: { ...current.cursors, [key]: cursor } });
  }

  flush(): void {
    this.file.flush();
  }
}
