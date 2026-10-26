/**
 * The Assist panel's view of an agent run working in the user's tab: one readable line per step
 * ("Opened github.com", "Clicked "Sign in""), the closing answer, and the approval waiting for the
 * person. Pure, so the main process and tests share it.
 */
import type { AgentApprovalRequest, AgentLeftTab, AgentRunStep, AgentRunView, AgentStepStatus } from "./command-bar-ipc";

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
  /** The agent's tabs it left open for the person, offered under the answer. */
  leftTabs?: AgentLeftTab[];
  /** The person took over the page: the turn waits until they hand it back. */
  takenOver?: boolean;
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

/** Fills a label template; the agent runner passes its translator instead (Corvus's language). */
export type LabelTranslate = (text: string, vars?: Record<string, string | number>) => string;

const english: LabelTranslate = (text, vars) => (vars ? text.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m)) : text);

const coord = (input: unknown, key: "x" | "y"): number => Math.round(Number((input as Record<string, unknown> | null)?.[key]) || 0);

/** One past-tense line for a tool call, from its input and the target's name in the latest snapshot. */
export function actionLabel(tool: string, input: unknown, elementName = "", t: LabelTranslate = english): string {
  switch (tool) {
    case "navigate":
      return t("Opened {host}", { host: hostOf(str(input, "url")) });
    case "open_tab":
      return t("Opened {host} in a new tab", { host: hostOf(str(input, "url")) });
    case "page_snapshot":
      return t("Read the page");
    case "extract":
      return t("Read the page text");
    case "screenshot":
      return t("Took a screenshot");
    case "click":
      return elementName ? t("Clicked {target}", { target: quote(elementName) }) : str(input, "ref") ? t("Clicked {target}", { target: str(input, "ref") }) : t("Clicked an element");
    case "type": {
      const text = quote(str(input, "text"), 32);
      const submit = (input as { submit?: unknown })?.submit === true;
      if (elementName) {
        const field = quote(elementName, 32);
        return submit ? t("Typed {text} into {field} and submitted", { text, field }) : t("Typed {text} into {field}", { text, field });
      }
      return submit ? t("Typed {text} and submitted", { text }) : t("Typed {text}", { text });
    }
    case "scroll":
      return str(input, "direction") === "up" ? t("Scrolled up") : t("Scrolled down");
    case "wait":
      return str(input, "text") ? t("Waited for {text}", { text: quote(str(input, "text")) }) : t("Waited for the page");
    case "web_search":
      return t("Searched the web for {query}", { query: quote(str(input, "query")) });
    case "list_tabs":
      return t("Listed the open tabs");
    case "remember":
      return t("Remembered {note}", { note: quote(str(input, "note"), 60) });
    case "switch_tab":
      return t("Switched to another tab");
    case "close_tab":
      return t("Closed a tab that led nowhere");
    case "ask_user":
      return t("Asked you: {message}", { message: clip(str(input, "message"), 120) });
    case "click_at":
      return t("Clicked at ({x}, {y})", { x: coord(input, "x"), y: coord(input, "y") });
    case "hover_at":
      return t("Pointed at the page");
    case "scroll_at":
      return t("Scrolled {direction} at a point", { direction: direction(str(input, "direction") || "down", t) });
    case "press_key":
      return str(input, "key") ? t("Pressed {key}", { key: str(input, "key") }) : t("Pressed a key");
    case "type_text":
      return t("Typed {text}", { text: quote(str(input, "text"), 32) });
    case "fill_login":
      return t("Filled your saved login");
    case "fill_totp":
      return t("Filled your 2FA code");
    case "list_workflows":
      return t("Listed saved workflows");
    case "read_workflow":
      return t("Read a saved workflow");
    case "run_workflow":
      return t("Ran a saved workflow");
    case "queue_downloads":
      return t("Added files to the download queue");
    case "newtab_layout":
      return t("Read your New Tab page");
    case "newtab_change":
      return t("Changed your New Tab page");
    default:
      return tool.replace(/_/g, " ");
  }
}

function direction(dir: string, t: LabelTranslate): string {
  switch (dir) {
    case "up":
      return t("up");
    case "left":
      return t("left");
    case "right":
      return t("right");
    default:
      return t("down");
  }
}

/**
 * The finished line. Coordinate and keyboard tools say what they hit, read back from the result
 * sentence the model got ('Clicked at (120, 80) on button "Buy now".'); failures say so.
 */
export function resultLabel(tool: string, label: string, content: string, isError: boolean, t: LabelTranslate = english): string {
  if (isError) return t("{label} (failed: {error})", { label, error: clip(content, 90) });
  const text = content.trim().replace(/\.\s*$/, "");
  let m: RegExpExecArray | null;
  switch (tool) {
    case "click_at":
      if ((m = /^Clicked at \((-?\d+), (-?\d+)\) on (.+)$/s.exec(text))) return t("Clicked at ({x}, {y}) on {target}", { x: m[1]!, y: m[2]!, target: clip(m[3]!, 100) });
      break;
    case "hover_at":
      if ((m = /^Moved the mouse to \((-?\d+), (-?\d+)\) over (.+)$/s.exec(text))) return t("Pointed at ({x}, {y}) over {target}", { x: m[1]!, y: m[2]!, target: clip(m[3]!, 100) });
      break;
    case "scroll_at":
      if ((m = /^Scrolled (\w+) at \((-?\d+), (-?\d+)\) over (.+?); page scroll (\S+) px$/s.exec(text))) {
        return t("Scrolled {direction} at ({x}, {y}) over {target}; page scroll {scroll} px", { direction: direction(m[1]!, t), x: m[2]!, y: m[3]!, target: clip(m[4]!, 80), scroll: m[5]! });
      }
      break;
    case "press_key":
      if ((m = /^Pressed (.+?) in (.+)$/s.exec(text))) return t("Pressed {key} in {target}", { key: m[1]!, target: clip(m[2]!, 100) });
      if ((m = /^Pressed (.+)$/s.exec(text))) return t("Pressed {key}", { key: m[1]! });
      break;
    case "type_text":
      if ((m = /^Typed (\d+) characters into (.+)$/s.exec(text))) return t("Typed {count} characters into {target}", { count: m[1]!, target: clip(m[2]!, 100) });
      break;
    case "fill_login":
    case "fill_totp":
      // "Filled …" keeps the plain label; anything else (a handoff) is what the person needs to know.
      if (text && !text.startsWith("Filled")) return clip(text, 140);
      break;
    case "switch_tab":
      if ((m = /^Switched to tab \S+ at (\S+) — /.exec(content))) return t("Switched to {host}", { host: hostOf(m[1]!) });
      break;
  }
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
      ...(run.leftTabs?.length ? { leftTabs: run.leftTabs } : {}),
      ...(run.takenOver ? { takenOver: true } : {}),
    },
    answer: answer.trim(),
  };
}

/** Step lines of a finished turn, for the conversation history handed to the next turn. */
export function historyActions(view: AssistAgentView | undefined, max = 12): string[] {
  if (!view) return [];
  return view.steps.filter((s) => s.kind !== "message" && s.status !== "running").slice(-max).map((s) => clip(s.label, 90));
}
