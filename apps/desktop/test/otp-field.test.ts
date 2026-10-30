import { describe, expect, it } from "vitest";
import { detectLoginScript, fillLoginByRefScript, fillLoginScript, fillOtpByRefScript, fillOtpScript } from "../src/main/credential-scripts";
import { isOtpFacts, otpFieldFacts, type OtpFieldFacts, type OtpInputElement } from "../src/shared/otp-field";

const facts = (extra: Partial<OtpFieldFacts>): OtpFieldFacts => ({
  type: "text",
  autocomplete: "",
  inputMode: "",
  maxLength: -1,
  pattern: "",
  placeholder: "",
  attrs: "",
  label: "",
  context: "",
  ...extra,
});

describe("isOtpFacts", () => {
  it("takes fields marked or named for a one-time code", () => {
    expect(isOtpFacts(facts({ autocomplete: "one-time-code" }))).toBe(true);
    expect(isOtpFacts(facts({ type: "password", autocomplete: "one-time-code" }))).toBe(true);
    expect(isOtpFacts(facts({ attrs: "otp" }))).toBe(true);
    expect(isOtpFacts(facts({ attrs: "totp_code" }))).toBe(true);
    expect(isOtpFacts(facts({ label: "Verification code" }))).toBe(true);
    expect(isOtpFacts(facts({ label: "Two-factor authentication code" }))).toBe(true);
    expect(isOtpFacts(facts({ placeholder: "Enter your 2FA code" }))).toBe(true);
    expect(isOtpFacts(facts({ label: "Codigo de verificacion" }))).toBe(true);
    expect(isOtpFacts(facts({ type: "tel", inputMode: "numeric", maxLength: 6, attrs: "code" }))).toBe(true);
  });

  it("takes a code-shaped field whose label is apart, by the text beside it", () => {
    // The owner's sign-in page: label not tied to the field, a "1 2 3 4 5 6" placeholder, help text.
    expect(isOtpFacts(facts({ attrs: "code", placeholder: "1 2 3 4 5 6", context: "Verification code The 6-digit code shown by your authenticator app." }))).toBe(true);
    expect(isOtpFacts(facts({ placeholder: "1 2 3 4 5 6", context: "Verification code The 6-digit code shown by your authenticator app." }))).toBe(true);
    expect(isOtpFacts(facts({ attrs: "token", inputMode: "numeric", maxLength: 6, context: "Enter the code from your authenticator app." }))).toBe(true);
    expect(isOtpFacts(facts({ attrs: "f2", pattern: "[0-9]{6}", context: "Two-step verification" }))).toBe(true);
    expect(isOtpFacts(facts({ placeholder: "123 456", inputMode: "numeric" }))).toBe(true);
    expect(isOtpFacts(facts({ placeholder: "XXX-XXX", attrs: "code" }))).toBe(true);
  });

  it("leaves login, card, coupon, phone and search fields alone", () => {
    expect(isOtpFacts(facts({ type: "email", label: "Verification code" }))).toBe(false);
    expect(isOtpFacts(facts({ type: "password", label: "Password" }))).toBe(false);
    expect(isOtpFacts(facts({ attrs: "username", label: "Username", context: "Verification code" }))).toBe(false);
    expect(isOtpFacts(facts({ label: "Card security code", inputMode: "numeric", maxLength: 4 }))).toBe(false);
    expect(isOtpFacts(facts({ attrs: "cvc", placeholder: "123", context: "Two-step verification" }))).toBe(false);
    expect(isOtpFacts(facts({ label: "Promo code", maxLength: 8 }))).toBe(false);
    expect(isOtpFacts(facts({ label: "ZIP code", inputMode: "numeric", maxLength: 6 }))).toBe(false);
    expect(isOtpFacts(facts({ attrs: "phone", inputMode: "numeric", maxLength: 8, placeholder: "123456" }))).toBe(false);
    expect(isOtpFacts(facts({ attrs: "q", placeholder: "Search", context: "Sign in with two-factor authentication" }))).toBe(false);
    // Help about an authenticator next to a field that does not look like a code field.
    expect(isOtpFacts(facts({ attrs: "nickname", context: "Name your authenticator app" }))).toBe(false);
    // A code-like placeholder alone is not enough.
    expect(isOtpFacts(facts({ placeholder: "123456" }))).toBe(false);
    // Card wording beside a code-shaped field.
    expect(isOtpFacts(facts({ attrs: "code", maxLength: 6, context: "Enter the verification code on the back of your gift card" }))).toBe(false);
  });
});

// ------------------------------------------------------------------ a small stand-in for the DOM

const NOT_FIELDS = ["hidden", "submit", "button", "reset", "image", "checkbox", "radio"];

