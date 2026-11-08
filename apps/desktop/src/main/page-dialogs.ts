import type { DialogInfo, DialogType } from "@corvus/shared";
import type { WebContents } from "electron";

/** Electron's payload for its internal "-run-dialog" event (lib/browser/api/web-contents.ts). */
interface RunDialogInfo {
  frame?: { url?: string } | null;
  dialogType?: string;
  messageText?: string;
  defaultPromptText?: string;
}
type DialogReply = (accept: boolean, promptText: string) => void;
type RunDialogListener = (this: WebContents, info: RunDialogInfo, reply: DialogReply) => unknown;

interface OpenDialog {
  info: DialogInfo;
  reply: DialogReply;
  /** Withdraws Corvus's dialog (answered over MCP, or the page went away). */
  withdraw: () => void;
}

/** What the person answered in Corvus's dialog; `suppress`: no more dialogs from this page. */
export interface PageDialogAnswer {
  accept: boolean;
  text: string;
  suppress: boolean;
}

/**
 * Shows a page's dialog with Corvus's look (main/dialogs.ts), or returns null when the tab has no
 * window to show it in (Electron's own box stands in then).
 */
export type PageDialogPresenter = (wc: WebContents, dialog: DialogInfo, signal: AbortSignal) => Promise<PageDialogAnswer> | null;

const DIALOG_TYPES: readonly DialogType[] = ["alert", "confirm", "prompt"];

/**
 * Pages' alert(), confirm() and prompt(), in every tab: shown as Corvus's own dialog (the presenter)
 * and answerable over MCP (handle_dialog) while they are open (page scripts wait behind them).
 *
 * Electron shows page dialogs through its own listener of the internal "-run-dialog" event (a system
 * message box). watch() takes that event over; Electron's listener only runs when the presenter has
 * no window to show the dialog in. answer() replies to the page and withdraws the dialog. A page the
 * person silenced ("Don't let this page open more dialogs") gets its dialogs dismissed at once until
 * it navigates. When the Electron internals are not there, tabs keep the stock dialogs and
 * handle_dialog finds nothing open.
 */
export class PageDialogs {
  private readonly watched = new WeakSet<WebContents>();
  private readonly open = new WeakMap<WebContents, OpenDialog>();
  private readonly waiters = new WeakMap<WebContents, Set<(dialog: DialogInfo) => void>>();
  private readonly silenced = new WeakSet<WebContents>();

  constructor(private readonly present: PageDialogPresenter | null = null) {}

  watch(wc: WebContents): void {
    if (this.watched.has(wc) || wc.isDestroyed()) return;
    const emitter = wc as unknown as NodeJS.EventEmitter;
    const electron = emitter.listeners("-run-dialog") as RunDialogListener[];
    if (electron.length === 0) return;
    this.watched.add(wc);
    emitter.removeAllListeners("-run-dialog");
    emitter.on("-run-dialog", (info: RunDialogInfo, reply: DialogReply) => {
      const type = DIALOG_TYPES.find((t) => t === info.dialogType) ?? "alert";
      const dialog: DialogInfo = {
        type,
        message: String(info.messageText ?? ""),
        ...(type === "prompt" ? { defaultPrompt: String(info.defaultPromptText ?? "") } : {}),
        url: info.frame?.url || wc.getURL(),
        at: Date.now(),
      };
      this.run(wc, dialog, reply, (once) => {
        for (const listener of electron) {
          void Promise.resolve(listener.call(wc, info, once)).catch(() => undefined);
        }
      });
    });
    // Chromium cancels dialogs on navigation: withdraw Corvus's dialog too. A closed tab gets no
    // "-cancel-dialogs", so its dialog goes when its page does.
    const cancel = (): void => {
      this.open.get(wc)?.withdraw();
      this.open.delete(wc);
    };
    emitter.on("-cancel-dialogs", cancel);
    wc.once("destroyed", cancel);
    // A new page may ask again.
    wc.on("did-navigate", () => this.silenced.delete(wc));
  }

