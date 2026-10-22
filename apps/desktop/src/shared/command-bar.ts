/**
 * Pure logic for the Corvus Command Bar (Ctrl/Cmd+K): a fuzzy matcher, palette-action ranking and
 * the rule that tells a quick command from a task for the AI agent. Kept free of Electron and React
 * so it can be unit-tested and shared by the chrome renderer and the main process.
 */

export type PaletteIcon =
  | "search"
  | "navigate"
  | "tab"
  | "history"
  | "bookmark"
  | "newtab"
  | "settings"
  | "extensions"
  | "downloads"
  | "webscope"
  | "bookmarks"
  | "assist"
  | "organize"
  | "agent";

export type PaletteActionKind = "command" | "navigate" | "search" | "tab" | "history" | "bookmark" | "agent";

export interface PaletteAction {
  id: string;
  kind: PaletteActionKind;
  title: string;
  subtitle?: string;
  /** Extra text folded into the match haystack (e.g. a URL), never shown as the title. */
  keywords?: string;
  icon: PaletteIcon;
  /** Static relevance when the query is empty; higher shows first. Defaults to 0. */
  priority?: number;
}

export interface RankedAction extends PaletteAction {
  score: number;
}

const WORD_BOUNDARY = /[\s\-_/.:?#&=]/;

/**
 * Subsequence fuzzy score. Returns null when `query` is not a subsequence of `text`; otherwise a
 * number where higher is a better match. Rewards matches at word starts and consecutive runs, and
 * gently prefers earlier and shorter matches, so a prefix beats a scattered match.
 */
export function fuzzyScore(query: string, text: string): number | null {
  const q = query.toLowerCase();
  if (q === "") return 0;
  const t = text.toLowerCase();
  let qi = 0;
  let score = 0;
  let streak = 0;
  let firstIndex = -1;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      if (firstIndex < 0) firstIndex = ti;
      let bonus = 1;
      if (ti === 0 || WORD_BOUNDARY.test(t[ti - 1]!)) bonus += 3;
      if (streak > 0) bonus += streak * 2;
      score += bonus;
      streak += 1;
      qi += 1;
    } else {
      streak = 0;
    }
  }
  if (qi < q.length) return null;
  score -= firstIndex * 0.1;
  score -= (t.length - q.length) * 0.03;
  return score;
}

function haystack(action: PaletteAction): string {
  return action.keywords ? `${action.title} ${action.keywords}` : action.title;
}

/**
 * Ranks palette actions for a query. With no query, keeps declaration order within priority tiers.
 * With a query, drops non-matches and sorts by match quality (ties fall back to static priority).
 */
export function rankActions(query: string, actions: PaletteAction[], limit = 12): RankedAction[] {
  const q = query.trim();
  if (q === "") {
    return [...actions]
      .map((a, i) => ({ ...a, score: (a.priority ?? 0) * 1000 - i }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }
  const ranked: RankedAction[] = [];
  for (const action of actions) {
    const score = fuzzyScore(q, haystack(action));
    if (score === null) continue;
    ranked.push({ ...action, score: score + (action.priority ?? 0) * 0.5 });
  }
  ranked.sort((a, b) => b.score - a.score);
  return ranked.slice(0, limit);
}

// --------------------------------------------------------------------- agent intent

/** Typing "> " (or just ">") switches the bar to agent mode; the rest is the task. */
export const AGENT_PREFIX = ">";

export interface CommandInput {
  mode: "command" | "agent";
  /** The text to act on: the query for command mode, the task for agent mode. */
  query: string;
}

export function parseCommandInput(raw: string): CommandInput {
  if (raw.trimStart().startsWith(AGENT_PREFIX)) {
    return { mode: "agent", query: raw.replace(/^\s*>\s?/, "") };
  }
  return { mode: "command", query: raw };
}

/** Imperative openers that usually mean "do this for me" rather than "find this page". */
export const AGENT_VERBS = new Set([
  "find", "search", "buy", "book", "compare", "fill", "summarize", "summarise", "download", "sign",
  "order", "add", "get", "look", "read", "play", "watch", "send", "write", "create", "schedule",
  "translate", "reserve", "cancel", "subscribe", "apply", "collect", "gather", "research", "price",
  "check", "show", "tell", "make", "plan", "draft",
]);

/** Whether an input reads like a task for the agent, so the bar can offer "Ask Corvus to do it". */
export function looksLikeTask(input: string): boolean {
  const words = input.trim().split(/\s+/).filter(Boolean);
  if (words.length < 3) return false;
  const first = words[0]!.toLowerCase().replace(/[^a-z]/g, "");
  return AGENT_VERBS.has(first);
}
