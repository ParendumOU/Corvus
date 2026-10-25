/**
 * request_user_action for MCP clients: an AI client asks the person to do one step in a tab (sign
 * in, a payment, a 2FA code, anything it cannot or may not do). The tab comes to the front and a
 * native dialog says what was asked, with Done and Cancel. The dialog has no parent window, so the
 * page stays usable while it is open, and it closes by itself at the timeout or when the client
 * gives up. The Command Bar agent asks in its run panel instead (ask_user).
 */
import type { UserActionResult } from "@corvus/shared";
import { dialog } from "electron";
import { tr } from "./menu-i18n";

export interface UserActionPrompt {
  /** Who asks: the MCP client's name, or "" when unknown. */
  client: string;
  /** What the client asks the person to do (its own words, shown as plain text). */
  message: string;
  /** Host of the tab it is about. */
  host: string;
}

/** Answers a prompt without a person (smoke tests). */
export type UserActionAnswer = (prompt: UserActionPrompt) => Promise<"done" | "cancelled"> | "done" | "cancelled";

/** The dialog's text (also what the smoke test checks). */
export function userActionDialog(prompt: UserActionPrompt): { title: string; message: string; detail: string } {
  const vars = { client: prompt.client, host: prompt.host };
  const message = prompt.client
    ? prompt.host
      ? tr("\"{client}\" asks you to do this in the tab on {host}:", vars)
      : tr("\"{client}\" asks you to do this in the tab:", vars)
    : prompt.host
      ? tr("An AI agent asks you to do this in the tab on {host}:", vars)
      : tr("An AI agent asks you to do this in the tab:");
  return {
    title: tr("AI agent needs you"),
    message,
    detail: `${prompt.message.trim().slice(0, 500)}\n\n${tr("Click Done when you have finished, or Cancel to tell it you will not do it.")}`,
  };
}

export class UserActionService {
  private testAnswer: UserActionAnswer | null = null;

  /** Smoke tests answer without a person; null restores the dialog. */
  setTestAnswer(answer: UserActionAnswer | null): void {
    this.testAnswer = answer;
  }

  /** Shows the request until the person answers, the timeout passes or `signal` aborts. */
  async ask(prompt: UserActionPrompt, timeoutMs: number, signal?: AbortSignal): Promise<UserActionResult> {
    const started = Date.now();
    const controller = new AbortController();
    const stop = (): void => controller.abort();
    const timer = setTimeout(stop, Math.max(1000, timeoutMs));
    signal?.addEventListener("abort", stop, { once: true });
    try {
      if (this.testAnswer) {
        const outcome = await this.testAnswer(prompt);
        return { outcome, waitedMs: Date.now() - started };
      }
      const text = userActionDialog(prompt);
      const res = await dialog.showMessageBox({
        type: "info",
        title: text.title,
        message: text.message,
        detail: text.detail,
        buttons: [tr("Done"), tr("Cancel")],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
        signal: controller.signal,
      });
      const outcome = controller.signal.aborted ? "timeout" : res.response === 0 ? "done" : "cancelled";
      return { outcome, waitedMs: Date.now() - started };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", stop);
    }
  }
}
