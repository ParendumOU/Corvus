/**
 * Live activity of MCP agents: a bounded timeline of tool calls per client, the connected clients,
 * and the "pause agents" kill switch. Pure, so the main process and tests share one reducer.
 */

export const MAX_TIMELINE = 200;
/** A client counts as active while it made a call within this window. */
export const ACTIVE_WINDOW_MS = 60_000;

export interface AgentCall {
  id: string;
  client: string;
  tool: string;
  /** Short human-readable summary of the arguments. */
  summary: string;
  at: number;
  durationMs: number | null;
  ok: boolean | null;
  resultChars: number | null;
  /** Refused because agents were paused. */
  blocked: boolean;
}

export interface AgentClient {
  name: string;
  firstSeen: number;
  lastSeen: number;
  calls: number;
  status: "connected" | "rejected" | "revoked";
}

export interface AgentActivityState {
  paused: boolean;
  calls: AgentCall[];
  clients: AgentClient[];
}

export type AgentActivityAction =
  | { type: "call"; id: string; client: string; tool: string; args: unknown; at: number }
  | { type: "result"; client: string; tool: string; at: number; durationMs: number; ok: boolean; resultChars: number }
  | { type: "connect"; client: string; at: number; allowed: boolean }
  | { type: "revoke"; client: string }
  | { type: "pause"; paused: boolean }
  | { type: "clear" };

export const initialAgentActivity = (): AgentActivityState => ({ paused: false, calls: [], clients: [] });

export class AgentsPausedError extends Error {
  constructor() {
    super("Agents are paused in Corvus. The user has to resume them before tools work again.");
    this.name = "AgentsPausedError";
  }
}

/** Throws while the kill switch is on. Called before every MCP tool runs. */
export function assertAgentsRunning(state: AgentActivityState): void {
  if (state.paused) throw new AgentsPausedError();
}

