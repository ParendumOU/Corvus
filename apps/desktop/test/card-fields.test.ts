import { describe, expect, it } from "vitest";
import { cardKit, classifyCardField, isCardForm, matchCardOption, planCardFill, type CardFieldFacts, type CardFillField } from "../src/shared/card-fields";

const facts = (over: Partial<CardFieldFacts> = {}): CardFieldFacts => ({ tag: "INPUT", type: "text", autocomplete: "", name: "", id: "", label: "", placeholder: "", maxLength: 0, ...over });
const field = (over: Partial<CardFieldFacts> = {}, value = "", anchor = false): CardFillField => ({ facts: facts(over), value, anchor });

const CARD = { label: "", nameOnCard: "Ana Example", number: "4111111111111111", expMonth: "08", expYear: "2028" };

describe("classifyCardField", () => {
  it("reads the autocomplete tokens first", () => {
    expect(classifyCardField(facts({ autocomplete: "cc-number" }))).toBe("number");
    expect(classifyCardField(facts({ autocomplete: "billing cc-name" }))).toBe("name");
    expect(classifyCardField(facts({ autocomplete: "cc-exp" }))).toBe("exp");
    expect(classifyCardField(facts({ autocomplete: "cc-exp-month" }))).toBe("expMonth");
    expect(classifyCardField(facts({ autocomplete: "cc-exp-year" }))).toBe("expYear");
    expect(classifyCardField(facts({ autocomplete: "cc-csc" }))).toBe("csc");
    expect(classifyCardField(facts({ autocomplete: "cc-given-name" }))).toBe("givenName");
  });

  it("falls back on English and Spanish words", () => {
    expect(classifyCardField(facts({ name: "cardnumber" }))).toBe("number");
    expect(classifyCardField(facts({ label: "Número de tarjeta" }))).toBe("number");
    expect(classifyCardField(facts({ id: "ccNumber" }))).toBe("number");
    expect(classifyCardField(facts({ label: "Titular de la tarjeta" }))).toBe("name");
    expect(classifyCardField(facts({ label: "Name on card" }))).toBe("name");
    expect(classifyCardField(facts({ label: "Fecha de caducidad", placeholder: "MM/AA" }))).toBe("exp");
    expect(classifyCardField(facts({ placeholder: "MM / YY" }))).toBe("exp");
    expect(classifyCardField(facts({ name: "exp_month", tag: "SELECT", type: "select-one" }))).toBe("expMonth");
    expect(classifyCardField(facts({ label: "Mes de caducidad" }))).toBe("expMonth");
    expect(classifyCardField(facts({ label: "Año de caducidad" }))).toBe("expYear");
    expect(classifyCardField(facts({ label: "CVV" }))).toBe("csc");
    expect(classifyCardField(facts({ name: "cvc" }))).toBe("csc");
    expect(classifyCardField(facts({ label: "Código de seguridad" }))).toBe("csc");
  });

  it("leaves other fields alone", () => {
    expect(classifyCardField(facts({ name: "email" }))).toBeNull();
    expect(classifyCardField(facts({ label: "Nombre" }))).toBeNull();
    expect(classifyCardField(facts({ type: "password", autocomplete: "cc-number" }))).toBeNull();
    expect(classifyCardField(facts({ type: "hidden", name: "cardnumber" }))).toBeNull();
    expect(classifyCardField(facts({ label: "Gift card code" }))).toBeNull();
  });
});

describe("isCardForm", () => {
  it("needs a card number field", () => {
    expect(isCardForm(["number"])).toBe(true);
    expect(isCardForm(["name", "exp", "csc"])).toBe(false);
    expect(isCardForm([null, "number", "csc"])).toBe(true);
  });
});

