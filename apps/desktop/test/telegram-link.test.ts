import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  Notification: { isSupported: () => false },
  net: {
    fetch: async () =>
      new Response(JSON.stringify({ ok: true, result: [{ update_id: 7, message: { chat: { id: 42, type: "private" }, text: "https://example.com/page" } }] }), {
        headers: { "content-type": "application/json" },
      }),
  },
}));

import { TelegramLink } from "../src/main/telegram-link";
import type { AppContext } from "../src/main/context";

function link(windows: Record<string, unknown>): TelegramLink {
  const ctx = {
    settings: {
      get: () => ({ phone: { telegramChatId: "42", receiveLinks: true } }),
      getSecret: () => "123:token",
    },
    windows,
  } as unknown as AppContext;
  return new TelegramLink(ctx);
}

describe("TelegramLink links from the phone", () => {
  it("open in the window agents and services may use, never the focused private or locked one", async () => {
    const usable = { createTab: vi.fn() };
    const locked = { createTab: vi.fn() };
    const links = await link({ target: () => usable, focused: () => locked, all: () => [locked, usable] }).poll();
    expect(links).toEqual(["https://example.com/page"]);
    expect(usable.createTab).toHaveBeenCalledWith("https://example.com/page", { activate: false });
    expect(locked.createTab).not.toHaveBeenCalled();
  });

  it("are left in the chat when every profile is locked", async () => {
    const links = await link({
      target: () => {
        throw new Error("locked");
      },
    }).poll();
    expect(links).toEqual(["https://example.com/page"]);
  });
});
