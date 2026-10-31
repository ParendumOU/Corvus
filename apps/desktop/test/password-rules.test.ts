import { describe, expect, it } from "vitest";
import { DEFAULT_PASSWORD_OPTIONS, generatePassword, type PasswordOptions } from "../src/shared/credentials";
import { fitGenerator, offersGenerator, parsePasswordFieldClick, PASSWORD_CHARSETS, probePattern, toggleClass, type FieldPasswordRules, type PasswordFieldClick } from "../src/shared/password-rules";
import { translate } from "../src/shared/i18n-es";

/** A field's pattern as the page tests it: the whole value must match. */
const fits = (pattern: string) => (value: string): boolean => new RegExp(`^(?:${pattern})$`, "u").test(value);
const rulesFor = (pattern: string | null, extra: Partial<FieldPasswordRules> = {}): FieldPasswordRules => ({
  minLength: 0,
  maxLength: 0,
  numeric: false,
  pattern: pattern === null ? null : (probePattern(fits(pattern)) ?? "none"),
  ...extra,
});
const PREFS: PasswordOptions = { ...DEFAULT_PASSWORD_OPTIONS, length: 24 };
const ALL = { lowercase: true, uppercase: true, digits: true, symbols: true };
const NONE = { lowercase: false, uppercase: false, digits: false, symbols: false };

describe("probePattern", () => {
  it("finds that a pattern takes any strong password", () => {
    expect(probePattern(fits(".{8,}"))).toEqual({ allowed: ALL, symbols: PASSWORD_CHARSETS.symbols, required: NONE, minLength: 8, maxLength: 128 });
  });

  it("finds the classes, symbols and lengths a pattern takes, and the classes it asks for", () => {
    expect(probePattern(fits("[A-Za-z0-9]{8,20}"))).toEqual({ allowed: { ...ALL, symbols: false }, symbols: "", required: NONE, minLength: 8, maxLength: 20 });
    expect(probePattern(fits("(?=.*[a-z])(?=.*[A-Z])(?=.*\\d)(?=.*[@$!%*?&])[A-Za-z\\d@$!%*?&]{8,}"))).toEqual({ allowed: ALL, symbols: "!@$%&*?", required: ALL, minLength: 8, maxLength: 128 });
    expect(probePattern(fits("[a-z]{10,12}"))).toEqual({ allowed: { ...NONE, lowercase: true }, symbols: "", required: { ...NONE, lowercase: true }, minLength: 10, maxLength: 12 });
  });

  it("gives up on a pattern that takes no password of 8 characters or more (a PIN)", () => {
    expect(probePattern(fits("\\d{6}"))).toBeNull();
  });
});

describe("fitGenerator", () => {
  it("keeps the person's choices when the field sets nothing", () => {
    const fit = fitGenerator(PREFS, rulesFor(null));
    expect(fit).toEqual({ options: PREFS, symbols: PASSWORD_CHARSETS.symbols, minLength: 8, maxLength: 128, fixed: NONE, notes: [] });
  });

  it("clamps the length to the field's maxlength and minlength, and says so", () => {
    expect(fitGenerator(PREFS, rulesFor(null, { maxLength: 16 }))).toMatchObject({ options: { length: 16 }, maxLength: 16, notes: [{ type: "max", length: 16 }] });
    expect(fitGenerator(PREFS, rulesFor(null, { minLength: 30 }))).toMatchObject({ options: { length: 30 }, minLength: 30, notes: [{ type: "min", length: 30 }] });
    expect(fitGenerator({ ...PREFS, length: 12 }, rulesFor(null, { maxLength: 16 })).notes).toEqual([]);
    // A pattern's own lengths count too.
    expect(fitGenerator(PREFS, rulesFor("[A-Za-z0-9]{8,20}"))).toMatchObject({ options: { length: 20 }, maxLength: 20 });
  });

  it("drops the classes the pattern forbids and adds those it asks for, and says so", () => {
    const noSymbols = fitGenerator(PREFS, rulesFor("[A-Za-z0-9]{8,64}"));
    expect(noSymbols.options.symbols).toBe(false);
    expect(noSymbols.fixed.symbols).toBe(true);
    expect(noSymbols.notes).toEqual([{ type: "without", option: "symbols" }]);
    const strict = fitGenerator({ ...PREFS, digits: false }, rulesFor("(?=.*[a-z])(?=.*[A-Z])(?=.*\\d)(?=.*[@$!%*?&])[A-Za-z\\d@$!%*?&]{8,}"));
    expect(strict.options).toEqual({ ...PREFS, digits: true });
    expect(strict.symbols).toBe("!@$%&*?");
    expect(strict.notes).toEqual([{ type: "with", option: "digits" }, { type: "symbols", symbols: "!@$%&*?" }]);
    // Only a forbidden class chosen: every class the field takes.
    const onlySymbols = fitGenerator({ ...NONE, symbols: true, length: 24 }, rulesFor("[A-Za-z0-9]{8,64}"));
    expect(onlySymbols.options).toEqual({ length: 24, ...ALL, symbols: false });
  });

  it("makes passwords the field takes", () => {
    const cases: Array<[string, Partial<FieldPasswordRules>]> = [
      ["[A-Za-z0-9]{8,20}", {}],
      ["(?=.*[a-z])(?=.*[A-Z])(?=.*\\d)(?=.*[@$!%*?&])[A-Za-z\\d@$!%*?&]{8,}", { maxLength: 40 }],
      ["[a-z0-9!@#]{12,16}", {}],
      [".{8,}", { maxLength: 12 }],
    ];
    for (const [pattern, extra] of cases) {
      const rules = rulesFor(pattern, extra);
      const fit = fitGenerator(PREFS, rules);
      for (let i = 0; i < 30; i++) {
        const password = generatePassword(fit.options, fit.symbols);
        expect(fits(pattern)(password), `${pattern}: ${password}`).toBe(true);
        expect(password.length).toBeLessThanOrEqual(rules.maxLength || 128);
      }
    }
  });

  it("has a Spanish text for every note and option", () => {
    const texts = [
      "This site takes at most {length} characters.",
      "This site asks for at least {length} characters.",
      "Only the symbols this site takes: {symbols}",
      "Without lowercase letters: this site does not take them.",
      "Without uppercase letters: this site does not take them.",
      "Without digits: this site does not take them.",
      "Without symbols: this site does not take them.",
      "With lowercase letters: this site asks for them.",
      "With uppercase letters: this site asks for them.",
      "With digits: this site asks for them.",
      "With symbols: this site asks for them.",
      "Lowercase",
      "Uppercase",
      "Digits",
      "Symbols",
    ];
    for (const text of texts) expect(translate("es", text), text).not.toBe(text);
  });
});

