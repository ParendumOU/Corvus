/**
 * Corvus Assist conversations as the phone shows them, from the synced `assist_history` records
 * (each one a conversation the person had on a computer, with the page it was on). Read only.
 */

export interface ConversationTurn {
  id: string;
  /** "ask", "summarize", "explain", "translate-selection" or "compare". */
  kind: string;
  /** The person's question (or the selection it was about). */
  prompt: string;
  /** Corvus's answer. */
  text: string;
}

export interface ConversationView {
  id: string;
  /** The first question, or "" when it started with a summary or a selection. */
  title: string;
  url: string;
  pageTitle: string;
  updatedAt: number;
  turns: ConversationTurn[];
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

const ARTIFACT_BLOCK = /```artifact[^\n]*\n([\s\S]*?)(?:```|$)/g;

/**
 * An answer's artifacts (tables, figures, forms the computer's panel draws) as one line each, so
 * the phone never shows their JSON: "[Flights]", or the kind when it has no title.
 */
export function withoutArtifacts(text: string): string {
  return text
    .replace(ARTIFACT_BLOCK, (_m, json: string) => {
      try {
        const a = JSON.parse(json) as { title?: unknown; type?: unknown };
        const title = typeof a.title === 'string' ? a.title.trim().slice(0, 80) : '';
        return `[${title || (typeof a.type === 'string' ? a.type : '…')}]`;
      } catch {
        return '[…]';
      }
    })
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function parse(id: string, raw: unknown): ConversationView | null {
  const r = raw as { url?: unknown; pageTitle?: unknown; updatedAt?: unknown; messages?: unknown } | null;
  if (!r || typeof r.url !== 'string' || !Array.isArray(r.messages)) return null;
  const turns: ConversationTurn[] = [];
  for (const m of r.messages) {
    const x = m as { id?: unknown; kind?: unknown; prompt?: unknown; text?: unknown } | null;
    if (!x || typeof x.id !== 'string') continue;
    turns.push({ id: x.id, kind: str(x.kind) || 'ask', prompt: str(x.prompt), text: withoutArtifacts(str(x.text)) });
  }
  if (turns.length === 0) return null;
  const question = turns.find((t) => t.kind === 'ask' && t.prompt.trim());
  return {
    id,
    title: (question?.prompt ?? '').replace(/\s+/g, ' ').trim().slice(0, 120),
    url: r.url,
    pageTitle: str(r.pageTitle),
    updatedAt: typeof r.updatedAt === 'number' ? r.updatedAt : 0,
    turns,
  };
}

/** Every valid conversation, newest first. */
export function conversationList(records: Record<string, unknown>): ConversationView[] {
  return Object.entries(records)
    .map(([id, raw]) => parse(id, raw))
    .filter((c): c is ConversationView => c !== null)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Conversations whose question, page title or address contains every word of the query. */
export function searchConversations(list: readonly ConversationView[], query: string): ConversationView[] {
  const q = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (q.length === 0) return [...list];
  return list.filter((c) => {
    const hay = `${c.title} ${c.pageTitle} ${c.url} ${c.turns.map((t) => t.prompt).join(' ')}`.toLowerCase();
    return q.every((w) => hay.includes(w));
  });
}
