/**
 * The "Allow once / Deny" dialog Corvus shows when an MCP client (which has no run panel)
 * wants to do something that always needs the person: use a saved login or 2FA code, or spend
 * money. One use per answer; Deny is the default and what Escape picks.
 */
import type { AppContext } from "./context";
import { tr } from "./menu-i18n";

export interface NativeApproval {
  title: string;
  message: string;
  detail: string;
  /** Label of the allow button ("Sign in", "Allow once"). */
  allow: string;
}

/** Shows the dialog in the focused window; resolves true only when the person allows. */
export async function askNativeApproval(ctx: AppContext, approval: NativeApproval): Promise<boolean> {
  const { button } = await ctx.dialogs.ask({
    tone: "warning",
    buttons: [tr("Deny"), approval.allow],
    defaultId: 0,
    cancelId: 0,
    title: approval.title,
    message: approval.message,
    detail: approval.detail,
  });
  return button === 1;
}
