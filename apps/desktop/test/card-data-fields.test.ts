import { describe, expect, it } from "vitest";
import { cardDataRole, isCardDataField, isCardDataForm } from "../src/shared/card-data-fields";
import type { CardFieldFacts } from "../src/shared/card-fields";

const facts = (over: Partial<CardFieldFacts> = {}): CardFieldFacts => ({ tag: "INPUT", type: "text", autocomplete: "", name: "", id: "", label: "", placeholder: "", maxLength: 0, ...over });

describe("card data fields", () => {
  it("take a security code in a password field for a card field, by autocomplete or by its words", () => {
    expect(cardDataRole(facts({ type: "password", autocomplete: "cc-csc" }))).toBe("csc");
    expect(cardDataRole(facts({ type: "password", name: "cvv" }))).toBe("csc");
    expect(cardDataRole(facts({ type: "password", label: "Código de seguridad" }))).toBe("csc");
    expect(cardDataRole(facts({ type: "password", label: "Número de tarjeta" }))).toBe("number");
    expect(isCardDataField(facts({ type: "password", autocomplete: "billing cc-csc" }))).toBe(true);
    expect(isCardDataField(facts({ type: "password", id: "cvc" }))).toBe(true);
  });

  it("count any cc- autocomplete token and every card role", () => {
    expect(isCardDataField(facts({ autocomplete: "cc-type" }))).toBe(true);
    expect(isCardDataField(facts({ autocomplete: "CC-Number" }))).toBe(true);
    expect(isCardDataField(facts({ label: "Titular de la tarjeta" }))).toBe(true);
    expect(isCardDataField(facts({ placeholder: "MM/AA" }))).toBe(true);
  });

  it("leave login fields alone", () => {
    expect(isCardDataField(facts({ type: "password", name: "password", autocomplete: "current-password" }))).toBe(false);
    expect(isCardDataField(facts({ type: "password", label: "Contraseña" }))).toBe(false);
    expect(isCardDataField(facts({ type: "password", name: "pin" }))).toBe(false);
    expect(isCardDataField(facts({ type: "email", name: "email", autocomplete: "username" }))).toBe(false);
    expect(isCardDataField(facts({ name: "user", label: "Usuario" }))).toBe(false);
  });

  it("tell a card form, its CVV a password field, from a login form", () => {
    const checkout = [facts({ autocomplete: "cc-number" }), facts({ label: "Titular" }), facts({ type: "password", autocomplete: "cc-csc" })];
    expect(isCardDataForm(checkout)).toBe(true);
    expect(isCardDataForm([facts({ type: "password", label: "Número de tarjeta" }), facts({ type: "password", label: "CVV" })])).toBe(true);
    expect(isCardDataForm([facts({ type: "email", name: "email" }), facts({ type: "password", name: "password" })])).toBe(false);
    // A security code alone (no card number) is not a card form, but its field is still card data.
    expect(isCardDataForm([facts({ name: "user" }), facts({ type: "password", name: "cvv" })])).toBe(false);
  });
});
