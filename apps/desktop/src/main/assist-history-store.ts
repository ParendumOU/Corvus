import path from "node:path";
import { MAX_CONVERSATIONS, reviveConversation, summarizeConversation, type AssistConversation, type AssistConversationSummary } from "../shared/assist-history";
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
    this.file.set([conversation, ...rest].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_CONVERSATIONS));
  }

  remove(id: string): void {
    this.file.set(this.file.get().filter((c) => c.id !== id));
  }

  clear(): void {
    this.file.set([]);
  }

  flush(): void {
    this.file.flush();
  }
}
