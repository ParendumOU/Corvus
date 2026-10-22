import { z } from "zod";
import { compactJson } from "../content.js";
import { errorResult, text, untrusted, type ToolContext } from "./types.js";

/**
 * Read-only: what Corvus learned about a site from earlier successful agent runs (element roles and
 * names that worked, URL shapes with values removed, obstacles such as cookie banners, the usual
 * order of steps). Standard level: it only reads, and the store never holds typed values or
 * secrets. Registered only when the app wired a site-memory provider. Returned as untrusted data.
 */
export function registerSiteMemoryTools(ctx: ToolContext): void {
  const { register, siteMemory } = ctx;
  if (!siteMemory) return;

  register(
    "site_memory",
    {
      description:
        "Read the hints Corvus learned about a site from earlier successful runs: element roles and names that worked, URL shapes, obstacles and the usual step order. Read-only; never contains typed values or secrets.",
      inputSchema: {
        host: z.string().min(1).max(2048).describe("Host such as shop.example (a full URL also works)"),
      },
      readOnly: true,
    },
    async (a) => {
      const reader = siteMemory();
      if (!reader) return errorResult("Site memory is unavailable in this browser build.");
      const res = await reader.hints(a.host);
      if (res === "disabled") return text("Site memory is turned off in Corvus settings.");
      if (!res) return text(`Corvus has not learned anything about ${JSON.stringify(a.host.slice(0, 120))} yet.`);
      return untrusted(`site-memory:${res.host}`, compactJson(res));
    },
  );
}
