import { Notification } from "electron";
import type { TabId } from "@corvus/shared";
import type { AttentionNotice } from "../shared/attention";
import type { BrowserWindowCtl } from "./window";

/**
 * System notifications for questions an AI agent waits on while the person is not in Corvus (see
 * DialogSpec.notify): a click brings the window and the tab to the front; a button answers the
 * question there and then. Each one goes away once its question is answered, in Corvus or in it.
 */
export class AttentionNotifier {
  /** Kept until withdrawn: a notification that is collected loses its click and buttons. */
  private readonly shown = new Map<string, Notification>();

  show(id: string, win: BrowserWindowCtl, notice: AttentionNotice, tabId: TabId | undefined, answer: (button: number) => void): void {
    if (this.shown.has(id) || !Notification.isSupported()) return;
    const n = new Notification({
      title: notice.title,
      body: notice.body,
      actions: notice.buttons.map((text) => ({ type: "button" as const, text })),
    });
    n.on("click", () => {
      win.present();
      if (tabId && win.hasTab(tabId)) win.activate(tabId);
    });
    n.on("action", (details) => answer(details.actionIndex));
    this.shown.set(id, n);
    n.show();
  }

  withdraw(id: string): void {
    this.shown.get(id)?.close();
    this.shown.delete(id);
  }
}
