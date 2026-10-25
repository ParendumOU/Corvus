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
}

const DIALOG_TYPES: readonly DialogType[] = ["alert", "confirm", "prompt"];

/**
 * alert() and confirm() in the tabs agents work in, answerable over MCP (handle_dialog).
 *
 * Electron shows page dialogs itself: its own listener of the internal "-run-dialog" event opens a
 * native message box. watch() wraps that listener instead of replacing it, so the person still gets
 * the same box and can answer it, while Corvus knows a dialog is open (page scripts wait behind it).
 * answer() replies to the page and then emits "-cancel-dialogs", which closes Electron's box without
 * a second reply. prompt() keeps Electron's behaviour (it returns null at once), so it never stays
 * open. When the Electron internals are not there, tabs keep the stock dialogs and handle_dialog
 * finds nothing open.
 */
export class PageDialogs {
  private readonly watched = new WeakSet<WebContents>();
  private readonly open = new WeakMap<WebContents, OpenDialog>();
  private readonly waiters = new WeakMap<WebContents, Set<(dialog: DialogInfo) => void>>();

  watch(wc: WebContents): void {
    if (this.watched.has(wc) || wc.isDestroyed()) return;
    const emitter = wc as unknown as NodeJS.EventEmitter;
    const electron = emitter.listeners("-run-dialog") as RunDialogListener[];
    if (electron.length === 0) return;
    this.watched.add(wc);
    emitter.removeAllListeners("-run-dialog");
    emitter.on("-run-dialog", (info: RunDialogInfo, reply: DialogReply) => {
      let answered = false;
      const once: DialogReply = (accept, promptText) => {
        if (answered) return;
        answered = true;
        if (this.open.get(wc)?.reply === once) this.open.delete(wc);
        reply(accept, promptText);
      };
      for (const listener of electron) {
        void Promise.resolve(listener.call(wc, info, once)).catch(() => undefined);
      }
      // Electron answered at once (prompt, disabled dialogs): nothing stays open.
      if (answered) return;
      const type = DIALOG_TYPES.find((t) => t === info.dialogType) ?? "alert";
      const dialog: DialogInfo = {
        type,
        message: String(info.messageText ?? ""),
        ...(type === "prompt" ? { defaultPrompt: String(info.defaultPromptText ?? "") } : {}),
        url: info.frame?.url || wc.getURL(),
        at: Date.now(),
      };
      this.open.set(wc, { info: dialog, reply: once });
      for (const waiter of [...(this.waiters.get(wc) ?? [])]) waiter(dialog);
    });
    // Chromium cancels dialogs on navigation and when the tab closes; Electron closes its box then.
    emitter.on("-cancel-dialogs", () => this.open.delete(wc));
  }

  pending(wc: WebContents): DialogInfo | null {
    return this.open.get(wc)?.info ?? null;
  }

  /** Replies to the open dialog and closes the native box; null when none is open. */
  answer(wc: WebContents, accept: boolean, promptText = ""): DialogInfo | null {
    const open = this.open.get(wc);
    if (!open) return null;
    open.reply(accept, promptText);
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
