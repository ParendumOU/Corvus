import { z } from "zod";
import { compactJson } from "../content.js";
import { errorResult, text, untrusted, type FlowSummary, type ToolContext } from "./types.js";

const MAX_LIST = 100;

/** The listed fields of a flow; workflow metadata only when the provider sent it. */
function summary(f: FlowSummary): Record<string, unknown> {
  return {
    id: f.id,
    name: f.name,
    startUrl: f.startUrl,
    steps: f.steps,
    ...(f.description ? { description: f.description } : {}),
    ...(f.sites ? { sites: f.sites } : {}),
    ...(f.params ? { params: f.params } : {}),
    ...(f.origin ? { origin: f.origin } : {}),
    ...(f.lastStatus !== undefined ? { lastStatus: f.lastStatus } : {}),
  };
}

/**
 * Full access only, and only when the app wired a flows provider. Lists the user's saved workflows
 * (recorded flows and workflows saved from agent runs), optionally only those for a host; reads one
 * workflow's steps so a client can follow or adapt it; and starts a replay by name or id with values
 * for its parameters. Replay runs through the desktop FlowService, which keeps its own approval
 * gate: risky steps pause for the user and secret fields are never typed unattended. This tool only
 * triggers that replay; it never bypasses the gate. Saved names and steps are returned as untrusted
 * data.
 */
export function registerRunFlowTools(ctx: ToolContext): void {
  const { register, flows } = ctx;
  if (!flows) return;

  register(
    "run_flow",
    {
      description:
        "List saved workflows (optionally for one host), read a workflow's steps, or run one with parameter values. Runs keep the approval gate; secrets are never stored or typed unattended.",
      inputSchema: {
        action: z.enum(["list", "read", "run"]).default("list"),
        flow: z.string().min(1).max(200).optional().describe("Workflow name or id; required for read and run"),
        host: z.string().min(1).max(253).optional().describe("list: only workflows that apply to this host (e.g. shop.example)"),
        params: z.record(z.string().max(60), z.string().max(2000)).optional().describe("run: values for the workflow's {{parameters}}"),
      },
    },
    async (a) => {
      const runner = flows();
      if (!runner) return errorResult("Recorded flows are unavailable in this browser build.");
      if (a.action === "run") {
        if (!a.flow) return errorResult("action 'run' requires a flow name or id.");
        const r = a.params ? await runner.run(a.flow, a.params) : await runner.run(a.flow);
        const steps = `${r.steps} step${r.steps === 1 ? "" : "s"}`;
        return text(`Started flow "${r.name}" (${steps}); status ${r.status}. Risky steps pause for your approval in Corvus.`);
      }
      if (a.action === "read") {
        if (!a.flow) return errorResult("action 'read' requires a flow name or id.");
        if (!runner.read) return errorResult("Reading workflow steps is not supported by this browser build.");
        const d = await runner.read(a.flow);
        return untrusted(`flow:${d.id}`, compactJson({ ...summary(d), params: d.paramDetails, steps: d.stepList }));
      }
      const list = (await (a.host ? runner.list(a.host) : runner.list())).slice(0, MAX_LIST);
      return untrusted(a.host ? `flows:${a.host}` : "flows", compactJson(list.map(summary)));
    },
  );
}
