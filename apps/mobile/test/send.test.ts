import { normalizeSentUrl, parseSentTab, sentTabs, type DeviceInfo } from "@corvus/shared";
import { describe, expect, it } from "vitest";
import { outbox, sendTargets, sharedText } from "../src/lib/send";

const PHONE = "phone-0000000001";
const DESK = "desk-00000000001";
const LAPTOP = "laptop-000000001";

const page = (over: Record<string, unknown> = {}) => ({
  url: "https://news.example/a",
  title: "A",
  to: DESK,
  fromId: PHONE,
  from: "Pixel",
  sentAt: 5,
  ...over,
});

describe("pages sent to a computer", () => {
  it("accepts only web pages between devices of the chain", () => {
    expect(parseSentTab(page())).toEqual(page());
    expect(parseSentTab(page({ url: "javascript:alert(1)" }))).toBeNull();
    expect(parseSentTab(page({ url: "file:///etc/passwd" }))).toBeNull();
    expect(parseSentTab(page({ to: "../../x" }))).toBeNull();
    expect(parseSentTab(page({ sentAt: "now" }))).toBeNull();
    expect(parseSentTab(page({ title: 7 }))?.title).toBe("");
  });

  it("finds the address in what was typed or shared", () => {
    expect(normalizeSentUrl("https://example.com/a?b=1")).toBe("https://example.com/a?b=1");
    expect(normalizeSentUrl("  example.com/article ")).toBe("https://example.com/article");
    expect(normalizeSentUrl("Look at this: https://news.example/story today")).toBe("https://news.example/story");
    expect(normalizeSentUrl("hello there")).toBeNull();
    expect(normalizeSentUrl("javascript:alert(1)")).toBeNull();
    expect(normalizeSentUrl("")).toBeNull();
    expect(sharedText([{ shareType: "text", value: "a text" }, { shareType: "url", value: "https://u.example/" }])).toBe("https://u.example/");
    expect(sharedText([{ shareType: "text", value: "a text" }])).toBe("a text");
    expect(sharedText([])).toBe("");
  });

  it("lists this phone's pages still waiting, oldest first", () => {
    const records = {
      "sent-0000000002": page({ sentAt: 9 }),
      "sent-0000000001": page({ sentAt: 3 }),
      "sent-0000000003": page({ fromId: LAPTOP }),
      "bad id!": page(),
      "sent-0000000004": { url: "https://x.example/" },
    };
    expect(outbox(records, PHONE).map((p) => p.id)).toEqual(["sent-0000000001", "sent-0000000002"]);
    expect(outbox(records, null)).toEqual([]);
    expect(sentTabs(records, (t) => t.fromId === LAPTOP).map((p) => p.id)).toEqual(["sent-0000000003"]);
  });

  it("offers the computers of the chain, the one in use first", () => {
    const device = (id: string, platform: string, lastSeen: number): DeviceInfo => ({ id, name: id, platform, lastSeen });
    const devices = [device(PHONE, "android", 50), device(DESK, "win32", 10), device(LAPTOP, "darwin", 20), device("tablet-000000001", "ios", 30)];
    expect(sendTargets(devices, PHONE, []).map((d) => d.id)).toEqual([LAPTOP, DESK]);
    const tabs = [{ deviceId: DESK, device: "Desk", platform: "win32", updatedAt: 99, tabs: [] }];
    expect(sendTargets(devices, PHONE, tabs).map((d) => d.id)).toEqual([DESK, LAPTOP]);
  });
});
