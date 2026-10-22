import { z } from "zod";
import { compactJson } from "../content.js";
import { errorResult, text, untrusted, type ToolContext } from "./types.js";

const MAX_LIST = 100;

/**
 * Full access only, and only when the app wired a flows provider. Lists the user's saved recorded
 * flows and starts a replay by name or id. Replay runs through the desktop FlowService, which keeps
 * its own approval gate: risky steps pause for the user and secret fields are never typed unattended.
 * This tool only triggers that replay — it never bypasses the gate.
 */
export function registerRunFlowTools(ctx: ToolContext): void {
  const { register, flows } = ctx;
  if (!flows) return;

  register(
    "run_flow",
    {
      description: "List or replay a saved recorded flow. Replay keeps its approval gate; secrets never run unattended.",
      inputSchema: {
        action: z.enum(["list", "run"]).default("list"),
        flow: z.string().min(1).max(200).optional().describe("Flow name or id; required when action is run"),
      },
    },
    async (a) => {
      const runner = flows();
      if (!runner) return errorResult("Recorded flows are unavailable in this browser build.");
      if (a.action === "run") {
        if (!a.flow) return errorResult("action 'run' requires a flow name or id.");
        const r = await runner.run(a.flow);
        const steps = `${r.steps} step${r.steps === 1 ? "" : "s"}`;
        return text(`Started flow "${r.name}" (${steps}); status ${r.status}. Risky steps pause for your approval in Corvus.`);
      }
      const list = (await runner.list()).slice(0, MAX_LIST);
      return untrusted("flows", compactJson(list.map((f) => ({ id: f.id, name: f.name, startUrl: f.startUrl, steps: f.steps }))));
    },
  );
}
