import { z } from "zod";
import { errorResult, need, untrusted, type ToolContext } from "./types.js";

/**
 * Full access only. Corvus's own download queue: packages of files downloaded a few at a time,
 * resumable, checked against their checksum files and extracted when complete. Adding files asks
 * the user in the browser first, and programs are never queued for an agent.
 */
export function registerDownloadQueueTools({ controller, register, client }: ToolContext): void {
  const run = async (request: Record<string, unknown>) => {
    try {
      return untrusted("download_queue", await need(controller.downloadQueue?.bind(controller), "download_queue")(request, client()));
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err));
    }
  };

  register(
    "download_queue",
    { description: "Corvus's download queue: packages, files, progress, checksums and extraction.", requires: "downloadQueue", inputSchema: {}, readOnly: true },
    async () => run({ action: "list" }),
  );

  register(
    "download_queue_add",
    {
      description: "Queue files by direct link (the user approves first; archives are extracted when complete).",
      requires: "downloadQueue",
      inputSchema: {
        links: z.array(z.string().min(1).max(8192)).min(1).max(200).describe("Direct http(s) links to the files (all volumes of a split archive)"),
        packageName: z.string().min(1).max(120).optional().describe("Package (folder) name; default: the archive or file name"),
        password: z.string().min(1).max(200).optional().describe("Archive password the page gives"),
      },
    },
    async (a) => run({ action: "add", links: a.links, ...(a.packageName ? { packageName: a.packageName } : {}), ...(a.password ? { password: a.password } : {}) }),
  );

  register(
    "download_queue_control",
    {
      description: "Pause, resume, retry, remove or extract a queued package or file (ids from download_queue).",
      requires: "downloadQueue",
      inputSchema: {
        id: z.string().min(1).max(64).describe("Package or file id"),
        op: z.enum(["pause", "resume", "retry", "remove", "extract"]),
        password: z.string().min(1).max(200).optional().describe("extract: archive password to try first"),
      },
    },
    async (a) => run({ action: "control", id: a.id, op: a.op, ...(a.password ? { password: a.password } : {}) }),
  );
}
