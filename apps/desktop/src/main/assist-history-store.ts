import path from "node:path";
import { MAX_CONVERSATIONS, reviveConversation, summarizeConversation, syncedConversation, type AssistConversation, type AssistConversationSummary } from "../shared/assist-history";
import { JsonFile } from "./json-file";

function revive(raw: unknown): AssistConversation[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map(reviveConversation)
    .filter((c): c is AssistConversation => c !== null)
    .slice(0, MAX_CONVERSATIONS);
}

/** The Assist conversations of one profile, newest first, bounded in count (see shared/assist-history). */
export class AssistHistoryStore {
  private readonly file: JsonFile<AssistConversation[]>;
  private readonly listeners = new Set<() => void>();
  /** Conversations dropped here only by the cap (kept on the sync chain, not deleted there). */
  private readonly evicted = new Set<string>();

  constructor(dir: string) {
    this.file = JsonFile.load(path.join(dir, "assist-history.json"), () => [], revive, 1000);
  }

  get(id: string): AssistConversation | undefined {
    return this.file.get().find((c) => c.id === id);
  }

  summaries(): AssistConversationSummary[] {
    return this.file.get().map(summarizeConversation);
  }

  /** Insert or replace a conversation by id; the newest comes first. */
  save(conversation: AssistConversation): void {
    const rest = this.file.get().filter((c) => c.id !== conversation.id);
    this.set([conversation, ...rest]);
  }

  remove(id: string): void {
    this.set(this.file.get().filter((c) => c.id !== id));
  }

  clear(): void {
    this.set([]);
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** For the sync adapter: every conversation as synced. */
  syncList(): Array<{ id: string; payload: AssistConversation }> {
    return this.file.get().map((c) => ({ id: c.id, payload: syncedConversation(c) }));
  }

  /** Conversations from the person's other devices: the newer version of each wins; deletions apply. */
  applyRemote(changes: ReadonlyArray<{ id: string; conversation: AssistConversation | null }>): void {
    const byId = new Map(this.file.get().map((c) => [c.id, c]));
    for (const change of changes) {
      if (!change.conversation) byId.delete(change.id);
      else {
        const mine = byId.get(change.id);
        if (!mine || change.conversation.updatedAt >= mine.updatedAt) byId.set(change.id, { ...change.conversation, id: change.id });
      }
    }
    this.set([...byId.values()]);
  }

  /** Dropped only by this device's cap: it stays on the chain. */
  retain(id: string): boolean {
    return this.evicted.has(id);
  }

  private set(list: AssistConversation[]): void {
    const sorted = [...list].sort((a, b) => b.updatedAt - a.updatedAt);
    for (const c of sorted.slice(MAX_CONVERSATIONS)) this.evicted.add(c.id);
    this.file.set(sorted.slice(0, MAX_CONVERSATIONS));
    for (const l of this.listeners) l();
  }

  flush(): void {
    this.file.flush();
  }
}
