import { z } from "zod";
import { compactJson, truncate } from "../content.js";
import { defined, errorResult, need, optionalTabId, text, untrusted, type ToolContext } from "./types.js";

const MAX_COOKIES = 200;
const MAX_VALUE = 1024;

/**
 * Full access only. Reads cookies for the active tab's current site (and clears one by name). The
 * controller scopes reads to that tab's origin, so another site's cookies are never exposed. Values
 * come from web servers and are wrapped as untrusted content.
 */
export function registerCookieTools({ controller, register, resolveTab }: ToolContext): void {
  register(
    "cookies",
    {
      description: "List cookies for the active tab's site, or clear one by name. Only the current site's cookies are shown.",
      requires: "cookies",
      inputSchema: {
        action: z.enum(["list", "clear"]).default("list"),
        name: z.string().min(1).max(4096).optional().describe("Cookie name; required when action is clear"),
        tabId: optionalTabId,
      },
    },
    async (a) => {
      const id = await resolveTab(a.tabId);
      if (a.action === "clear") {
        if (!a.name) return errorResult("action 'clear' requires a cookie name.");
        const res = await need(controller.clearCookie?.bind(controller), "cookies")(id, a.name);
        return text(`removed ${res.removed} cookie(s) named ${a.name}`);
      }
      const all = await need(controller.cookies?.bind(controller), "cookies")(id);
      const rows = all.slice(0, MAX_COOKIES).map((c) =>
        defined({
          name: c.name,
          value: truncate(c.value, MAX_VALUE).text,
          domain: c.domain,
          path: c.path,
          secure: c.secure,
          httpOnly: c.httpOnly,
          session: c.session,
          expiresAt: c.expiresAt,
          sameSite: c.sameSite,
        }),
      );
      return untrusted("cookies", compactJson({ cookies: rows, total: all.length, omitted: Math.max(0, all.length - rows.length) || undefined }));
    },
  );
}
