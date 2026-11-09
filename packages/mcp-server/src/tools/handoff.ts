import { z } from "zod";
import type { UserActionBlock, UserActionResult } from "@corvus/shared";
import { need, optionalTabId, text, type ToolContext } from "./types.js";

const PROGRESS_INTERVAL_MS = 10_000;

const name = z.string().min(1).max(60);
const label = z.string().min(1).max(200);
const block = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("text"), text: z.string().min(1).max(4000) }),
  z.object({ kind: z.literal("steps"), items: z.array(z.string().min(1).max(500)).min(1).max(20) }),
  z.object({ kind: z.literal("copy"), label: label.optional(), value: z.string().min(1).max(4000) }),
  z.object({
    kind: z.literal("input"),
    name,
    label,
    value: z.string().max(4000).optional(),
    placeholder: z.string().max(200).optional(),
    required: z.boolean().optional(),
    multiline: z.boolean().optional(),
  }),
  z.object({ kind: z.literal("select"), name, label, options: z.array(z.string().min(1).max(200)).min(1).max(50), value: z.string().max(200).optional(), required: z.boolean().optional() }),
  z.object({ kind: z.literal("checkbox"), name, label, checked: z.boolean().optional() }),
]);

/** What the schema cannot say about a request's blocks, or null when they are fine. */
function blocksProblem(blocks: UserActionBlock[]): string | null {
  const seen = new Set<string>();
  for (const b of blocks) {
    if (!("name" in b)) continue;
    if (seen.has(b.name)) return `Two fields are named "${b.name}"`;
    seen.add(b.name);
    if (b.kind === "select" && b.value !== undefined && !b.options.includes(b.value)) return `"${b.value}" is not one of the options of "${b.name}"`;
  }
  return null;
}

/** What the person answered besides finishing, for the tool's reply. */
function answered(res: UserActionResult): string {
  const parts: string[] = [];
  if (res.action) parts.push(`They pressed ${JSON.stringify(res.action)}.`);
  if (res.values) parts.push(`They filled in: ${JSON.stringify(res.values)}.`);
  return parts.length ? ` ${parts.join(" ")}` : "";
}

export function registerHandoffTools({ controller, register, resolveTab }: ToolContext): void {
  register(
    "request_user_action",
    {
      description: "Ask the user to do or answer something in a tab (CAPTCHA, 2FA, login, payment). Blocks until answered.",
      requires: "requestUserAction",
      personTab: true,
      inputSchema: {
        message: z.string().min(1).max(500).describe("What you need, in a sentence; put anything longer in blocks"),
        blocks: z.array(block).min(1).max(20).optional().describe("Shown under the message in order: long text, steps, values to copy, form fields (returned by name; never ask for passwords or codes)"),
        actions: z.array(z.string().min(1).max(40)).min(1).max(3).optional().describe("Button labels instead of Done; Cancel is always there"),
        timeoutSeconds: z.number().int().min(10).max(1800).default(300),
        tabId: optionalTabId,
      },
    },
    async (a, signal, extra) => {
      const ask = need(controller.requestUserAction?.bind(controller), "request_user_action");
      const problem = a.blocks ? blocksProblem(a.blocks) : null;
      if (problem) throw new Error(problem);
      const id = await resolveTab(a.tabId);
      const progressToken = extra._meta?.progressToken;
      let ticks = 0;
      const timer =
        progressToken !== undefined
          ? setInterval(() => {
              ticks += 1;
              void extra
                .sendNotification({
                  method: "notifications/progress",
                  params: { progressToken, progress: ticks, message: "Waiting for the user" },
                })
                .catch(() => undefined);
            }, PROGRESS_INTERVAL_MS)
          : undefined;
      try {
        const res = await ask(id, { message: a.message, timeoutMs: a.timeoutSeconds * 1000, ...(a.blocks ? { blocks: a.blocks } : {}), ...(a.actions ? { actions: a.actions } : {}) }, signal);
        const secs = Math.round(res.waitedMs / 1000);
        if (res.outcome === "done") return text(`done: the user finished after ${secs}s.${answered(res)} Take a new page_snapshot or screenshot before continuing.`);
        if (res.outcome === "cancelled") return text(`cancelled: the user declined after ${secs}s. Do not retry this step without asking the user.`);
        if (res.outcome === "closed") return text(`closed: the tab was closed after ${secs}s before the user answered. Use tabs_list to see what is open; ask the user in chat before trying again.`);
        return text(`timeout: no answer within ${a.timeoutSeconds}s. Ask the user in chat before trying again.`);
      } finally {
        if (timer) clearInterval(timer);
      }
    },
  );
}
