import { z } from "zod";
import { compactJson, truncate } from "../content.js";
import { spendGate } from "../spend-gate.js";
import { defined, need, optionalTabId, untrusted, type ToolContext } from "./types.js";

function size(bytes: number | undefined): string {
  if (bytes === undefined) return "";
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)}MB` : bytes >= 1024 ? `${(bytes / 1024).toFixed(1)}kB` : `${bytes}B`;
}

export function registerDevtoolsTools({ controller, register, resolveTab }: ToolContext): void {
  register(
    "console_messages",
    {
      description: "Recent console messages and uncaught errors of a tab.",
      requires: "consoleMessages",
      inputSchema: {
        level: z.enum(["error", "warning", "info", "debug"]).optional().describe("Minimum level"),
        limit: z.number().int().min(1).max(200).default(50),
        clear: z.boolean().optional().describe("Clear the buffer after reading"),
        tabId: optionalTabId,
      },
      readOnly: true,
    },
    async (a) => {
      const id = await resolveTab(a.tabId);
      const rows = await need(controller.consoleMessages?.bind(controller), "console_messages")(id, defined({ level: a.level, limit: a.limit, clear: a.clear }));
      const lines = rows.map((m) => `[${m.level}] ${truncate(m.text.replace(/\s+/g, " "), 500).text}${m.source ? ` (${truncate(m.source, 120).text})` : ""}`);
      return untrusted(`console:${id}`, lines.length ? lines.join("\n") : "no messages");
    },
  );

  register(
    "network_requests",
    {
      description: "Recent network requests of a tab (method, status, type, size, time, URL).",
      requires: "networkRequests",
      inputSchema: {
        filter: z.string().min(1).max(500).optional().describe("URL substring"),
        failedOnly: z.boolean().optional().describe("Only failed or >= 400"),
        limit: z.number().int().min(1).max(300).default(50),
        clear: z.boolean().optional(),
        tabId: optionalTabId,
      },
      readOnly: true,
    },
    async (a) => {
      const id = await resolveTab(a.tabId);
      const rows = await need(controller.networkRequests?.bind(controller), "network_requests")(
        id,
        defined({ filter: a.filter, failedOnly: a.failedOnly, limit: a.limit, clear: a.clear }),
      );
      const lines = rows.map((r) =>
        [r.method, r.failed ? `FAILED(${r.failed})` : (r.status ?? "..."), r.type ?? "", size(r.bytes), r.durationMs !== undefined ? `${r.durationMs}ms` : "", truncate(r.url, 300).text]
          .filter((p) => p !== "")
          .join(" "),
      );
      return untrusted(`network:${id}`, lines.length ? lines.join("\n") : "no requests recorded (recording starts when an agent first touches the tab)");
    },
  );

  register(
    "handle_dialog",
    {
      description: "Accept or dismiss an open alert/confirm/prompt/beforeunload dialog.",
      requires: "handleDialog",
      inputSchema: {
        accept: z.boolean(),
        promptText: z.string().max(10000).optional().describe("Answer for prompt()"),
        tabId: optionalTabId,
      },
    },
    async (a) => {
      const id = await resolveTab(a.tabId);
      const handle = need(controller.handleDialog?.bind(controller), "handle_dialog");
      if (a.accept) {
        const refused = await spendGate(controller, id, { kind: "dialog" });
        if (refused) return refused;
      }
      const dialog = await handle(id, defined({ accept: a.accept, promptText: a.promptText }));
      const extra = dialog.type === "beforeunload" && a.accept ? " Leaving is now allowed: retry the navigation or tab_close." : "";
      return untrusted(dialog.url, compactJson({ handled: dialog.type, accepted: a.accept, message: dialog.message }), extra ? extra.trim() : undefined);
    },
  );
}
