import { z } from "zod";
import { need, optionalTabId, text, type ToolContext } from "./types.js";

const PROGRESS_INTERVAL_MS = 10_000;

export function registerHandoffTools({ controller, register, resolveTab }: ToolContext): void {
  register(
    "request_user_action",
    {
      description: "Ask the user to do something in a tab (CAPTCHA, 2FA, login, payment). Blocks until Done/Cancel.",
      requires: "requestUserAction",
      inputSchema: {
        message: z.string().min(1).max(500).describe("What the user should do, shown in a banner"),
        timeoutSeconds: z.number().int().min(10).max(1800).default(300),
        tabId: optionalTabId,
      },
    },
    async (a, signal, extra) => {
      const ask = need(controller.requestUserAction?.bind(controller), "request_user_action");
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
        const res = await ask(id, { message: a.message, timeoutMs: a.timeoutSeconds * 1000 }, signal);
        const secs = Math.round(res.waitedMs / 1000);
        if (res.outcome === "done") return text(`done: the user finished after ${secs}s. Take a new page_snapshot or screenshot before continuing.`);
        if (res.outcome === "cancelled") return text(`cancelled: the user declined after ${secs}s. Do not retry this step without asking the user.`);
        return text(`timeout: no answer within ${a.timeoutSeconds}s. Ask the user in chat before trying again.`);
      } finally {
        if (timer) clearInterval(timer);
      }
    },
  );
}
