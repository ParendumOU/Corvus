import { describe, expect, it } from "vitest";
import { extractLinks, readUpdates, shareMessage } from "../src/shared/phone-share";

const update = (id: number, chat: Record<string, unknown>, text: string) => ({ update_id: id, message: { chat, text } });
const me = { id: 42, type: "private", first_name: "Ana", username: "ana" };

describe("send to your phone", () => {
  it("finds the http(s) links in a message, without trailing punctuation", () => {
    expect(extractLinks("look https://a.example/x?y=1, and (https://b.example/). Also ftp://c.example and https://a.example/x?y=1")).toEqual([
      "https://a.example/x?y=1",
      "https://b.example/",
    ]);
    expect(extractLinks("no links here")).toEqual([]);
    expect(extractLinks(Array.from({ length: 9 }, (_, i) => `https://s${i}.example/`).join(" "))).toHaveLength(5);
  });

  it("takes links only from the linked private chat, and /start from any private chat", () => {
    const raw = {
      ok: true,
      result: [
        update(10, me, "/start"),
        update(11, me, "read this https://news.example/story"),
        update(12, { id: 99, type: "private", first_name: "Stranger" }, "https://evil.example/"),
        update(13, { id: -5, type: "group", title: "Group" }, "https://group.example/"),
        { update_id: 14, message: { chat: me, caption: "photo https://pics.example/1" } },
      ],
    };
    expect(readUpdates(raw, "42")).toEqual({
      links: ["https://news.example/story", "https://pics.example/1"],
      starts: [{ id: "42", name: "Ana (@ana)" }],
      nextOffset: 15,
    });
    expect(readUpdates(raw, "").links).toEqual([]);
    expect(readUpdates({ ok: true, result: [] }, "42")).toEqual({ links: [], starts: [], nextOffset: null });
    expect(readUpdates(null, "42").nextOffset).toBeNull();
  });

  it("sends a page as its title and address", () => {
    expect(shareMessage("https://a.example/", "  A   page ")).toBe("A page\nhttps://a.example/");
    expect(shareMessage("https://a.example/", "https://a.example/")).toBe("https://a.example/");
    expect(shareMessage("https://a.example/", "")).toBe("https://a.example/");
  });
});