class FakeNode {
  parentElement: FakeNode | null = null;
  readonly children: FakeNode[] = [];
  labels: FakeNode[] = [];
  readonly ownerDocument = { getElementById: (): FakeNode | null => null };

  constructor(
    readonly tag: string,
    readonly attributes: Record<string, string> = {},
    readonly text = "",
  ) {}

  get textContent(): string {
    return [this.text, ...this.children.map((c) => c.textContent)].filter(Boolean).join(" ");
  }
  get previousElementSibling(): FakeNode | null {
    const siblings = this.parentElement?.children ?? [];
    const i = siblings.indexOf(this);
    return i > 0 ? (siblings[i - 1] ?? null) : null;
  }
  get nextElementSibling(): FakeNode | null {
    const siblings = this.parentElement?.children ?? [];
    const i = siblings.indexOf(this);
    return i >= 0 ? (siblings[i + 1] ?? null) : null;
  }
  get name(): string {
    return this.attributes.name ?? "";
  }
  get id(): string {
    return this.attributes.id ?? "";
  }
  get maxLength(): number {
    return this.attributes.maxlength ? Number(this.attributes.maxlength) : -1;
  }
  getAttribute(name: string): string | null {
    return this.attributes[name] ?? null;
  }
  /** Counts the fields under this node (the only query otpFieldFacts makes). */
  querySelectorAll(): { length: number } {
    const all = (n: FakeNode): FakeNode[] => n.children.flatMap((c) => [c, ...all(c)]);
    const isField = (n: FakeNode): boolean => ["select", "textarea"].includes(n.tag) || (n.tag === "input" && !NOT_FIELDS.includes(n.attributes.type ?? "text"));
    return { length: all(this).filter(isField).length };
  }
  add(...children: FakeNode[]): this {
    for (const child of children) {
      child.parentElement = this;
      this.children.push(child);
    }
    return this;
  }
}

const el = (tag: string, attributes: Record<string, string> = {}, text = ""): FakeNode => new FakeNode(tag, attributes, text);

/** The owner's sign-in form: username, password and verification code, the code's label apart. */
function signInForm(): { user: FakeNode; code: FakeNode } {
  const user = el("input", { id: "u", name: "username", type: "text" });
  const pass = el("input", { id: "p", name: "password", type: "password" });
  const code = el("input", { name: "code", type: "text", placeholder: "1 2 3 4 5 6" });
  const userLabel = el("label", { for: "u" }, "Username");
  user.labels = [userLabel];
  el("form").add(
    el("input", { type: "hidden", name: "csrf" }),
    el("div").add(userLabel, user),
    el("div").add(el("label", {}, "Password"), pass),
    el("div").add(el("label", {}, "Verification code"), code, el("small", {}, "The 6-digit code shown by your authenticator app.")),
    el("button", { type: "submit" }, "Verify"),
  );
  return { user, code };
}

const read = (node: FakeNode): OtpFieldFacts => otpFieldFacts(node as unknown as OtpInputElement);

describe("otpFieldFacts", () => {
  it("reads the label and help next to a field when they are not tied to it", () => {
    const { user, code } = signInForm();
    const f = read(code);
    expect(f).toMatchObject({ type: "text", placeholder: "1 2 3 4 5 6", attrs: "code", label: "" });
    expect(f.context).toContain("Verification code");
    expect(f.context).toContain("authenticator app");
    expect(isOtpFacts(f)).toBe(true);
    // The other fields' wrappers do not lend them the code's text.
    expect(read(user).context).not.toContain("Verification");
    expect(read(user).label).toBe("Username");
    expect(isOtpFacts(read(user))).toBe(false);
  });

  it("climbs through wrappers that hold the field alone, and stops at the form", () => {
    const code = el("input", { name: "token", inputmode: "numeric", maxlength: "6" });
    el("form").add(el("h1", {}, "Two-step verification"), el("p", {}, "Enter the code from your authenticator app."), el("div").add(el("span").add(code)), el("button", {}, "Verify"));
    expect(read(code).context).toContain("authenticator app");
    expect(isOtpFacts(read(code))).toBe(true);
  });
});

describe("autofill scripts", () => {
  it("are valid JavaScript with the shared field test inside", () => {
    const scripts = [detectLoginScript(), fillLoginScript("u", "p"), fillLoginScript("u", "p", { keepTyped: true, submit: true }), fillOtpScript("123456"), fillOtpByRefScript("e1", "123456"), fillLoginByRefScript(null, "u", "p")];
    for (const script of scripts) {
      expect(() => new Function(script)).not.toThrow();
      expect(script).toContain("NEARBY_HINT");
    }
  });
});
