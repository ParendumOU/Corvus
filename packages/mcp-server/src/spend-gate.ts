import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describeSpend, isSpendClick, isSpendConfirm, isSpendSubmit, isSpendUrl, spendHost, type ActionTarget, type BrowserController, type PointTarget, type TabId } from "@corvus/shared";

/**
 * Spending money always asks the person, for every MCP client and at every access level. Before a
 * click, a type with submit, a fill_fields submit, a click at coordinates, Enter/Space/a line break
 * into the focused element, or accepting the page's own confirm() question, the tool reads the target (role, name, page and form) and classifies it
 * with the shared spend rules (@corvus/shared). A spend goes to the browser's
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
  | { kind: "form-button"; name: string; role: string; url: string }
  /** A click at viewport coordinates (click_at, double_click_at): read through describePoint. */
  | { kind: "point"; x: number; y: number }
  /** Enter (or a line break) or Space into the focused element: read through describeFocused. */
  | { kind: "focused"; key: "enter" | "space" }
  /** Accepting the page's open confirm() or prompt() (handle_dialog): read through pendingDialog. */
  | { kind: "dialog" };

/** A spend to ask about, or a target the browser could not read (the action is refused then). */
type SpendCheck = { text: string; url: string } | { unreadable: string } | null;

const FIELD_ROLES = new Set(["textbox", "searchbox", "combobox"]);

/** A coordinate click or an activation key on what describePoint / describeFocused returned. */
function pointSpend(target: PointTarget, what: string): SpendCheck {
  const ctx = { role: target.role, url: target.url, ...(target.form ? { form: target.form } : {}) };
  const host = spendHost(target.url);
  if (target.payFrame) return { text: `${what} inside a payment form (${target.frame ?? "embedded frame"})${host ? ` on ${host}` : ""}`, url: target.url };
  if (target.frame) return isSpendUrl(target.url) ? { text: `${what} inside an embedded frame (${target.frame}) on a checkout page${host ? ` (${host})` : ""}`, url: target.url } : null;
  if (what === "Press Enter" && FIELD_ROLES.has(target.role)) {
    if (!isSpendSubmit(ctx)) return null;
    const submitName = target.form?.submitName;
    return { text: describeSpend({ kind: "submit", ...(submitName ? { submitName } : {}), url: target.url }), url: target.url };
  }
  for (const label of [target.name, target.text ?? ""]) {
    if (label && isSpendClick(label, ctx)) return { text: describeSpend({ kind: "click", name: label, url: target.url }), url: target.url };
  }
  return null;
}

/** The element by ref: read live when the browser can, else from a fresh snapshot. */
async function readTarget(controller: BrowserController, tabId: TabId, ref: string): Promise<ActionTarget | null> {
  if (controller.describeTarget) return controller.describeTarget(tabId, ref).catch(() => null);
  const snap = await controller.snapshot(tabId, { maxChars: 0 }).catch(() => null);
  if (!snap) return null;
  const el = snap.elements.find((e) => e.ref === ref);
  return { url: snap.url, role: el?.role ?? "", name: el?.name ?? "" };
}

/** What the action does, when it spends money; null when it does not. */
async function spendDescription(controller: BrowserController, tabId: TabId, action: SpendAction): Promise<SpendCheck> {
  if (action.kind === "point") {
    const where = `(${Math.round(action.x)}, ${Math.round(action.y)})`;
    if (!controller.describePoint) return { unreadable: `This browser cannot check what is at ${where}, so clicks at coordinates are not allowed.` };
    const target = await controller.describePoint(tabId, { x: action.x, y: action.y }).catch(() => null);
    if (!target) return { unreadable: `Could not read what is at ${where}; nothing was clicked. Take a new screenshot and retry.` };
    return pointSpend(target, "Click");
  }
  if (action.kind === "focused") {
    if (!controller.describeFocused) return { unreadable: "This browser cannot check the focused element, so Enter and Space are not allowed here." };
    const target = await controller.describeFocused(tabId).catch(() => null);
    if (!target) return { unreadable: "Could not read the focused element; nothing was pressed. Take a new page_snapshot and retry." };
    // Space in a text field types a space; on a button or link it activates it.
    if (target.none || (action.key === "space" && FIELD_ROLES.has(target.role))) return null;
    return pointSpend(target, action.key === "enter" ? "Press Enter" : "Press Space");
  }
  if (action.kind === "dialog") {
    if (!controller.pendingDialog) return { unreadable: "This browser cannot read the page's question, so it cannot be accepted. Call request_user_action so the user can answer it." };
    const dialog = await controller.pendingDialog(tabId).catch(() => null);
    if (!dialog || (dialog.type !== "confirm" && dialog.type !== "prompt") || !isSpendConfirm(dialog.message, dialog.url)) return null;
    const question = dialog.message.length > 80 ? `${dialog.message.slice(0, 77)}...` : dialog.message;
    const host = spendHost(dialog.url);
    return { text: `Answer OK to the page's question "${question}"${host ? ` on ${host}` : ""}`, url: dialog.url };
  }
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
  if ("unreadable" in spend) return refusal(spend.unreadable);
  if (!controller.confirmSpend) {
    return refusal(`${spend.text} spends money, and this browser cannot ask the user to allow it. Nothing was done. Call request_user_action so the user can do it.`);
  }
  const allowed = await controller.confirmSpend(tabId, { action: spend.text, host: spendHost(spend.url) });
  if (allowed) return null;
  return refusal(
    `The user declined: ${spend.text} spends money and was not allowed. Nothing was clicked or submitted. Do not retry it; if the purchase is still wanted, call request_user_action so the user can do it.`,
  );
}
