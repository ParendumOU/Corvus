import path from "node:path";
import { JsonFile } from "./json-file";
import { cleanLiveHistoryConfig, defaultLiveHistoryConfig, type LiveCursor, type LiveHistoryConfig, type LiveHistoryPatch } from "../shared/live-history";

/**
 * A profile's "Live history from other browsers": on or off, which browser profiles, and where it is
 * in each. A profile without the file never chose: it is on, following each browser's default profile.
 */
export class LiveHistoryStore {
  private readonly file: JsonFile<LiveHistoryConfig>;

  constructor(dir: string) {
    this.file = JsonFile.load(path.join(dir, "live-history.json"), defaultLiveHistoryConfig, cleanLiveHistoryConfig, 1000);
  }

  get(): LiveHistoryConfig {
    return this.file.get();
  }

  /** What the person chose. Browser profiles no longer followed lose their cursor: following one again starts afresh. */
  set(patch: LiveHistoryPatch): LiveHistoryConfig {
    const current = this.file.get();
    const next = cleanLiveHistoryConfig({ ...current, ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}), ...(patch.sources !== undefined ? { sources: patch.sources } : {}) });
    this.file.set(next);
    this.file.flush();
    return next;
  }

  cursor(key: string): LiveCursor | undefined {
    return this.file.get().cursors[key];
  }

  setCursor(key: string, cursor: LiveCursor): void {
    const current = this.file.get();
    if (current.sources && !current.sources.includes(key)) return;
    this.file.set({ ...current, cursors: { ...current.cursors, [key]: cursor } });
  }

  /** Whether the bar saying Corvus turned it on by itself was shown. */
  setNoticeShown(shown: boolean): void {
    this.file.set({ ...this.file.get(), noticeShown: shown });
    this.file.flush();
  }

  flush(): void {
    this.file.flush();
  }
}
