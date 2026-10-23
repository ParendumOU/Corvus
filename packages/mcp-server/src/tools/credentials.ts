import type { CredentialFillResult } from "@corvus/shared";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { need, optionalTabId, ref, text, type ToolContext } from "./types.js";

const username = z.string().min(1).max(512).optional().describe("Which saved login to use when the site has several");

function result(outcome: CredentialFillResult): CallToolResult {
  return outcome.status === "error" ? { isError: true, content: [{ type: "text", text: outcome.message }] } : text(outcome.message);
}

/**
 * Full access only. Saved logins and 2FA codes by reference: the browser fills the value itself, only
 * for logins the user opted in (plus a global setting, both off by default) and only after the user
 * approves this one use in a browser dialog. The tool result says what was filled and never contains
 * the password, the code or the 2FA secret. Without the opt-ins the result asks for a human handoff
 * (request_user_action), which is the behaviour of browsers without this feature.
 */
export function registerCredentialTools({ controller, register, resolveTab }: ToolContext): void {
  register(
    "fill_totp",
    {
      description:
        "Fill the user's saved 2FA code into a field once they approve; you never see it. Else: request_user_action.",
      requires: "fillTotp",
      inputSchema: { ref, username, tabId: optionalTabId },
    },
    async (a) => {
      const fill = need(controller.fillTotp?.bind(controller), "fill_totp");
      const id = await resolveTab(a.tabId);
      return result(await fill(id, a.ref, a.username ? { username: a.username } : {}));
    },
  );

  register(
    "fill_login",
    {
      description:
        "Fill the user's saved login into the sign-in form once they approve; you never see it. Else: request_user_action.",
      requires: "fillLogin",
      inputSchema: { ref: ref.optional(), username, tabId: optionalTabId },
    },
    async (a) => {
      const fill = need(controller.fillLogin?.bind(controller), "fill_login");
      const id = await resolveTab(a.tabId);
      return result(await fill(id, { ...(a.ref ? { ref: a.ref } : {}), ...(a.username ? { username: a.username } : {}) }));
    },
  );
}