function cut(text: string, max: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function shortUrl(raw: string): string {
  try {
    const u = new URL(raw);
    const path = u.pathname === "/" ? "" : u.pathname;
    return cut(`${u.host}${path}`, 48);
  } catch {
    return cut(raw, 48);
  }
}

/** Compact, display-only description of a tool call's arguments. */
export function summarizeArgs(tool: string, args: unknown): string {
  const a = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
  const s = (k: string): string => (typeof a[k] === "string" ? (a[k] as string) : "");
  switch (tool) {
    case "tab_open":
    case "navigate":
      return shortUrl(s("url"));
    case "click":
      return s("ref");
    case "type":
      return `${JSON.stringify(cut(s("text"), 28))} into ${s("ref")}${a.submit === true ? ", submit" : ""}`;
    case "scroll":
      return `${s("direction") || "down"}${typeof a.amount === "number" ? ` ${a.amount}px` : ""}`;
    case "web_search":
    case "history_search":
      return JSON.stringify(cut(s("query"), 40));
    case "page_snapshot":
      return typeof a.maxChars === "number" ? `${a.maxChars} chars` : "";
    case "group_create":
      return `${Array.isArray(a.tabIds) ? a.tabIds.length : 0} tabs${s("title") ? ` as ${JSON.stringify(cut(s("title"), 20))}` : ""}`;
    case "bookmark_add":
      return shortUrl(s("url"));
    case "evaluate":
      return cut(s("expression"), 40);
    default: {
      const keys = Object.keys(a).filter((k) => k !== "tabId");
      if (keys.length === 0) return "";
      return cut(keys.map((k) => `${k}=${typeof a[k] === "string" ? a[k] : JSON.stringify(a[k])}`).join(" "), 48);
    }
  }
}

function touchClient(clients: AgentClient[], name: string, at: number, patch: Partial<AgentClient>): AgentClient[] {
  const existing = clients.find((c) => c.name === name);
  if (!existing) return [...clients, { name, firstSeen: at, lastSeen: at, calls: 0, status: "connected", ...patch }];
  return clients.map((c) => (c.name === name ? { ...c, lastSeen: Math.max(c.lastSeen, at), ...patch } : c));
}

export function reduceAgentActivity(state: AgentActivityState, action: AgentActivityAction): AgentActivityState {
  switch (action.type) {
    case "call": {
      const call: AgentCall = {
        id: action.id,
        client: action.client,
        tool: action.tool,
        summary: summarizeArgs(action.tool, action.args),
        at: action.at,
        durationMs: state.paused ? 0 : null,
        ok: state.paused ? false : null,
        resultChars: null,
        blocked: state.paused,
      };
      const prev = state.clients.find((c) => c.name === action.client);
      return {
        ...state,
        calls: [call, ...state.calls].slice(0, MAX_TIMELINE),
        clients: touchClient(state.clients, action.client, action.at, { calls: (prev?.calls ?? 0) + 1, status: "connected" }),
      };
    }
    case "result": {
      const index = state.calls.findIndex((c) => c.client === action.client && c.tool === action.tool && c.at === action.at && c.durationMs === null);
      if (index < 0) return state;
      const calls = state.calls.slice();
      calls[index] = { ...calls[index]!, durationMs: action.durationMs, ok: action.ok, resultChars: action.resultChars };
      return { ...state, calls };
    }
    case "connect":
      return { ...state, clients: touchClient(state.clients, action.client, action.at, { status: action.allowed ? "connected" : "rejected" }) };
    case "revoke":
      return { ...state, clients: state.clients.map((c) => (c.name === action.client ? { ...c, status: "revoked" } : c)) };
    case "pause":
      return state.paused === action.paused ? state : { ...state, paused: action.paused };
    case "clear":
      return { ...state, calls: [] };
  }
}

const KNOWN_CLIENTS: Record<string, string> = {
  "claude-code": "Claude Code",
  "claude-ai": "Claude Desktop",
  "claude-desktop": "Claude Desktop",
  cursor: "Cursor",
  "cursor-vscode": "Cursor",
  "visual-studio-code": "VS Code",
};

/** "claude-code" -> "Claude Code"; unknown names are title-cased. */
export function prettyClientName(name: string): string {
  const known = KNOWN_CLIENTS[name.toLowerCase()];
  if (known) return known;
  const words = name.replace(/[-_]+/g, " ").trim();
  if (!words) return "AI agent";
  return cut(words.replace(/\b\w/g, (c) => c.toUpperCase()), 32);
}

export type OverlayAction =
  | { kind: "click"; label: string }
  | { kind: "type"; label: string; text: string; secret: boolean }
  | { kind: "navigate"; url: string }
  | { kind: "scroll"; direction: "up" | "down" }
  | { kind: "read" }
  | { kind: "screenshot" }
  | { kind: "hover"; label: string }
  | { kind: "key"; key: string };

/** Caption shown next to the agent cursor, e.g. "Claude Code: clicking 'Sign in'". */
export function overlayCaption(client: string, action: OverlayAction): string {
  const who = prettyClientName(client);
  const quote = (s: string): string => `'${cut(s, 36)}'`;
  switch (action.kind) {
    case "click":
      return `${who}: clicking ${action.label ? quote(action.label) : "an element"}`;
    case "type": {
      const shown = action.secret ? "•".repeat(Math.min(8, Math.max(4, action.text.length))) : cut(action.text, 28);
      return `${who}: typing ${quote(shown)}${action.label ? ` into ${quote(action.label)}` : ""}`;
    }
    case "navigate":
      return `${who}: opening ${shortUrl(action.url)}`;
    case "scroll":
      return `${who}: scrolling ${action.direction}`;
    case "read":
      return `${who}: reading the page`;
    case "screenshot":
      return `${who}: taking a screenshot`;
    case "hover":
      return `${who}: pointing at ${action.label ? quote(action.label) : "the page"}`;
    case "key":
      return `${who}: pressing ${quote(action.key)}`;
  }
}
