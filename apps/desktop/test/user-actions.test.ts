import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppContext } from "../src/main/context";
import { DialogService } from "../src/main/dialogs";
import { UserActionService } from "../src/main/user-actions";
import type { BrowserWindowCtl } from "../src/main/window";

type FakeWindow = BrowserWindowCtl & { pushes: number; focused: boolean; flashes: boolean[]; win: EventEmitter };

function fakeWindow(focused = true): FakeWindow {
  const win = Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    isMinimized: () => false,
    isFocused: () => w.focused,
    restore: vi.fn(),
    focus: vi.fn(),
    flashFrame: (flag: boolean) => w.flashes.push(flag),
  });
  const w = {
    pushes: 0,
    focused,
    flashes: [] as boolean[],
    win,
    focusChrome: vi.fn(),
    pushState() {
      w.pushes++;
    },
  };
  return w as unknown as FakeWindow;
}

/** A service over windows holding the given tabs; `focused` is the window dialogs default to. */
function setup(tabs: Record<string, FakeWindow>, focused: FakeWindow) {
  const ctx = {
    windows: {
      findTab: (id: string) => (tabs[id] ? { window: tabs[id], tab: { id } } : undefined),
      focused: () => focused,
      regular: () => [focused],
    },
  } as unknown as AppContext;
  ctx.dialogs = new DialogService(ctx);
  return { ctx, service: new UserActionService(ctx) };
}

const prompt = { client: "claude-code", message: "Sign in", host: "central.example.com" };

afterEach(() => {
  vi.useRealTimers();
});

describe("request_user_action", () => {
  it("asks in the tab's window, not the focused one, and marks only that tab until the person answers", async () => {
    const home = fakeWindow();
    const other = fakeWindow();
    const { ctx, service } = setup({ t1: home, t2: home }, other);
    const asked = service.ask("t1", prompt, 60_000);
    expect(service.needsYou("t1")).toBe(true);
    expect(service.needsYou("t2")).toBe(false);
    expect(ctx.dialogs.bars(other)).toEqual([]);
    const [bar] = ctx.dialogs.bars(home);
    expect(bar).toMatchObject({ bar: true, tabId: "t1", buttons: ["Cancel", "Done"] });
    expect(bar!.message).toContain("claude-code");
    // Nothing raises or focuses the window, and a focused one does not flash.
    expect(home.win.focus).not.toHaveBeenCalled();
    expect(home.flashes).toEqual([]);
    const pushes = home.pushes;
    ctx.dialogs.answer(home, bar!.id, { button: 1 });
    expect((await asked).outcome).toBe("done");
    expect(service.needsYou("t1")).toBe(false);
    expect(ctx.dialogs.bars(home)).toEqual([]);
    expect(home.pushes).toBeGreaterThan(pushes);
  });

  it("ends as cancelled when the tab closes, and as timeout when time runs out or the client goes away", async () => {
    vi.useFakeTimers();
    const home = fakeWindow();
    const { ctx, service } = setup({ t1: home }, home);
    const closing = service.ask("t1", prompt, 60_000);
    service.forgetTab("t1");
    expect(await closing).toMatchObject({ outcome: "cancelled" });
    expect(service.needsYou("t1")).toBe(false);
    expect(ctx.dialogs.bars(home)).toEqual([]);

    const late = service.ask("t1", prompt, 5_000);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await late).toMatchObject({ outcome: "timeout" });
    expect(service.needsYou("t1")).toBe(false);

    const client = new AbortController();
    const gone = service.ask("t1", prompt, 60_000, client.signal);
    expect(service.needsYou("t1")).toBe(true);
    client.abort();
    expect(await gone).toMatchObject({ outcome: "timeout" });
    expect(service.needsYou("t1")).toBe(false);
    expect(ctx.dialogs.bars(home)).toEqual([]);
  });

  it("keeps a mark per request: two tabs asking at once each keep theirs until answered", async () => {
    const home = fakeWindow();
    const { ctx, service } = setup({ t1: home, t2: home }, home);
    const first = service.ask("t1", prompt, 60_000);
    const second = service.ask("t2", prompt, 60_000);
    expect(service.needsYou("t1") && service.needsYou("t2")).toBe(true);
    const bar = ctx.dialogs.bars(home).find((b) => b.tabId === "t2")!;
    ctx.dialogs.answer(home, bar.id, { button: 0 });
    expect((await second).outcome).toBe("cancelled");
    expect(service.needsYou("t1")).toBe(true);
    expect(service.needsYou("t2")).toBe(false);
    service.forgetTab("t1");
    expect((await first).outcome).toBe("cancelled");
  });

  it("flashes a window that is not focused until it gets focus or its last request ends", async () => {
    const home = fakeWindow(false);
    const { ctx, service } = setup({ t1: home, t2: home }, home);
    const first = service.ask("t1", prompt, 60_000);
    const second = service.ask("t2", prompt, 60_000);
    expect(home.flashes).toEqual([true, true]);
    service.forgetTab("t1");
    await first;
    // Another request still waits in the window: it keeps flashing.
    expect(home.flashes).toEqual([true, true]);
    service.forgetTab("t2");
    await second;
    expect(home.flashes).toEqual([true, true, false]);

    home.flashes.length = 0;
    const third = service.ask("t1", prompt, 60_000);
    home.win.emit("focus");
    expect(home.flashes).toEqual([true, false]);
    ctx.dialogs.answer(home, ctx.dialogs.bars(home)[0]!.id, { button: 1 });
    expect((await third).outcome).toBe("done");
    expect(home.flashes).toEqual([true, false]);
    expect(home.win.listenerCount("focus")).toBe(0);
  });

  it("answers cancelled at once for a tab that is gone", async () => {
    const home = fakeWindow();
    const { service } = setup({}, home);
    expect(await service.ask("t9", prompt, 60_000)).toEqual({ outcome: "cancelled", waitedMs: 0 });
    expect(service.needsYou("t9")).toBe(false);
  });
});
