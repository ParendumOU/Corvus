/**
 * The Assist panel's view of an agent run working in the user's tab: one readable line per step
 * ("Opened github.com", "Clicked "Sign in""), the closing answer, and the approval waiting for the
 * person. Pure, so the main process and tests share it.
 */
import type { AgentApprovalRequest, AgentRunStep, AgentRunView, AgentStepStatus } from "./command-bar-ipc";

/** Assist runs get at least this many tool steps (the Command Bar setting is often lower). */
export const ASSIST_MIN_STEPS = 40;
/** Total token budget (input + output, all turns) of one Assist agent turn. */
export const ASSIST_TOKEN_BUDGET = 400_000;
/** Thumbnails kept per run (the newest screenshots). */
export const ASSIST_MAX_THUMBS = 4;

export interface AssistAgentStep {
  id: string;
  /** Tool name, or "message" for text the agent wrote between steps. */
  kind: string;
  label: string;
  status: AgentStepStatus;
  /** data: URL of a small screenshot thumbnail. */
  thumb?: string;
}

export interface AssistAgentView {
  runId: string;
  status: AgentRunView["status"];
  steps: AssistAgentStep[];
  approval: AgentApprovalRequest | null;
  stepCount: number;
  maxSteps: number;
  /** Why the run ended early (step or token cap), shown under the answer. */
  limit: "max_steps" | "budget" | null;
}

function clip(text: string, max: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return clip(url, 48);
  }
}

function str(input: unknown, key: string): string {
  const v = (input && typeof input === "object" ? (input as Record<string, unknown>)[key] : undefined) as unknown;
  return typeof v === "string" ? v : "";
}

const quote = (s: string, max = 48): string => `"${clip(s, max)}"`;

/** Tools whose result text is itself the best step line ("Clicked at (120, 80) on button "Buy now"."). */
const RESULT_LABELLED = new Set(["click_at", "hover_at", "scroll_at", "press_key", "type_text", "fill_login", "fill_totp"]);

/** One past-tense line for a tool call, from its input and the target's name in the latest snapshot. */
export function actionLabel(tool: string, input: unknown, elementName = ""): string {
  switch (tool) {
    case "navigate":
      return `Opened ${hostOf(str(input, "url"))}`;
    case "open_tab":
      return `Opened ${hostOf(str(input, "url"))} in a new tab`;
    case "page_snapshot":
      return "Read the page";
    case "extract":
      return "Read the page text";
    case "screenshot":
      return "Took a screenshot";
    case "click":
      return `Clicked ${elementName ? quote(elementName) : str(input, "ref") || "an element"}`;
    case "type": {
      const into = elementName ? ` into ${quote(elementName, 32)}` : "";
      return `Typed ${quote(str(input, "text"), 32)}${into}${(input as { submit?: unknown })?.submit === true ? " and submitted" : ""}`;
    }
    case "scroll":
      return `Scrolled ${str(input, "direction") === "up" ? "up" : "down"}`;
    case "wait":
      return str(input, "text") ? `Waited for ${quote(str(input, "text"))}` : "Waited for the page";
    case "web_search":
      return `Searched the web for ${quote(str(input, "query"))}`;
    case "list_tabs":
      return "Listed the open tabs";
    case "ask_user":
      return `Asked you: ${clip(str(input, "message"), 120)}`;
    case "click_at":
      return `Clicked at (${Math.round(Number((input as { x?: unknown })?.x) || 0)}, ${Math.round(Number((input as { y?: unknown })?.y) || 0)})`;
    case "hover_at":
      return "Pointed at the page";
    case "scroll_at":
      return `Scrolled ${str(input, "direction") || "down"} at a point`;
    case "press_key":
      return `Pressed ${str(input, "key") || "a key"}`;
    case "type_text":
      return `Typed ${quote(str(input, "text"), 32)}`;
    case "fill_login":
      return "Filled your saved login";
    case "fill_totp":
      return "Filled your 2FA code";
    case "list_workflows":
      return "Listed saved workflows";
    case "read_workflow":
      return "Read a saved workflow";
    case "run_workflow":
      return "Ran a saved workflow";
    default:
      return tool.replace(/_/g, " ");
  }
}

/** The finished line: result-described tools use their result sentence; failures say so. */
export function resultLabel(tool: string, label: string, content: string, isError: boolean): string {
  if (isError) return `${label} (failed: ${clip(content, 90)})`;
  if (RESULT_LABELLED.has(tool) && content.trim()) return clip(content.replace(/\.\s*$/, ""), 140);
  return label;
}

/**
 * Splits a run into the step lines shown in the conversation and the answer: text the agent wrote
 * after its last tool call is the answer; text between tool calls stays as a short note in the steps.
 */
export function assistAgentView(run: AgentRunView, thumbs: ReadonlyMap<string, string> = new Map()): { view: AssistAgentView; answer: string } {
  let lastTool = -1;
  run.steps.forEach((s, i) => {
    if (s.kind !== "message") lastTool = i;
  });
  const steps: AssistAgentStep[] = [];
  let answer = "";
  run.steps.forEach((s: AgentRunStep, i) => {
    if (s.kind === "message") {
      if (i > lastTool) answer += s.detail ?? "";
      else if (s.detail?.trim()) steps.push({ id: s.id, kind: "message", label: clip(s.detail, 160), status: "ok" });
      return;
    }
    const thumb = thumbs.get(s.id);
    steps.push({ id: s.id, kind: s.kind, label: s.label || s.summary || s.kind, status: s.status, ...(thumb ? { thumb } : {}) });
  });
  return {
    view: {
      runId: run.id,
      status: run.status,
      steps,
      approval: run.approval,
      stepCount: run.stepCount,
      maxSteps: run.maxSteps,
      limit: run.stopReason === "max_steps" || run.stopReason === "budget" ? run.stopReason : null,
    },
    answer: answer.trim(),
  };
}

/** Step lines of a finished turn, for the conversation history handed to the next turn. */
export function historyActions(view: AssistAgentView | undefined, max = 12): string[] {
  if (!view) return [];
  return view.steps.filter((s) => s.kind !== "message" && s.status !== "running").slice(-max).map((s) => clip(s.label, 90));
}
