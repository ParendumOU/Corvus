import crypto from "node:crypto";
import { dialog } from "electron";
import { cancelAnswer, toneOf, type DialogAnswer, type DialogSpec, type DialogView } from "../shared/dialog";
import type { DialogInfo } from "@corvus/shared";
import type { WebContents } from "electron";
import type { AppContext } from "./context";
import { tr } from "./menu-i18n";
import type { PageDialogAnswer, PageDialogPresenter } from "./page-dialogs";
import type { BrowserWindowCtl } from "./window";

interface Pending {
  view: DialogView;
  resolve: (answer: DialogAnswer) => void;
}

/**
 * Corvus's modal dialogs (shared/dialog.ts). Each window shows its questions one at a time over its
 * UI (WindowState.dialog); the chrome UI answers with "dialog.answer". With no window to show it in,
 * the system's message box stands in.
 */
export class DialogService {
  private readonly queues = new Map<BrowserWindowCtl, Pending[]>();

  constructor(private readonly ctx: AppContext) {}

  /** The modal question a window shows now, if any (one at a time, in order). */
  current(win: BrowserWindowCtl): DialogView | null {
    return this.queues.get(win)?.find((p) => !p.view.bar)?.view ?? null;
  }

  /** The questions shown as bars under the toolbar (they do not wait for each other). */
  bars(win: BrowserWindowCtl): DialogView[] {
    return (this.queues.get(win) ?? []).filter((p) => p.view.bar).map((p) => p.view);
  }

  /** Converts an Electron message box (options as for dialog.showMessageBox) and asks it. */
  messageBox(options: Electron.MessageBoxOptions, win?: BrowserWindowCtl): Promise<{ response: number; checkboxChecked: boolean }> {
    const buttons = options.buttons?.length ? options.buttons : ["OK"];
    const spec: DialogSpec = {
      tone: toneOf(options.type),
      title: options.title || "Corvus",
      message: options.message,
      ...(options.detail ? { detail: options.detail } : {}),
      buttons,
      defaultId: options.defaultId ?? 0,
      cancelId: options.cancelId ?? buttons.length - 1,
      ...(options.checkboxLabel ? { checkbox: { label: options.checkboxLabel, checked: options.checkboxChecked === true } } : {}),
      ...(options.icon && typeof options.icon !== "string" && !options.icon.isEmpty() ? { icon: options.icon.resize({ width: 48, height: 48 }).toDataURL() } : {}),
    };
    return this.ask(spec, win).then((a) => ({ response: a.button, checkboxChecked: a.checked }));
  }

  /**
   * Asks in `win` (the focused window by default). `signal` withdraws the question (the page that
   * asked went away): it then resolves as cancelled.
   */
  ask(spec: DialogSpec, win?: BrowserWindowCtl, signal?: AbortSignal): Promise<DialogAnswer> {
    const target = win ?? this.ctx.windows.focused() ?? this.ctx.windows.regular()[0];
    if (!target || target.win.isDestroyed()) return this.native(spec);
    if (signal?.aborted) return Promise.resolve(cancelAnswer(spec));
    return new Promise<DialogAnswer>((resolve) => {
      const view: DialogView = { ...spec, id: crypto.randomUUID() };
      const queue = this.queues.get(target) ?? [];
      this.queues.set(target, queue);
      queue.push({ view, resolve });
      signal?.addEventListener("abort", () => this.settle(target, view.id, cancelAnswer(spec)), { once: true });
      if (view.bar || this.current(target)?.id === view.id) this.show(target);
    });
  }

  /** The person answered in the window (or closed it: Escape picks the cancel button). */
  answer(win: BrowserWindowCtl, id: string, answer: Partial<DialogAnswer>): void {
    const pending = this.queues.get(win)?.find((p) => p.view.id === id);
    if (!pending) return;
    const button = typeof answer.button === "number" && answer.button >= 0 && answer.button < pending.view.buttons.length ? answer.button : pending.view.cancelId;
    this.settle(win, id, { button, checked: answer.checked === true, value: typeof answer.value === "string" ? answer.value.slice(0, 10_000) : "" });
  }

  /** The window closes: whatever it was asking is cancelled. */
  forget(win: BrowserWindowCtl): void {
    const queue = this.queues.get(win) ?? [];
    this.queues.delete(win);
    for (const p of queue) p.resolve(cancelAnswer(p.view));
  }

  private settle(win: BrowserWindowCtl, id: string, answer: DialogAnswer): void {
    const queue = this.queues.get(win);
    const index = queue?.findIndex((p) => p.view.id === id) ?? -1;
    if (!queue || index < 0) return;
    const [pending] = queue.splice(index, 1);
    if (queue.length === 0) this.queues.delete(win);
    pending!.resolve(answer);
    this.show(win);
  }

  private show(win: BrowserWindowCtl): void {
    if (win.win.isDestroyed()) return;
    const current = this.current(win);
    if (current && !current.bar) {
      if (win.win.isMinimized()) win.win.restore();
      win.win.focus();
      win.focusChrome();
    }
    win.pushState();
  }

  private async native(spec: DialogSpec): Promise<DialogAnswer> {
    const { response, checkboxChecked } = await dialog.showMessageBox({
      type: spec.tone === "danger" ? "warning" : spec.tone === "question" ? "question" : spec.tone === "warning" ? "warning" : "info",
      title: spec.title,
      message: spec.message,
      ...(spec.detail ? { detail: spec.detail } : {}),
      buttons: spec.buttons,
      defaultId: spec.defaultId,
      cancelId: spec.cancelId,
      ...(spec.checkbox ? { checkboxLabel: spec.checkbox.label, checkboxChecked: spec.checkbox.checked } : {}),
      noLink: true,
    });
    return { button: response, checked: checkboxChecked, value: spec.input?.value ?? "" };
  }
}

/** The site a page dialog comes from, as people read it ("shop.example"). */
function pageHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

/**
 * Shows pages' alert(), confirm() and prompt() as Corvus's dialog in the tab's window, bringing the
 * tab to the front. Corvus's own pages ask as "Corvus"; a web page is named, and can be silenced.
 */
export function pageDialogPresenter(ctx: AppContext): PageDialogPresenter {
  return (wc: WebContents, page: DialogInfo, signal: AbortSignal): Promise<PageDialogAnswer> | null => {
    const found = ctx.windows.byTabWebContents(wc);
    if (!found || found.window.win.isDestroyed()) return null;
    if (found.window.activeTab()?.id !== found.tab.id) found.window.activate(found.tab.id);
    const internal = page.url.startsWith("corvus:");
    const host = pageHost(page.url);
    const asks = page.type !== "alert";
    return ctx.dialogs
      .ask(
        {
          tone: asks ? "question" : "info",
          title: internal || !host ? "Corvus" : tr("{host} says", { host }),
          message: page.message,
          buttons: asks ? [tr("Cancel"), tr("OK")] : [tr("OK")],
          defaultId: asks ? 1 : 0,
          cancelId: 0,
          ...(page.type === "prompt" ? { input: { value: page.defaultPrompt ?? "" } } : {}),
          ...(internal ? {} : { checkbox: { label: tr("Don't let this page open more dialogs"), checked: false }, origin: host }),
        },
        found.window,
        signal,
      )
      .then((a) => ({ accept: asks ? a.button === 1 : true, text: a.value, suppress: a.checked }));
  };
}
