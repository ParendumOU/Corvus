import path from "node:path";
import { z } from "zod";
import { compactJson, truncate } from "../content.js";
import { defined, need, optionalTabId, ref, text, untrusted, type ToolContext } from "./types.js";

const MAX_RESULT_CHARS = 20_000;

function isAbsolutePath(p: string): boolean {
  return path.posix.isAbsolute(p) || path.win32.isAbsolute(p);
}

/** Full access only: code execution in pages and local file system access. */
export function registerFullTools({ controller, register, resolveTab }: ToolContext): void {
  const evaluate = controller.evaluate?.bind(controller);
  if (evaluate) {
    register(
      "evaluate",
      {
        description: "Run JavaScript in the page and return its JSON result (awaits promises).",
        inputSchema: {
          expression: z.string().min(1).max(20000),
          world: z.enum(["main", "isolated"]).default("main").describe("isolated = separate JS globals, same DOM"),
          timeoutMs: z.number().int().min(100).max(60_000).default(10_000),
          tabId: optionalTabId,
        },
      },
      async (a) => {
        const id = await resolveTab(a.tabId);
        const result = await evaluate(id, a.expression, { world: a.world, timeoutMs: a.timeoutMs });
        const serialized = JSON.stringify(result) ?? "undefined";
        return untrusted(`evaluate:${id}`, truncate(serialized, MAX_RESULT_CHARS).text);
      },
    );
  }

  register(
    "upload_file",
    {
      description: "Set local files on an <input type=file> (absolute paths).",
      inputSchema: { ref, paths: z.array(z.string().min(1).max(4096)).min(1).max(20), tabId: optionalTabId },
    },
    async (a) => {
      const bad = a.paths.find((p) => !isAbsolutePath(p));
      if (bad) throw new Error(`Not an absolute path: ${bad}`);
      const res = await need(controller.uploadFiles?.bind(controller), "upload_file")(await resolveTab(a.tabId), a.ref, a.paths);
      return text(`uploaded ${res.files} file(s)`);
    },
  );

  register(
    "pdf",
    {
      description: "Save the page as PDF into the Downloads folder.",
      inputSchema: { landscape: z.boolean().optional(), printBackground: z.boolean().optional(), tabId: optionalTabId },
    },
    async (a) => {
      const res = await need(controller.pdf?.bind(controller), "pdf")(await resolveTab(a.tabId), defined({ landscape: a.landscape, printBackground: a.printBackground }));
      return text(compactJson(res));
    },
  );

  register(
    "downloads_list",
    { description: "Recent downloads with state and file path.", inputSchema: { limit: z.number().int().min(1).max(200).default(20) }, readOnly: true },
    async (a) => {
      const rows = await need(controller.listDownloads?.bind(controller), "downloads_list")(a.limit);
      return untrusted("downloads", rows.length ? rows.map((d) => compactJson(d)).join("\n") : "no downloads");
    },
  );
}
