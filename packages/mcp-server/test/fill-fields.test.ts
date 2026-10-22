import { afterEach, describe, expect, it } from "vitest";
import { requiredLevel } from "../src/access.js";
import { MockBrowserController, type MockPage } from "../src/testing/index.js";
import { call, startHarness, textOf, type Harness } from "./helpers.js";

const FORM_URL = "https://form.example/";

const FORM: MockPage = {
  title: "Form",
  text: "Signup",
  elements: [
    { ref: "e1", role: "textbox", name: "Email" },
    { ref: "e2", role: "checkbox", name: "Subscribe", value: "unchecked" },
    { ref: "e3", role: "combobox", name: "Country", options: ["Spain", "France"] },
    { ref: "e5", role: "button", name: "Pay now" },
    { ref: "e6", role: "button", name: "Cancel" },
  ],
};

function controller(): MockBrowserController {
  return new MockBrowserController({ initialTabs: [FORM_URL], pages: { [FORM_URL]: FORM } });
}

let harness: Harness;
afterEach(async () => {
  await harness?.close();
});

describe("fill_fields access gating", () => {
  it("is full level", () => {
    expect(requiredLevel("fill_fields")).toBe("full");
  });

  it("is hidden below full, present at full", async () => {
    harness = await startHarness({ accessLevel: "standard" }, controller());
    expect((await (await harness.connect()).listTools()).tools.map((t) => t.name)).not.toContain("fill_fields");
    await harness.close();
    harness = await startHarness({ accessLevel: "full" }, controller());
    expect((await (await harness.connect()).listTools()).tools.map((t) => t.name)).toContain("fill_fields");
  });
});

describe("fill_fields behavior", () => {
  it("fills mixed fields matched by role/name", async () => {
    harness = await startHarness({ accessLevel: "full" }, controller());
    const client = await harness.connect();
    const res = await call(client, "fill_fields", {
      fields: [
        { name: "Email", value: "a@b.c" },
        { role: "checkbox", name: "Subscribe", value: true },
        { name: "Country", value: "Spain" },
      ],
    });
    expect(textOf(res)).toBe("filled 3/3");
    const snap = textOf(await call(client, "page_snapshot"));
    expect(snap).toContain('e1 textbox "Email" ="a@b.c"');
    expect(snap).toContain('e2 checkbox "Subscribe" ="checked"');
    expect(snap).toContain('e3 combobox "Country" ="Spain"');
  });

  it("reports unmatched fields as partial failures", async () => {
    harness = await startHarness({ accessLevel: "full" }, controller());
    const res = await call(await harness.connect(), "fill_fields", {
      fields: [
        { name: "Email", value: "x@y.z" },
        { name: "Nonexistent", value: "z" },
      ],
    });
    expect(res.isError).toBeFalsy();
    expect(textOf(res)).toMatch(/filled 1\/2; failed:\nNonexistent: no matching field/);
  });

  it("errors when nothing matched and no submit requested", async () => {
    harness = await startHarness({ accessLevel: "full" }, controller());
    const res = await call(await harness.connect(), "fill_fields", { fields: [{ name: "Nope", value: "z" }] });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("filled 0/1");
  });

  it("submits through the click primitive, not a bypass", async () => {
    const c = controller();
    harness = await startHarness({ accessLevel: "full" }, c);
    const res = await call(await harness.connect(), "fill_fields", {
      fields: [{ name: "Email", value: "a@b.c" }],
      submit: true,
      submitName: "Pay now",
    });
    expect(textOf(res)).toBe('filled 1/1; submitted via "Pay now"');
    expect(c.calls.filter((x) => x.method === "click").map((x) => x.args[1])).toEqual(["e5"]);
  });

  it("notes when no submit button is found", async () => {
    harness = await startHarness({ accessLevel: "full" }, controller());
    const res = await call(await harness.connect(), "fill_fields", {
      fields: [{ name: "Email", value: "a@b.c" }],
      submit: true,
      submitName: "Nonexistent button",
    });
    expect(textOf(res)).toContain("submit skipped: no submit button found");
  });
});