describe("offersGenerator", () => {
  const click = (role: PasswordFieldClick["role"], fields: number, extra: Partial<FieldPasswordRules> = {}) => ({ role, fields, rules: rulesFor(null, extra) });

  it("suggests a password in a field for a new one or its confirmation, accounts or not", () => {
    expect(offersGenerator(click("new", 2), true)).toBe(true);
    expect(offersGenerator(click("confirm", 3), true)).toBe(true);
    expect(offersGenerator(click("new", 1), false)).toBe(true);
  });

  it("suggests one in a lone password field only when there is no login to offer for it", () => {
    expect(offersGenerator(click("current", 1), false)).toBe(true);
    expect(offersGenerator(click("current", 1), true)).toBe(false);
    // The current password of a change form never gets one.
    expect(offersGenerator(click("current", 3), false)).toBe(false);
  });

  it("never suggests one for a PIN, a field too short or a pattern that takes none", () => {
    expect(offersGenerator(click("new", 2, { numeric: true }), false)).toBe(false);
    expect(offersGenerator(click("new", 2, { maxLength: 6 }), false)).toBe(false);
    expect(offersGenerator(click("new", 2, { maxLength: 8 }), false)).toBe(true);
    expect(offersGenerator({ role: "new", fields: 2, rules: rulesFor("\\d{6}") }, false)).toBe(false);
  });
});

describe("the generator's choices", () => {
  it("keep at least one class on", () => {
    expect(toggleClass(PREFS, "symbols")).toEqual({ ...PREFS, symbols: false });
    const onlyDigits = { ...PREFS, ...NONE, digits: true };
    expect(toggleClass(onlyDigits, "digits")).toBe(onlyDigits);
    expect(toggleClass(onlyDigits, "lowercase")).toEqual({ ...onlyDigits, lowercase: true });
  });

  it("draw symbols only from those given", () => {
    for (let i = 0; i < 30; i++) expect(generatePassword({ length: 40, ...NONE, symbols: true }, "!@")).toMatch(/^[!@]+$/);
    expect(generatePassword({ length: 12, ...NONE, symbols: true }, "")).toMatch(/^[a-z]+$/);
  });
});

describe("a password field click from the tab preload", () => {
  const good = {
    role: "new",
    fields: 2,
    filled: false,
    rules: { minLength: 0, maxLength: 64, numeric: false, pattern: { allowed: ALL, required: NONE, symbols: "!@x!", minLength: 8, maxLength: 64 } },
  };

  it("is checked: known shapes and sizes, the generator's symbols only", () => {
    expect(parsePasswordFieldClick(good)).toEqual({ ...good, rules: { ...good.rules, pattern: { ...good.rules.pattern, symbols: "!@" } } });
    expect(parsePasswordFieldClick({ ...good, rules: { ...good.rules, pattern: "none" } })?.rules.pattern).toBe("none");
    expect(parsePasswordFieldClick({ ...good, fields: -3, rules: { minLength: -1, maxLength: 1e9 } })).toEqual({ role: "new", fields: 1, filled: false, rules: { minLength: 0, maxLength: 10_000, numeric: false, pattern: null } });
    expect(parsePasswordFieldClick({ ...good, rules: { ...good.rules, pattern: { ...good.rules.pattern, minLength: 70 } } })?.rules.pattern).toBeNull();
    expect(parsePasswordFieldClick({ ...good, rules: { ...good.rules, pattern: { ...good.rules.pattern, symbols: "x" } } })?.rules.pattern).toMatchObject({ allowed: { ...ALL, symbols: false }, symbols: "" });
    for (const bad of [null, "new", { ...good, role: "admin" }, { ...good, filled: "yes" }]) expect(parsePasswordFieldClick(bad), JSON.stringify(bad)).toBeNull();
  });
});
