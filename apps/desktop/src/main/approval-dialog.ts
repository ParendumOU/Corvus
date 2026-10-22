/**
 * The native "Allow once / Deny" dialog Corvus shows when an MCP client (which has no run panel)
 * wants to do something that always needs the person: use a saved login or 2FA code, or spend
 * money. One use per answer; Deny is the default and what Escape picks.
 */
import { dialog } from "electron";
import type { AppContext } from "./context";

export interface NativeApproval {
  title: string;
  message: string;
  detail: string;
  /** Label of the allow button ("Sign in", "Allow once"). */
  allow: string;
}

/** Shows the dialog over the focused window; resolves true only when the person allows. */
export async function askNativeApproval(ctx: AppContext, approval: NativeApproval): Promise<boolean> {
  const parent = ctx.windows.focused()?.win;
  const options: Electron.MessageBoxOptions = {
    type: "warning",
    buttons: [approval.allow, "Deny"],
    defaultId: 1,
    cancelId: 1,
    title: approval.title,
    message: approval.message,
    detail: approval.detail,
  };
  const { response } = parent ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options);
  return response === 0;
}