describe("planCardFill", () => {
  it("fills number, name, a single MM/YY expiry and the CVV", () => {
    const fields = [field({ autocomplete: "cc-number" }, "", true), field({ autocomplete: "cc-name" }), field({ autocomplete: "cc-exp", placeholder: "MM / YY" }), field({ autocomplete: "cc-csc" })];
    expect(planCardFill(fields, CARD, "123")).toEqual(["4111111111111111", "Ana Example", "08/28", "123"]);
  });

  it("writes the expiry in the format the field expects", () => {
    expect(planCardFill([field({ autocomplete: "cc-number" }, "", true), field({ autocomplete: "cc-exp", placeholder: "MM/YYYY" })], CARD, "123")[1]).toBe("08/2028");
    expect(planCardFill([field({ autocomplete: "cc-number" }, "", true), field({ autocomplete: "cc-exp", maxLength: 4 })], CARD, "123")[1]).toBe("0828");
    expect(planCardFill([field({ autocomplete: "cc-number" }, "", true), field({ autocomplete: "cc-exp", maxLength: 7 })], CARD, "123")[1]).toBe("08/2028");
    expect(planCardFill([field({ autocomplete: "cc-number" }, "", true), field({ autocomplete: "cc-exp", placeholder: "MM-AA" })], CARD, "123")[1]).toBe("08-28");
  });

  it("fills month and year fields, a two-digit year where the field takes two", () => {
    const fields = [field({ autocomplete: "cc-number" }, "", true), field({ autocomplete: "cc-exp-month" }), field({ autocomplete: "cc-exp-year" })];
    expect(planCardFill(fields, CARD, "123")).toEqual(["4111111111111111", "08", "2028"]);
    const short = [field({ autocomplete: "cc-number" }, "", true), field({ autocomplete: "cc-exp-month" }), field({ autocomplete: "cc-exp-year", maxLength: 2 })];
    expect(planCardFill(short, CARD, "123")).toEqual(["4111111111111111", "08", "28"]);
  });

  it("splits the name into given and family fields", () => {
    const fields = [field({ autocomplete: "cc-number" }, "", true), field({ autocomplete: "cc-given-name" }), field({ autocomplete: "cc-family-name" })];
    expect(planCardFill(fields, CARD, "123")).toEqual(["4111111111111111", "Ana", "Example"]);
  });

  it("fills nothing outside a card form or when the clicked field is not a card field", () => {
    expect(planCardFill([field({ autocomplete: "cc-name" }, "", true), field({ autocomplete: "cc-csc" })], CARD, "123")).toEqual([null, null]);
    expect(planCardFill([field({ name: "email" }, "", true), field({ autocomplete: "cc-number" })], CARD, "123")).toEqual([null, null]);
  });

  it("writes no CVV when none is given", () => {
    const fields = [field({ autocomplete: "cc-number" }, "", true), field({ autocomplete: "cc-csc" })];
    expect(planCardFill(fields, CARD, "")).toEqual(["4111111111111111", null]);
  });
});

describe("matchCardOption", () => {
  it("matches months and years by value or text", () => {
    const months = [{ value: "", text: "Mes" }, ...Array.from({ length: 12 }, (_, i) => ({ value: String(i + 1), text: String(i + 1).padStart(2, "0") }))];
    expect(matchCardOption(months, "08")).toBe("8");
    const named = [{ value: "", text: "Month" }, { value: "aug", text: "August" }, { value: "sep", text: "September" }];
    expect(matchCardOption(named, "08")).toBe("aug");
    const years = [{ value: "2027", text: "2027" }, { value: "28", text: "2028" }];
    expect(matchCardOption(years, "2028")).toBe("28");
    const shortYears = [{ value: "27", text: "27" }, { value: "28", text: "28" }];
    expect(matchCardOption(shortYears, "2028")).toBe("28");
    expect(matchCardOption(years, "2031")).toBeNull();
  });
});

describe("cardKit", () => {
  it("is self-contained, so the fill script can embed its source", () => {
    const rebuilt = new Function(`return (${String(cardKit)})();`)() as ReturnType<typeof cardKit>;
    expect(rebuilt.classifyCardField(facts({ autocomplete: "cc-number" }))).toBe("number");
  });
});
