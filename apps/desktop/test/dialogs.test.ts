import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { DialogInfo } from "@corvus/shared";
import { DialogService } from "../src/main/dialogs";
import { PageDialogs, type PageDialogAnswer } from "../src/main/page-dialogs";
import type { AppContext } from "../src/main/context";
import type { BrowserWindowCtl } from "../src/main/window";
import type { DialogSpec } from "../src/shared/dialog";

function fakeWindow(): BrowserWindowCtl & { pushes: number } {
  const w = {
    pushes: 0,
    win: { isDestroyed: () => false, isMinimized: () => false, restore: vi.fn(), focus: vi.fn() },
    focusChrome: vi.fn(),
    pushState() {
      w.pushes++;
    },
  };
  return w as unknown as BrowserWindowCtl & { pushes: number };
}

const spec = (title: string, extra: Partial<DialogSpec> = {}): DialogSpec => ({ tone: "question", title, message: title, buttons: ["Cancel", "OK"], defaultId: 1, cancelId: 0, ...extra });

describe("Corvus's dialogs", () => {
  it("shows a window's questions one at a time and answers each", async () => {
    const win = fakeWindow();
    const service = new DialogService({ windows: { focused: () => win, regular: () => [win] } } as unknown as AppContext);
    const first = service.ask(spec("first"));
    const second = service.ask(spec("second"));
    expect(service.current(win)?.title).toBe("first");
    service.answer(win, service.current(win)!.id, { button: 1, checked: false });
    expect(await first).toEqual({ button: 1, checked: false, value: "" });
    expect(service.current(win)?.title).toBe("second");
    // An out-of-range button is the cancel one.
    service.answer(win, service.current(win)!.id, { button: 7 });
    expect((await second).button).toBe(0);
    expect(service.current(win)).toBeNull();
    expect(win.pushes).toBeGreaterThanOrEqual(3);
  });

  it("keeps bars apart from modals, withdraws on abort and cancels all when the window closes", async () => {
    const win = fakeWindow();
    const service = new DialogService({ windows: { focused: () => win, regular: () => [win] } } as unknown as AppContext);
    const controller = new AbortController();
    const bar = service.ask(spec("agent needs you", { bar: true }), undefined, controller.signal);
    const modal = service.ask(spec("pay?"));
    // A bar does not hold a modal question back.
    expect(service.current(win)?.title).toBe("pay?");
    expect(service.bars(win).map((b) => b.title)).toEqual(["agent needs you"]);
    controller.abort();
    expect(await bar).toEqual({ button: 0, checked: false, value: "" });
    expect(service.bars(win)).toEqual([]);
    service.forget(win);
    expect((await modal).button).toBe(0);
  });

  it("answers what a dialog's fields hold, and their first values when cancelled", async () => {
    const win = fakeWindow();
    const service = new DialogService({ windows: { focused: () => win, regular: () => [win] } } as unknown as AppContext);
    const fields = [
      { label: "Name", value: "Old" },
      { label: "URL", value: "https://old.test/", required: "Enter a URL" },
    ];
    const edited = service.ask(spec("Edit bookmark", { fields }));
    // A value too many is dropped, a missing one keeps the field's own.
    service.answer(win, service.current(win)!.id, { button: 1, values: ["New", 7 as unknown as string, "extra"] });
    expect(await edited).toEqual({ button: 1, checked: false, value: "", values: ["New", "https://old.test/"] });
    const cancelled = service.ask(spec("Edit bookmark", { fields }));
    service.forget(win);
    expect((await cancelled).values).toEqual(["Old", "https://old.test/"]);
  });
});

/** A tab's webContents as PageDialogs sees it: Electron's internal events and its own listener. */
function fakeTab(electronListener = vi.fn()) {
  const wc = new EventEmitter() as EventEmitter & { isDestroyed: () => boolean; getURL: () => string; emitDialog: (type: string, message: string) => Promise<[boolean, string]> };
  wc.isDestroyed = () => false;
  wc.getURL = () => "https://shop.test/";
  wc.on("-run-dialog", electronListener);
  wc.emitDialog = (type, message) =>
    new Promise((resolve) => wc.emit("-run-dialog", { dialogType: type, messageText: message, defaultPromptText: "x", frame: { url: "https://shop.test/" } }, (accept: boolean, text: string) => resolve([accept, text])));
  return wc;
}

describe("pages' dialogs", () => {
  it("show as Corvus's dialog and answer the page; a silenced page gets no more", async () => {
    let answer: (a: PageDialogAnswer) => void = () => undefined;
    const shown: DialogInfo[] = [];
    const present = vi.fn((_wc, dialog: DialogInfo) => {
      shown.push(dialog);
      return new Promise<PageDialogAnswer>((resolve) => (answer = resolve));
    });
    const dialogs = new PageDialogs(present);
    const electron = vi.fn();
    const wc = fakeTab(electron);
    dialogs.watch(wc as never);
    const reply = wc.emitDialog("prompt", "Your name?");
    expect(shown[0]).toMatchObject({ type: "prompt", message: "Your name?", defaultPrompt: "x" });
    expect(dialogs.pending(wc as never)?.type).toBe("prompt");
    answer({ accept: true, text: "Ada", suppress: true });
    expect(await reply).toEqual([true, "Ada"]);
    expect(electron).not.toHaveBeenCalled();
    expect(dialogs.pending(wc as never)).toBeNull();
    // Silenced until it navigates.
    expect(await wc.emitDialog("alert", "again")).toEqual([false, ""]);
    expect(present).toHaveBeenCalledTimes(1);
  });

  it("closes Corvus's dialog when an agent answers over MCP, and falls back to Electron's box with no window", async () => {
    let signal: AbortSignal | undefined;
    const dialogs = new PageDialogs((_wc, _d, s) => {
      signal = s;
      return new Promise<PageDialogAnswer>(() => undefined);
    });
    const wc = fakeTab();
    dialogs.watch(wc as never);
    const reply = wc.emitDialog("confirm", "Delete?");
    expect(dialogs.answer(wc as never, true)?.message).toBe("Delete?");
    expect(await reply).toEqual([true, ""]);
    expect(signal?.aborted).toBe(true);

    // The tab closes with its dialog open: Corvus's dialog is withdrawn with it.
    const closing = fakeTab();
    dialogs.watch(closing as never);
    void closing.emitDialog("alert", "Bye");
    expect(dialogs.pending(closing as never)?.message).toBe("Bye");
    closing.emit("destroyed");
    expect(dialogs.pending(closing as never)).toBeNull();
    expect(signal?.aborted).toBe(true);

    const electron = vi.fn((_info: unknown, done: (accept: boolean, text: string) => void) => done(false, ""));
    const noWindow = new PageDialogs(() => null);
    const other = fakeTab(electron);
    noWindow.watch(other as never);
    expect(await other.emitDialog("alert", "hi")).toEqual([false, ""]);
    expect(electron).toHaveBeenCalledTimes(1);
  });
});
