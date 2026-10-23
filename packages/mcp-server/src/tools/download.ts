import { z } from "zod";
import { checkAgentUrl, compactJson } from "../content.js";
import { need, optionalTabId, untrusted, type ToolContext } from "./types.js";

const DEFAULT_MAX_BYTES = 50 * 1024 * 1024;
const HARD_MAX_BYTES = 500 * 1024 * 1024;

/**
 * Full access only. Fetches an http(s) URL into the browser's downloads folder through the controller's
 * normal download path (which keeps the existing per-download safety, e.g. holding executables for the
 * user). Size is bounded by maxBytes so an agent cannot fill the disk.
 */
export function registerDownloadTools({ controller, register, resolveTab }: ToolContext): void {
  register(
    "download",
    {
      description: "Download an http(s) URL into the browser's downloads folder (size-capped).",
      requires: "download",
      inputSchema: {
        url: z.string().min(1).max(8192).describe("Absolute http(s) URL"),
        maxBytes: z.number().int().min(1).max(HARD_MAX_BYTES).optional().describe(`Size cap in bytes; default ${DEFAULT_MAX_BYTES}`),
        tabId: optionalTabId,
      },
    },
    async (a) => {
      const target = checkAgentUrl(a.url);
      const id = await resolveTab(a.tabId);
      const maxBytes = Math.min(a.maxBytes ?? DEFAULT_MAX_BYTES, HARD_MAX_BYTES);
      const entry = await need(controller.download?.bind(controller), "download")(id, target, { maxBytes });
      return untrusted("download", compactJson(entry));
    },
  );
}
