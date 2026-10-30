/**
 * request_user_action for MCP clients: an AI client asks the person to do one step in a tab (sign
 * in, a payment, a 2FA code, anything it cannot or may not do). Nothing moves under the person: a
 * bar in the tab's window says what was asked, with Done and Cancel (and Go to tab while another
 * tab is shown), and the tab pulses in the strip until the request ends. A window that is not
 * focused flashes in the taskbar instead of coming to the front. The bar is not a modal, so the
 * page stays usable while it is open, and it closes by itself at the timeout, when the client gives
 * up or when the tab closes. The Command Bar agent asks in its run panel instead (ask_user).
 */
import type { TabId, UserActionResult } from "@corvus/shared";
import type { AppContext } from "./context";
import { tr } from "./menu-i18n";
import type { BrowserWindowCtl } from "./window";

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

/** A request waiting for the person. */
interface Waiting {
  tabId: TabId;
  /** The window that held the tab when it asked (its bar and taskbar flash). */
  window: BrowserWindowCtl;
  /** Ends the request as cancelled (its tab closed). */
  cancel: () => void;
}

export class UserActionService {
  private testAnswer: UserActionAnswer | null = null;
  private readonly waiting = new Set<Waiting>();

  constructor(private readonly ctx: AppContext) {}

  /** Smoke tests answer without a person; null restores the dialog. */
  setTestAnswer(answer: UserActionAnswer | null): void {
    this.testAnswer = answer;
  }

  /** A request waits for the person in this tab (its strip entry pulses). */
  needsYou(tabId: TabId): boolean {
    return [...this.waiting].some((w) => w.tabId === tabId);
  }

  /** The tab closed: what was asked in it ends as cancelled. */
  forgetTab(tabId: TabId): void {
    for (const w of [...this.waiting]) if (w.tabId === tabId) w.cancel();
  }

  /** Shows the request in the tab's window until the person answers, the timeout passes, `signal` aborts or the tab closes. */
  async ask(tabId: TabId, prompt: UserActionPrompt, timeoutMs: number, signal?: AbortSignal): Promise<UserActionResult> {
    const window = this.ctx.windows.findTab(tabId)?.window;
    if (!window) return { outcome: "cancelled", waitedMs: 0 };
    const started = Date.now();
    const controller = new AbortController();
    const stop = (): void => controller.abort();
    let closed = false;
    const timer = setTimeout(stop, Math.max(1000, timeoutMs));
    signal?.addEventListener("abort", stop, { once: true });
    if (signal?.aborted) stop();
    const entry: Waiting = {
      tabId,
      window,
      cancel: () => {
        closed = true;
        stop();
      },
    };
    this.waiting.add(entry);
    const unflash = this.flash(window);
    window.pushState();
    try {
      if (this.testAnswer) {
        const outcome = await this.testAnswer(prompt);
        return { outcome, waitedMs: Date.now() - started };
      }
      const text = userActionDialog(prompt);
      const res = await this.ctx.dialogs.ask(
        { tone: "info", title: text.title, message: text.message, detail: text.detail, buttons: [tr("Cancel"), tr("Done")], defaultId: 1, cancelId: 0, bar: true, tabId },
        window,
        controller.signal,
      );
      const outcome = closed ? "cancelled" : controller.signal.aborted ? "timeout" : res.button === 1 ? "done" : "cancelled";
      return { outcome, waitedMs: Date.now() - started };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", stop);
      this.waiting.delete(entry);
      unflash();
      this.ctx.windows.findTab(tabId)?.window.pushState();
    }
  }

  /**
   * Flashes a window that is not focused in the taskbar (never raising it) until it gets focus; the
   * returned function stops it once no other request waits in that window.
   */
  private flash(window: BrowserWindowCtl): () => void {
    const win = window.win;
    if (win.isDestroyed() || win.isFocused()) return () => undefined;
    let flashing = true;
    const focused = (): void => {
      flashing = false;
      win.flashFrame(false);
    };
    win.flashFrame(true);
    win.once("focus", focused);
    return () => {
      if (win.isDestroyed()) return;
      win.off("focus", focused);
      if (flashing && ![...this.waiting].some((w) => w.window === window)) win.flashFrame(false);
    };
  }
}