  /**
   * A page's prompt(). Electron's renderer replaces window.prompt with one that throws, so the tab
   * preload puts its own in the page and asks here over synchronous IPC: shown and answered like
   * alert() and confirm(). `reply` gets the text, or null when dismissed; with no window to show it
   * in, or a page Corvus does not watch, it is dismissed at once (there is no stock box for it).
   */
  prompt(wc: WebContents, ask: { message: string; defaultPrompt: string; url: string }, reply: (text: string | null) => void): void {
    if (!this.watched.has(wc) || wc.isDestroyed()) {
      reply(null);
      return;
    }
    const dialog: DialogInfo = { type: "prompt", message: ask.message, defaultPrompt: ask.defaultPrompt, url: ask.url || wc.getURL(), at: Date.now() };
    this.run(wc, dialog, (accept, text) => reply(accept ? text : null), (once) => once(false, ""), true);
  }

  /**
   * Shows the dialog (the presenter, else `fallback`, which may answer at once) and keeps it open for
   * handle_dialog until answered. `replyOnWithdraw`: the page waits on Corvus itself (prompt over
   * sync IPC), so a withdrawn dialog still answers it, dismissed.
   */
  private run(wc: WebContents, dialog: DialogInfo, reply: DialogReply, fallback: (once: DialogReply) => void, replyOnWithdraw = false): void {
    let answered = false;
    const controller = new AbortController();
    const once: DialogReply = (accept, promptText) => {
      if (answered) return;
      answered = true;
      if (this.open.get(wc)?.reply === once) this.open.delete(wc);
      controller.abort();
      reply(accept, promptText);
    };
    if (this.silenced.has(wc)) {
      once(false, "");
      return;
    }
    const shown = this.present?.(wc, dialog, controller.signal) ?? null;
    if (shown) {
      void shown.then(
        (answer) => {
          if (answer.suppress) this.silenced.add(wc);
          once(answer.accept, answer.text.slice(0, 10_000));
        },
        () => once(false, ""),
      );
    } else {
      fallback(once);
      // Answered at once (disabled dialogs, a prompt with no window): nothing stays open.
      if (answered) return;
    }
    this.open.set(wc, {
      info: dialog,
      reply: once,
      // The page is gone or the dialog was cancelled: no reply after that (Chromium has closed it).
      withdraw: () => {
        if (replyOnWithdraw) return once(false, "");
        answered = true;
        controller.abort();
      },
    });
    for (const waiter of [...(this.waiters.get(wc) ?? [])]) waiter(dialog);
  }

  pending(wc: WebContents): DialogInfo | null {
    return this.open.get(wc)?.info ?? null;
  }

  /**
   * Replies to the open dialog and closes it (Corvus's dialog or Electron's box); null when none is
   * open. A prompt accepted without text answers its default text, as OK in the dialog does.
   */
  answer(wc: WebContents, accept: boolean, promptText?: string): DialogInfo | null {
    const open = this.open.get(wc);
    if (!open) return null;
    open.reply(accept, promptText ?? open.info.defaultPrompt ?? "");
    (wc as unknown as NodeJS.EventEmitter).emit("-cancel-dialogs");
    return open.info;
  }

  /**
   * Settles with the page script, or rejects with blocked(dialog) as soon as the page opens a dialog
   * (the script then waits behind it until someone answers).
   */
  race<T>(wc: WebContents, run: Promise<T>, blocked: (dialog: DialogInfo) => Error): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let set = this.waiters.get(wc);
      if (!set) this.waiters.set(wc, (set = new Set()));
      const waiters = set;
      const onOpen = (dialog: DialogInfo): void => {
        waiters.delete(onOpen);
        reject(blocked(dialog));
      };
      waiters.add(onOpen);
      run.then(
        (value) => {
          waiters.delete(onOpen);
          resolve(value);
        },
        (err: unknown) => {
          waiters.delete(onOpen);
          reject(err);
        },
      );
    });
  }
}
