import { describe, expect, it } from "vitest";
import { attentionNotice } from "../src/shared/attention";
import type { DialogSpec } from "../src/shared/dialog";

const spec = (extra: Partial<DialogSpec> = {}): DialogSpec => ({
  tone: "warning",
  title: "AI agent wants to spend money",
  message: 'An AI client wants to spend money: Click "Place order" on shop.example.',
  detail: "Allow once lets only this action through.",
  buttons: ["Deny", "Allow once"],
  defaultId: 0,
  cancelId: 0,
  ...extra,
});

describe("notifications for questions an agent waits on", () => {
  it("are only for questions that ask for one (never what a page asks)", () => {
    expect(attentionNotice(spec())).toBeNull();
  });

  it("say what is asked and offer its buttons, in order", () => {
    expect(attentionNotice(spec({ notify: "buttons" }))).toEqual({
      title: "AI agent wants to spend money",
      body: 'An AI client wants to spend money: Click "Place order" on shop.example.',
      buttons: ["Deny", "Allow once"],
    });
  });

  it("only open Corvus when the question is answered there", () => {
    expect(attentionNotice(spec({ notify: "open" }))?.buttons).toEqual([]);
    expect(attentionNotice(spec({ notify: "buttons", fields: [{ label: "Name", value: "" }] }))?.buttons).toEqual([]);
    expect(attentionNotice(spec({ notify: "buttons", input: { value: "" } }))?.buttons).toEqual([]);
    expect(attentionNotice(spec({ notify: "buttons", blocks: [{ kind: "text", text: "Read this first" }] }))?.buttons).toEqual([]);
    expect(attentionNotice(spec({ notify: "buttons", choices: [{ label: "ana@example.com" }] }))?.buttons).toEqual([]);
    expect(attentionNotice(spec({ notify: "buttons", buttons: ["A", "B", "C", "D"] }))?.buttons).toEqual([]);
  });

  it("keep their text short", () => {
    const notice = attentionNotice(spec({ notify: "buttons", title: "t".repeat(300), message: "m".repeat(500) }))!;
    expect(notice.title.length).toBe(120);
    expect(notice.body.length).toBe(200);
  });
});
