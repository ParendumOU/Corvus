/**
 * Runs a workflow's steps for an AGENT (the in-browser agent's run_workflow tool). It differs from
 * FlowService replay in one way that matters: when a step's target no longer matches the page, it
 * does not pause for Retry/Skip, it STOPS and reports which step broke, so the agent can carry on
 * from there with its normal tools (fallback to reasoning).
 *
 * Every step is classified with the same shared gate as everything else (classifyAction): risky
 * steps and secret fields go to `hooks.gate`, which the runner wires to its own approval prompt. A
 * secret is never typed: approving a handoff means the person did it in the tab. A step that spends
 * money comes with `alwaysAsk`, so the gate asks even in auto mode; when the runner can read the live
 * target (`hooks.inspect`), a click or type step is classified with what is on the page now too, so
 * a saved workflow cannot buy because its recording looked harmless.
 *
 * No Electron imports: the primitives come in through hooks, so it is unit tested.
 */
import type { ActionTarget } from "@corvus/shared";
import { classifyAction, stricterRisk, type ActionRisk } from "../shared/agent-safety";
import { resolveTargetRef, stepToToolCall, type FlowStep, type SnapElement } from "../shared/flow";

export type GateDecision = "approve" | "skip" | "stop";
export type EngineStepStatus = "running" | "ok" | "skipped" | "error";

export interface WorkflowEngineHooks {
  signal: AbortSignal;
  navigate(url: string): Promise<void>;
  /** A fresh snapshot of the working tab, or null when it could not be taken. */
  snapshot(): Promise<{ url: string; elements: SnapElement[] } | null>;
  click(ref: string): Promise<void>;
  type(ref: string, text: string, submit: boolean): Promise<void>;
  /** Ask the person about a risky step or hand them a secret field. */
  gate(step: FlowStep, risk: ActionRisk): Promise<GateDecision>;
  /** The live role, name, page and form of an element (for the spend rules), or null. */
  inspect?(ref: string): Promise<ActionTarget | null>;
  /** Wait here while the user has paused agents. */
  waitWhilePaused?(): Promise<void>;
  onStep?(index: number, step: FlowStep, status: EngineStepStatus, detail?: string): void;
  /** Snapshots to try while a target appears (default 4) and the gap between them (default 400 ms). */
  resolveAttempts?: number;
  resolveGapMs?: number;
}

export interface WorkflowEngineOutcome {
  status: "done" | "broken" | "stopped";
  /** Steps carried out (ok, including user-handled handoffs). */
  completed: number;
  skipped: number;
  /** 0-based index of the step that broke, when status is "broken". */
  brokenAt: number | null;
  reason: string;
}

class Stopped extends Error {}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function errorText(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.length > 200 ? `${message.slice(0, 197)}...` : message;
}

async function resolveRef(step: FlowStep, hooks: WorkflowEngineHooks): Promise<string | null> {
  const attempts = Math.max(1, hooks.resolveAttempts ?? 4);
  for (let i = 0; i < attempts; i++) {
    if (hooks.signal.aborted) throw new Stopped();
    const snap = await hooks.snapshot().catch(() => null);
    if (snap) {
      const ref = resolveTargetRef(snap.elements, step.target!);
      if (ref) return ref;
    }
    if (i < attempts - 1) await sleep(hooks.resolveGapMs ?? 400);
  }
  return null;
}

const SAFE: ActionRisk = { risky: false, handoff: false, reason: "" };

/**
 * The step classified against the live page: the element its target resolves to now, with its
 * current name, role, URL and form. SAFE when the target cannot be found (the step then breaks when
 * it runs, before anything happens) or the page cannot tell.
 */
async function liveRisk(step: FlowStep, call: ReturnType<typeof stepToToolCall>, hooks: WorkflowEngineHooks): Promise<ActionRisk> {
  const ref = await resolveRef(step, hooks);
  if (!ref) return SAFE;
  const live = await hooks.inspect!(ref).catch(() => null);
  if (!live) return SAFE;
  return classifyAction(call.tool, call.input, live.name || call.elementName, {
    role: live.role || call.context.role,
    url: live.url || call.context.url,
    ...(live.form ? { form: live.form } : {}),
  });
}

/** Navigate to `startUrl`, then carry out `steps` in order through the gate. */
export async function runWorkflowSteps(startUrl: string, steps: readonly FlowStep[], hooks: WorkflowEngineHooks): Promise<WorkflowEngineOutcome> {
  let completed = 0;
  let skipped = 0;
  const outcome = (status: WorkflowEngineOutcome["status"], brokenAt: number | null, reason: string): WorkflowEngineOutcome => ({ status, completed, skipped, brokenAt, reason });
  try {
    if (startUrl) {
      try {
        await hooks.navigate(startUrl);
      } catch (err) {
        return outcome("broken", 0, `Could not open the start page: ${errorText(err)}`);
      }
    }
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i]!;
      if (hooks.signal.aborted) throw new Stopped();
      await hooks.waitWhilePaused?.();
      if (hooks.signal.aborted) throw new Stopped();
      hooks.onStep?.(i, step, "running");

      const call = stepToToolCall(step);
      let risk = classifyAction(call.tool, call.input, call.elementName, call.context);
      if (step.secret) risk = { risky: true, handoff: true, reason: risk.reason || "This field needs your password or another secret." };
      else if (step.kind !== "navigate" && hooks.inspect) risk = stricterRisk(risk, await liveRisk(step, call, hooks));
      if (risk.risky) {
        const decision = await hooks.gate(step, risk);
        if (decision === "stop") throw new Stopped();
        if (decision === "skip") {
          skipped += 1;
          hooks.onStep?.(i, step, "skipped");
          continue;
        }
        if (risk.handoff) {
          completed += 1;
          hooks.onStep?.(i, step, "ok", "Done by you in the tab.");
          continue;
        }
      }

      try {
        if (step.kind === "navigate") {
          await hooks.navigate(step.url);
        } else {
          const ref = await resolveRef(step, hooks);
          if (!ref) {
            const reason = `The target of step ${i + 1} ("${step.label}") is no longer on the page.`;
            hooks.onStep?.(i, step, "error", reason);
            return outcome("broken", i, reason);
          }
          if (step.kind === "type") await hooks.type(ref, step.value ?? "", step.submit === true);
          else await hooks.click(ref);
        }
      } catch (err) {
        if (err instanceof Stopped || hooks.signal.aborted) throw new Stopped();
        const reason = `Step ${i + 1} ("${step.label}") failed: ${errorText(err)}`;
        hooks.onStep?.(i, step, "error", reason);
        return outcome("broken", i, reason);
      }
      completed += 1;
      hooks.onStep?.(i, step, "ok");
    }
    return outcome("done", null, "");
  } catch (err) {
    if (err instanceof Stopped || hooks.signal.aborted) return outcome("stopped", null, "Stopped.");
    throw err;
  }
}
