import { describe, expect, it } from "vitest";
import { deepActiveElement, deepElementFromPoint, deepQueryAll } from "../src/shared/shadow-dom";

/** A small stand-in for the DOM: elements with a tag, children and maybe an open shadow root. */
interface FakeElement {
  tag: string;
  children: FakeElement[];
  shadowRoot: FakeRoot | null;
}

interface FakeRoot {
  children: FakeElement[];
  activeElement: FakeElement | null;
  /** What elementFromPoint returns in this root. */
  at: FakeElement | null;
  querySelectorAll(selector: string): FakeElement[];
  elementFromPoint(x: number, y: number): FakeElement | null;
}

const el = (tag: string, children: FakeElement[] = [], shadow: FakeElement[] | null = null): FakeElement => ({ tag, children, shadowRoot: shadow ? root(shadow) : null });

/** Its own tree only, as querySelectorAll does: never into a shadow root. Selectors are tag names here. */
function root(children: FakeElement[]): FakeRoot {
  const own = (): FakeElement[] => {
    const out: FakeElement[] = [];
    const walk = (list: FakeElement[]): void => list.forEach((e) => (out.push(e), walk(e.children)));
    walk(children);
    return out;
  };
  return {
    children,
    activeElement: null,
    at: null,
    querySelectorAll: (selector) => own().filter((e) => selector === "*" || selector.split(",").map((s) => s.trim()).includes(e.tag)),
    elementFromPoint() {
      return this.at;
    },
  };
}

describe("fields in shadow roots", () => {
  const user = el("input");
  const pass = el("input");
  const inner = el("input");
  const widget = el("sign-in", [], [el("form", [user, pass]), el("nested-box", [], [inner])]);
  const page = root([el("main", [el("input"), widget])]);

  it("finds them at any depth, the page's own fields first", () => {
    const found = deepQueryAll(page, "input");
    expect(found).toHaveLength(4);
    expect(found.slice(1)).toEqual([user, pass, inner]);
    expect(deepQueryAll(widget.shadowRoot!, "input")).toEqual([user, pass, inner]);
    expect(deepQueryAll(page, "textarea")).toEqual([]);
  });

  it("reads the focused field inside the components that hold it", () => {
    page.activeElement = widget;
    widget.shadowRoot!.activeElement = pass;
    expect(deepActiveElement(page)).toBe(pass);
    page.activeElement = null;
    expect(deepActiveElement(page)).toBeNull();
  });

  it("finds the field at a point inside the components there", () => {
    page.at = widget;
    widget.shadowRoot!.at = user;
    expect(deepElementFromPoint(page, 10, 10)).toBe(user);
    // A component whose root returns itself (nothing inside at that point) stays the answer.
    widget.shadowRoot!.at = widget;
    expect(deepElementFromPoint(page, 10, 10)).toBe(widget);
  });

  it("are self-contained, so the autofill scripts can embed them", () => {
    for (const fn of [deepQueryAll, deepActiveElement, deepElementFromPoint]) expect(() => new Function(`return (${String(fn)});`)()).not.toThrow();
  });
});
