import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describeSpend, isSpendClick, isSpendSubmit, isSpendUrl, spendHost, type ActionTarget, type BrowserController, type TabId } from "@corvus/shared";

/**
 * Spending money always asks the person, for every MCP client and at every access level. Before a
 * click, a type with submit, or a fill_fields submit, the tool reads the target (role, name, page and
 * form) and classifies it with the shared spend rules (@corvus/shared). A spend goes to the browser's
 * native "Allow once / Deny" dialog (controller.confirmSpend, the same kind of dialog the credential
 * tools use). Deny, or a browser that cannot ask, ends the call with a tool error and nothing is
 * clicked or submitted.
 */
export type SpendAction =
  /** A click on an element by ref. */
  | { kind: "click"; ref: string }
  /** Enter in a field by ref (type with submit): spends when its form is a checkout or payment form. */
  | { kind: "submit"; ref: string }
  /** fill_fields' submit: a click on the button it picked, on a page whose URL is known. */
  | { kind: "form-button"; name: string; role: string; url: string };

/** The element by ref: read live when the browser can, else from a fresh snapshot. */
async function readTarget(controller: BrowserController, tabId: TabId, ref: string): Promise<ActionTarget | null> {
  if (controller.describeTarget) return controller.describeTarget(tabId, ref).catch(() => null);
  const snap = await controller.snapshot(tabId, { maxChars: 0 }).catch(() => null);
  if (!snap) return null;
  const el = snap.elements.find((e) => e.ref === ref);
  return { url: snap.url, role: el?.role ?? "", name: el?.name ?? "" };
}

/** What the action does, when it spends money; null when it does not. */
async function spendDescription(controller: BrowserController, tabId: TabId, action: SpendAction): Promise<{ text: string; url: string } | null> {
  if (action.kind === "form-button") {
    const spends = isSpendClick(action.name, { role: action.role, url: action.url }) || isSpendUrl(action.url);
    return spends ? { text: describeSpend({ kind: "click", name: action.name, url: action.url }), url: action.url } : null;
  }
  const target = await readTarget(controller, tabId, action.ref);
  if (!target) return null;
  const ctx = { role: target.role, url: target.url, ...(target.form ? { form: target.form } : {}) };
  if (action.kind === "click") {
    return isSpendClick(target.name, ctx) ? { text: describeSpend({ kind: "click", name: target.name, url: target.url }), url: target.url } : null;
  }
  if (!isSpendSubmit(ctx)) return null;
  const submitName = target.form?.submitName;
  return { text: describeSpend({ kind: "submit", ...(submitName ? { submitName } : {}), url: target.url }), url: target.url };
}

function refusal(message: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text: message }] };
}

/**
 * Returns a tool error when the action spends money and the person did not allow it (or could not be
 * asked); null when it may go ahead (not a spend, or allowed once).
 */
export async function spendGate(controller: BrowserController, tabId: TabId, action: SpendAction): Promise<CallToolResult | null> {
  const spend = await spendDescription(controller, tabId, action);
  if (!spend) return null;
  if (!controller.confirmSpend) {
    return refusal(`${spend.text} spends money, and this browser cannot ask the user to allow it. Nothing was done. Call request_user_action so the user can do it.`);
  }
  const allowed = await controller.confirmSpend(tabId, { action: spend.text, host: spendHost(spend.url) });
  if (allowed) return null;
  return refusal(
    `The user declined: ${spend.text} spends money and was not allowed. Nothing was clicked or submitted. Do not retry it; if the purchase is still wanted, call request_user_action so the user can do it.`,
  );
}
