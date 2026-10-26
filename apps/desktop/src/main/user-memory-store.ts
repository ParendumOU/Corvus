import crypto from "node:crypto";
import path from "node:path";
import { MAX_USER_NOTES, cleanNote, reviveNote, type UserNote } from "../shared/user-memory";
import { JsonFile } from "./json-file";

function revive(raw: unknown): UserNote[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(reviveNote).filter((n): n is UserNote => n !== null).slice(0, MAX_USER_NOTES);
}

/** A profile's "about me" notes for the agent (user-memory.json), newest first. Local to this device. */
export class UserMemoryStore {
  private readonly file: JsonFile<UserNote[]>;
  private readonly listeners = new Set<() => void>();

  constructor(dir: string) {
    this.file = JsonFile.load(path.join(dir, "user-memory.json"), () => [], revive);
  }

  list(): UserNote[] {
    return this.file.get();
  }

  /** Saves a note; the same text again is left as it is. Returns it, or null when it was refused/empty. */
  add(text: string): UserNote | null {
    const clean = cleanNote(text);
    if (!clean) return null;
    const existing = this.file.get().find((n) => n.text.toLowerCase() === clean.toLowerCase());
    if (existing) return existing;
    const note: UserNote = { id: crypto.randomUUID(), text: clean, at: Date.now() };
    this.set([note, ...this.file.get()].slice(0, MAX_USER_NOTES));
    return note;
  }

  remove(id: string): void {
    if (this.file.get().some((n) => n.id === id)) this.set(this.file.get().filter((n) => n.id !== id));
  }

  clear(): void {
    if (this.file.get().length > 0) this.set([]);
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  flush(): void {
    this.file.flush();
  }

  private set(list: UserNote[]): void {
    this.file.set(list);
    for (const l of this.listeners) l();
  }
}
