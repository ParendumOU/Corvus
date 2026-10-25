import crypto from "node:crypto";
import path from "node:path";
import { MAX_COMMAND_TEXT, mergeRecents, parseCommandRecent, recentPayload, type CommandRecent, type CommandRecentKind } from "../shared/command-history";
import { JsonFile } from "./json-file";

function revive(raw: unknown): CommandRecent[] {
  if (!Array.isArray(raw)) return [];
  const list = raw.map((r) => parseCommandRecent(r, typeof (r as { id?: unknown })?.id === "string" ? (r as { id: string }).id : "")).filter((r): r is CommandRecent => r !== null);
  return mergeRecents(list);
}

/** A profile's Command Bar recents (command-history.json), newest first. */
export class CommandHistoryStore {
  private readonly file: JsonFile<CommandRecent[]>;
  private readonly listeners = new Set<() => void>();

  constructor(
    dir: string,
    private readonly now: () => number = Date.now,
  ) {
    this.file = JsonFile.load(path.join(dir, "command-history.json"), () => [], revive);
  }

  list(): CommandRecent[] {
    return this.file.get();
  }

  /** Records a run; the same kind and text again moves the old entry to the top under a new time. */
  add(kind: CommandRecentKind, text: string): CommandRecent | null {
    const clean = text.trim().slice(0, MAX_COMMAND_TEXT);
    if (!clean) return null;
    const entry: CommandRecent = { id: crypto.randomUUID(), kind, text: clean, at: this.now() };
    this.set(mergeRecents([entry, ...this.file.get()]));
    return entry;
  }

  remove(id: string): void {
    if (this.file.get().some((r) => r.id === id)) this.set(this.file.get().filter((r) => r.id !== id));
  }

  clear(): void {
    if (this.file.get().length > 0) this.set([]);
  }

  /** For the sync adapter: every recent with its payload. */
  syncList(): Array<{ id: string; payload: ReturnType<typeof recentPayload> }> {
    return this.file.get().map((r) => ({ id: r.id, payload: recentPayload(r) }));
  }

  /** Upserts and deletions from other devices; the list stays capped (older ones fall off). */
  applyRemote(changes: ReadonlyArray<{ id: string; recent: CommandRecent | null }>): void {
    const removed = new Set(changes.filter((c) => c.recent === null).map((c) => c.id));
    const incoming = changes.flatMap((c) => (c.recent ? [c.recent] : []));
    const byId = new Set(incoming.map((r) => r.id));
    const kept = this.file.get().filter((r) => !removed.has(r.id) && !byId.has(r.id));
    this.set(mergeRecents([...incoming, ...kept]));
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  flush(): void {
    this.file.flush();
  }

  private set(list: CommandRecent[]): void {
    this.file.set(list);
    for (const l of this.listeners) l();
  }
}
