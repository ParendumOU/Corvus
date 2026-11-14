import { describe, expect, it } from "vitest";
import { fillIdentifierScript, fillLoginByRefScript, fillLoginScript, fillOtpScript } from "../src/shared/credential-scripts";
import { typeIntoField, type TypedField } from "../src/shared/typed-fill";

/** A field whose editing writes `typed(value)` (what the page makes of the typing), or refuses when that is null. */
const field = (opts: { type?: string; focused?: boolean; typed?: (value: string) => string | null; value?: string } = {}) => {
  const calls: string[] = [];
  const el: TypedField & { calls: string[] } = {
    value: opts.value ?? "",
    type: opts.type ?? "text",
    calls,
    select: () => calls.push("select"),
    getRootNode: () => ({ activeElement: opts.focused === false ? null : el }),
    ownerDocument: {
      execCommand: (command, _ui, value) => {
        calls.push(`${command}:${value}`);
        const typed = (opts.typed ?? ((v) => v))(value);
        if (typed === null) return false;
        el.value = typed;
        return true;
      },
    },
  };
  return el;
};

describe("typeIntoField", () => {
  it("types over what the field held, through the editing command", () => {
    const el = field({ value: "old" });
    expect(typeIntoField(el, "person@example.com")).toBe(true);
    expect(el.value).toBe("person@example.com");
    expect(el.calls).toEqual(["select", "insertText:person@example.com"]);
  });

  it("types nothing into a field without the keyboard, or when there is nothing to type", () => {
    const away = field({ focused: false });
    expect(typeIntoField(away, "secret")).toBe(false);
    expect(away.calls).toEqual([]);
    expect(typeIntoField(field(), "")).toBe(false);
  });

  it("says so when editing is refused or the page left something else", () => {
    expect(typeIntoField(field({ typed: () => null }), "secret")).toBe(false);
    expect(typeIntoField(field({ typed: (v) => v.slice(0, 4) }), "person@example.com")).toBe(false);
  });

  it("counts a value the page formatted, outside password fields only", () => {
    expect(typeIntoField(field({ typed: (v) => v.replace(/(\d{4})(?=\d)/g, "$1 ") }), "4242424242424242")).toBe(true);
    expect(typeIntoField(field({ typed: () => "12/30" }), "1230")).toBe(true);
    expect(typeIntoField(field({ type: "password", typed: () => "pass word" }), "password")).toBe(false);
  });
});

describe("login fills", () => {
  it("type the values, and write them themselves only when typing fails", () => {
    for (const script of [fillLoginScript("u", "p"), fillIdentifierScript("u"), fillOtpScript("123456"), fillLoginByRefScript(null, "u", "p")]) {
      expect(script).toContain("const typeIntoField = ");
      expect(script).toContain("if (!typeIntoField(el, value))");
      expect(() => new Function(script)).not.toThrow();
    }
  });
});
