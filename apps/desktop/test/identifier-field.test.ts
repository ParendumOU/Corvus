import { describe, expect, it } from "vitest";
import { detectLoginScript, fillIdentifierScript, fillLoginByRefScript } from "../src/main/credential-scripts";
import { dropdownMayOpen } from "../src/shared/field-dropdown";
import { isIdentifierFacts, type IdentifierFieldFacts } from "../src/shared/identifier-field";

type Facts = Omit<Partial<IdentifierFieldFacts>, "form"> & { form?: Partial<IdentifierFieldFacts["form"]> };
const facts = ({ form, ...extra }: Facts): IdentifierFieldFacts => ({
  type: "email",
  autocomplete: "",
  hints: "",
  search: false,
  ...extra,
  form: { password: false, newPassword: false, textFields: 1, hints: "", ...form },
});

describe("isIdentifierFacts", () => {
  it("takes a two-step sign-in's first step, a hidden decoy password field or not", () => {
    // login.ionos.es: autocomplete="username", "Siguiente", a hidden password decoy (it does not show).
    expect(isIdentifierFacts(facts({ autocomplete: "username", hints: "identifier username correo electrónico", form: { hints: "siguiente" } }))).toBe(true);
    // No password input at all (Google, Microsoft), and no form either.
    expect(isIdentifierFacts(facts({ autocomplete: "username", hints: "identifier identifierid email or phone", form: { hints: "forgot email? create account next" } }))).toBe(true);
    expect(isIdentifierFacts(facts({ type: "text", hints: "loginfmt email, phone, or skype", form: { hints: "/common/login next" } }))).toBe(true);
  });

  it("takes an e-mail or username field only in a form that signs in or goes on", () => {
    expect(isIdentifierFacts(facts({ autocomplete: "email", form: { hints: "continue" } }))).toBe(true);
    expect(isIdentifierFacts(facts({ type: "text", hints: "id de cliente o usuario", form: { hints: "acceder" } }))).toBe(true);
    expect(isIdentifierFacts(facts({ type: "tel", hints: "teléfono", form: { hints: "iniciar sesión" } }))).toBe(true);
    expect(isIdentifierFacts(facts({ autocomplete: "email", form: { hints: "send" } }))).toBe(false);
    expect(isIdentifierFacts(facts({ type: "text", hints: "city", form: { hints: "next" } }))).toBe(false);
  });

  it("leaves newsletters, sign-ups and searches alone", () => {
    expect(isIdentifierFacts(facts({ autocomplete: "email", hints: "email", form: { hints: "subscribe" } }))).toBe(false);
    expect(isIdentifierFacts(facts({ hints: "correo", form: { hints: "suscribirme al boletín" } }))).toBe(false);
    expect(isIdentifierFacts(facts({ autocomplete: "username", form: { hints: "/register create account" } }))).toBe(false);
    expect(isIdentifierFacts(facts({ autocomplete: "username", form: { newPassword: true, hints: "next" } }))).toBe(false);
    expect(isIdentifierFacts(facts({ autocomplete: "username", form: { textFields: 3, hints: "next" } }))).toBe(false);
    expect(isIdentifierFacts(facts({ type: "search", hints: "q", form: { hints: "search" } }))).toBe(false);
    expect(isIdentifierFacts(facts({ type: "text", autocomplete: "username", search: true }))).toBe(false);
    expect(isIdentifierFacts(facts({ type: "text", hints: "search users", form: { hints: "go" } }))).toBe(false);
  });

  it("leaves one-step login forms to the login form, and one-time codes to the code fill", () => {
    expect(isIdentifierFacts(facts({ autocomplete: "username", form: { password: true, hints: "sign in" } }))).toBe(false);
    expect(isIdentifierFacts(facts({ type: "text", autocomplete: "one-time-code", hints: "code", form: { hints: "verify" } }))).toBe(false);
    expect(isIdentifierFacts(facts({ type: "number", autocomplete: "username" }))).toBe(false);
  });
});

describe("the username step in the autofill", () => {
  it("is found and filled by valid scripts with the shared field test inside", () => {
    for (const script of [detectLoginScript(), fillIdentifierScript("info@example.com"), fillIdentifierScript("x", { keepTyped: true }), fillLoginByRefScript(null, "u", "p")]) {
      expect(() => new Function(script)).not.toThrow();
      expect(script).toContain("isIdentifierFacts");
    }
  });

  it("loads the dropdown ahead only when the site has accounts to offer there", () => {
    const account = { id: "a", username: "info@example.com", site: "example.com", hasPassword: true, hasTotp: false, source: "corvus" as const, fit: "exact" as const };
    expect(dropdownMayOpen({ login: false, identifier: true, otp: false }, [account])).toBe(true);
    expect(dropdownMayOpen({ login: false, identifier: true, otp: false }, [])).toBe(false);
  });
});
