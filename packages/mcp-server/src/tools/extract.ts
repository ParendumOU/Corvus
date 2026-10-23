import type { ExtractResult } from "@corvus/shared";
import { z } from "zod";
import { compactJson, truncate } from "../content.js";
import { defined, need, optionalTabId, ref, untrusted, type ToolContext } from "./types.js";

const MAX_CHARS = 50_000;

function renderExtract(r: ExtractResult, maxChars: number): string {
  const header = compactJson({ url: r.url, title: r.title, truncated: r.truncated || undefined });
  let body = "";
  if (r.markdown !== undefined) body = r.markdown;
  else if (r.tables) body = r.tables.length ? r.tables.map((t) => compactJson(t)).join("\n") : "no tables";
  else if (r.links) body = r.links.length ? r.links.map((l) => `${l.text || "(no text)"} | ${l.href}`).join("\n") : "no links";
  else if (r.metadata) body = compactJson(r.metadata);
  const cut = truncate(body, maxChars);
  return `${header}\n${cut.text}${cut.truncated ? "\n[truncated]" : ""}`;
}

export function registerExtractTools({ controller, register, resolveTab }: ToolContext): void {
  register(
    "get_text",
    {
      description: "Plain text of an element (ref) or of the page's main content.",
      requires: "getText",
      inputSchema: { ref: ref.optional(), maxChars: z.number().int().min(100).max(MAX_CHARS).default(4000), tabId: optionalTabId },
      readOnly: true,
    },
    async (a) => {
      const id = await resolveTab(a.tabId);
      const res = await need(controller.getText?.bind(controller), "get_text")(id, defined({ ref: a.ref, maxChars: a.maxChars }));
      return untrusted(`get_text:${id}`, res.truncated ? `${res.text}\n[truncated]` : res.text);
    },
  );

  register(
    "extract",
    {
      description: "Extract structured data: main content as markdown, tables as JSON, links, or metadata/OpenGraph.",
      requires: "extract",
      inputSchema: {
        kind: z.enum(["markdown", "tables", "links", "metadata"]),
        ref: ref.optional().describe("Limit to this element"),
        maxChars: z.number().int().min(200).max(MAX_CHARS).default(8000),
        limit: z.number().int().min(1).max(500).default(30).describe("Max tables, rows per table, or links"),
        tabId: optionalTabId,
      },
      readOnly: true,
    },
    async (a) => {
      const id = await resolveTab(a.tabId);
      const res = await need(controller.extract?.bind(controller), "extract")(id, defined({ kind: a.kind, ref: a.ref, maxChars: a.maxChars, limit: a.limit }));
      return untrusted(res.url, renderExtract(res, a.maxChars));
    },
  );

  register(
    "get_html",
    {
      description: "Trimmed outerHTML of an element (ref or CSS selector); scripts, styles and SVG bodies removed.",
      requires: "getHtml",
      inputSchema: {
        ref: ref.optional(),
        selector: z.string().min(1).max(1000).optional(),
        maxChars: z.number().int().min(100).max(MAX_CHARS).default(4000),
        tabId: optionalTabId,
      },
      readOnly: true,
    },
    async (a) => {
      const id = await resolveTab(a.tabId);
      const res = await need(controller.getHtml?.bind(controller), "get_html")(id, defined({ ref: a.ref, selector: a.selector, maxChars: a.maxChars }));
      return untrusted(`get_html:${id}`, res.truncated ? `${res.html}\n[truncated]` : res.html);
    },
  );
}
