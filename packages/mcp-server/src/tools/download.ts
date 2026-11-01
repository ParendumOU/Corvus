import type { DownloadEntry } from "@corvus/shared";
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

  register(
    "wait_for_download",
    {
      description:
        "Wait for a recent download (e.g. one a click just started) to finish; returns its state and file path.",
      requires: "listDownloads",
      inputSchema: {
        urlContains: z.string().min(1).max(2000).optional().describe("Only a download whose URL contains this"),
        filenameContains: z.string().min(1).max(500).optional().describe("Only a download whose file name contains this (case-insensitive)"),
        sinceSeconds: z.number().int().min(0).max(3600).default(30).describe("Also match downloads started this long before the call"),
        timeoutMs: z.number().int().min(100).max(600_000).default(60_000),
      },
      readOnly: true,
    },
    async (a, signal) => {
      const list = need(controller.listDownloads?.bind(controller), "wait_for_download");
      const since = Date.now() - a.sinceSeconds * 1000;
      const deadline = Date.now() + a.timeoutMs;
      const name = a.filenameContains?.toLowerCase();
      const matches = (d: DownloadEntry): boolean =>
        d.startedAt >= since && (!a.urlContains || d.url.includes(a.urlContains)) && (!name || d.filename.toLowerCase().includes(name));
      let last: DownloadEntry | undefined;
      for (;;) {
        const rows = (await list(200)).filter(matches);
        // Oldest match first: the download the agent started, not one that began while it waited.
        last = rows.sort((x, y) => x.startedAt - y.startedAt)[0];
        if (last && last.state === "blocked") {
          return untrusted("download", `blocked: the browser holds this file until the user keeps or discards it in the downloads panel. ${compactJson(last)}`);
        }
        if (last && FINISHED.has(last.state)) return untrusted("download", `${last.state}: ${compactJson(last)}`);
        if (Date.now() >= deadline || signal?.aborted) break;
        await sleep(Math.min(POLL_MS, Math.max(0, deadline - Date.now())), signal);
      }
      return untrusted(
        "download",
        last
          ? `timeout: still ${last.state} after ${a.timeoutMs} ms (${last.receivedBytes} of ${last.totalBytes || "?"} bytes). ${compactJson(last)}`
          : `timeout: no matching download started within ${a.timeoutMs} ms.`,
      );
    },
  );
}

const POLL_MS = 250;
const FINISHED = new Set(["completed", "cancelled", "interrupted"]);

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}
