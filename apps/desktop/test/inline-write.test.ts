import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { captureFieldScript, cleanWriteOutput, insertFieldScript, writeActionLabel, type CapturedField } from "../src/shared/inline-write";

/** A text field of a page, with the selection and editing calls the scripts use. */
function field(tag: "TEXTAREA" | "INPUT", value: string, attrs: Record<string, string> = {}) {
  const el = {
    tagName: tag,
    isContentEditable: false,
    isConnected: true,
    value,
    selectionStart: value.length,
    selectionEnd: value.length,
    inputs: 0,
    getAttribute: (name: string) => attrs[name] ?? null,
    focus() {},
    setSelectionRange(start: number, end: number) {
      el.selectionStart = start;
      el.selectionEnd = end;
    },
    select() {
      el.selectionStart = 0;
      el.selectionEnd = el.value.length;
    },
    setRangeText(text: string, start: number, end: number) {
      el.value = el.value.slice(0, start) + text + el.value.slice(end);
    },
    dispatchEvent() {
      el.inputs += 1;
      return true;
    },
  };
  return el;
}

/** A page whose focused element is `el`; execCommand("insertText") is unsupported, as in a fallback. */
function page(el: ReturnType<typeof field>) {
  const ctx: Record<string, unknown> = {
    document: { activeElement: el, execCommand: () => false },
    InputEvent: class {
      constructor(
        readonly type: string,
        readonly init: unknown,
      ) {}
    },
    Map,
  };
  ctx.window = ctx;
  return (code: string): unknown => runInNewContext(code, ctx);
}

describe("write with Corvus AI: the field", () => {
  it("captures the whole field, then replaces it on insert as an edit", () => {
    const el = field("TEXTAREA", "Helo team");
    const run = page(el);
    const captured = run(captureFieldScript("t1")) as CapturedField;
    expect(captured).toEqual({ token: "t1", text: "Helo team", selected: false });
    expect(run(insertFieldScript("t1", "Hello team"))).toBe(true);
    expect(el.value).toBe("Hello team");
    expect(el.inputs).toBe(1);
    // A token is used once.
    expect(run(insertFieldScript("t1", "again"))).toBe(false);
  });

  it("captures and replaces only the selection when there is one", () => {
    const el = field("INPUT", "Dear Sir, thx for it");
    el.setSelectionRange(10, 13);
    const run = page(el);
    expect((run(captureFieldScript("t2")) as CapturedField).text).toBe("thx");
    el.setSelectionRange(0, 0);
    run(insertFieldScript("t2", "thanks"));
    expect(el.value).toBe("Dear Sir, thanks for it");
  });

  it("never reads password, one-time-code or card fields, nor non-text inputs", () => {
    expect(page(field("INPUT", "hunter2", { type: "password" }))(captureFieldScript("x"))).toBeNull();
    expect(page(field("INPUT", "123456", { autocomplete: "one-time-code" }))(captureFieldScript("x"))).toBeNull();
    expect(page(field("INPUT", "4111", { autocomplete: "cc-number" }))(captureFieldScript("x"))).toBeNull();
    expect(page(field("INPUT", "5", { type: "number" }))(captureFieldScript("x"))).toBeNull();
  });

  it("does nothing once the field has left the page", () => {
    const el = field("TEXTAREA", "draft");
    const run = page(el);
    run(captureFieldScript("t3"));
    el.isConnected = false;
    expect(run(insertFieldScript("t3", "new"))).toBe(false);
    expect(el.value).toBe("draft");
  });
});

describe("write with Corvus AI: the text", () => {
  it("drops a fence or quotes wrapped around the whole reply, unless the field was quoted", () => {
    expect(cleanWriteOutput("```\nHello there\n```", "hi")).toBe("Hello there");
    expect(cleanWriteOutput('"Hello there"', "helo there")).toBe("Hello there");
    expect(cleanWriteOutput("“Hola”", "hola")).toBe("Hola");
    expect(cleanWriteOutput('"Quoted on purpose"', '"quoted on purpose"')).toBe('"Quoted on purpose"');
    expect(cleanWriteOutput('He said "hi" to me', "he sayd hi")).toBe('He said "hi" to me');
  });

  it("labels the actions, translation with the target language", () => {
    expect(writeActionLabel("fix", "Spanish")).toBe("Fix spelling and grammar");
    expect(writeActionLabel("translate", "Spanish")).toBe("Translate into Spanish");
    expect(writeActionLabel("custom", "Spanish")).toBe("Write…");
  });
});
