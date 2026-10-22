/**
 * Spending money always asks the person. The Command Bar agent asks in its run panel; MCP clients
 * (and workflow replays they start) have no panel, so they get this native dialog, at every access
 * level: "An AI client wants to spend money: Click "Place order" on shop.example." with Allow once /
 * Deny. Each answer covers one action.
 */
import type { AppContext } from "./context";
import { askNativeApproval, type NativeApproval } from "./approval-dialog";

export interface SpendPrompt {
  /** Who asks: the MCP client's name, or "" when unknown. */
  client: string;
  /** What it does, e.g. `Click "Place order" on shop.example`. */
  action: string;
  host: string;
}

/** Answers a spend prompt; resolves true to allow this one action. */
export type SpendApprover = (prompt: SpendPrompt) => Promise<boolean> | boolean;

/** The dialog's text (also what the smoke test checks). */
export function spendDialog(prompt: SpendPrompt): NativeApproval {
  const action = prompt.action.replace(/[.\s]+$/, "");
  const who = prompt.client ? `"${prompt.client}" asked for this.` : "An AI agent asked for this.";
  return {
    title: "AI agent wants to spend money",
    message: `An AI client wants to spend money: ${action}.`,
    detail: `${who}\n\nAllow once lets only this action through. Corvus asks again before anything else that spends money.`,
    allow: "Allow once",
  };
}

export class SpendApprovalService {
  private testApprover: SpendApprover | null = null;

  constructor(private readonly ctx: AppContext) {}

  /** Smoke tests answer the dialog without a person; null restores the dialog. */
  setTestApprover(approver: SpendApprover | null): void {
    this.testApprover = approver;
  }

  /** Asks the person to allow one money-spending action. */
  async confirm(prompt: SpendPrompt): Promise<boolean> {
    if (this.testApprover) return (await this.testApprover(prompt)) === true;
    return askNativeApproval(this.ctx, spendDialog(prompt));
  }
}
