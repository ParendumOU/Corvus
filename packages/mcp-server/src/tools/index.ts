import { registerCookieTools } from "./cookies.js";
import { registerDevtoolsTools } from "./devtools.js";
import { registerDownloadTools } from "./download.js";
import { registerExtractTools } from "./extract.js";
import { registerFillFieldsTools } from "./fill-fields.js";
import { registerFullTools } from "./full.js";
import { registerHandoffTools } from "./handoff.js";
import { registerRunFlowTools } from "./run-flow.js";
import { registerSemanticTools } from "./semantic.js";
import { registerSnapshotTools } from "./snapshot.js";
import { registerTabTools } from "./tabs.js";
import type { ToolContext } from "./types.js";
import { registerVisualTools } from "./visual.js";
import { registerWebscopeTools } from "./webscope.js";

export type {
  FlowProvider,
  FlowRunResult,
  FlowRunner,
  FlowSummary,
  Register,
  ToolContext,
  ToolExtra,
  WebScopeProvider,
} from "./types.js";

/** Registers the agent toolset. Access levels are enforced by ctx.register. */
export function registerAgentTools(ctx: ToolContext): void {
  registerSemanticTools(ctx);
  registerVisualTools(ctx);
  registerExtractTools(ctx);
  registerDevtoolsTools(ctx);
  registerTabTools(ctx);
  registerHandoffTools(ctx);
  registerFullTools(ctx);
  registerWebscopeTools(ctx);
  registerSnapshotTools(ctx);
  registerRunFlowTools(ctx);
  registerCookieTools(ctx);
  registerFillFieldsTools(ctx);
  registerDownloadTools(ctx);
}
