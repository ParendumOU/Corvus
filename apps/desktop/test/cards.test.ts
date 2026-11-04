import { describe, expect, it } from "vitest";
import {
  capturedCard,
  cardBrand,
  cardExpiry,
  cardLine,
  cardSaveDecision,
  cardSummary,
  cardTitle,
  cleanCardFields,
  compareCapturedCard,
  emptyCardFields,
  isValidCard,
  luhnValid,
  maskedCardNumber,
  parseCardCapture,
  parseCardSave,
  searchCards,
  type AutofillCard,
} from "../src/shared/cards";

const VISA = "4111111111111111";
const MASTERCARD = "5555555555554444";
const AMEX = "378282246310005";

const card = (over: Partial<AutofillCard> = {}): AutofillCard => ({
  ...emptyCardFields(),
  id: "c1",
  number: VISA,
  nameOnCard: "Ana Example",
  expMonth: "08",
  expYear: "2028",
  createdAt: 1,
  updatedAt: 1,
  lastUsedAt: 0,
  useCount: 0,
  ...over,
});

describe("card numbers", () => {
  it("checks the Luhn digit", () => {
    expect(luhnValid(VISA)).toBe(true);
    expect(luhnValid(MASTERCARD)).toBe(true);
    expect(luhnValid(AMEX)).toBe(true);
    expect(luhnValid("4111 1111 1111 1111")).toBe(true);
    expect(luhnValid("4111111111111112")).toBe(false);
    expect(luhnValid("1234")).toBe(false);
    expect(luhnValid("")).toBe(false);
  });

  it("derives the brand from the number", () => {
    expect(cardBrand(VISA)).toBe("Visa");
    expect(cardBrand(MASTERCARD)).toBe("Mastercard");
    expect(cardBrand("2221000000000009")).toBe("Mastercard");
    expect(cardBrand(AMEX)).toBe("American Express");
    expect(cardBrand("6011111111111117")).toBe("Discover");
    expect(cardBrand("3530111333300000")).toBe("JCB");
    expect(cardBrand("36227206271667")).toBe("Diners Club");
    expect(cardBrand("6200000000000005")).toBe("UnionPay");
    expect(cardBrand("6759649826438453")).toBe("Maestro");
    expect(cardBrand("9999999999999995")).toBe("Card");
  });

  it("names a card by brand, last digits and expiry", () => {
    expect(cardTitle(card())).toBe("Visa ...1111");
    expect(cardExpiry(card())).toBe("08/28");
    expect(cardExpiry(card({ expMonth: "", expYear: "" }))).toBe("");
    expect(cardLine(card())).toBe("Visa ...1111 - 08/28");
    expect(cardLine(card({ expMonth: "", expYear: "" }))).toBe("Visa ...1111");
    expect(maskedCardNumber(VISA)).toBe("**** **** **** 1111");
  });

  it("summarises a card without its number", () => {
    const s = cardSummary(card({ label: "Work" }));
    expect(s).toMatchObject({ id: "c1", label: "Work", brand: "Visa", last4: "1111", expMonth: "08", expYear: "2028", nameOnCard: "Ana Example" });
    expect(JSON.stringify(s)).not.toContain(VISA);
  });
});

describe("cleanCardFields", () => {
  it("keeps digits only, two-digit months and four-digit years", () => {
    expect(cleanCardFields({ number: "4111 1111-1111 1111", nameOnCard: "  Ana   Example ", expMonth: "8", expYear: "28", label: " Work " })).toEqual({
      label: "Work",
      nameOnCard: "Ana Example",
      number: VISA,
      expMonth: "08",
      expYear: "2028",
    });
    expect(cleanCardFields({ expMonth: "13", expYear: "1999" })).toMatchObject({ expMonth: "", expYear: "" });
    expect(cleanCardFields({ expMonth: 8 as unknown as string })).toMatchObject({ expMonth: "" });
  });

  it("never keeps a CVV or anything it does not know", () => {
    const clean = cleanCardFields({ number: VISA, cvv: "123", csc: "123", cvc: "123" } as never);
    expect(Object.keys(clean).sort()).toEqual(["expMonth", "expYear", "label", "nameOnCard", "number"]);
    expect(JSON.stringify(clean)).not.toContain("123\"");
  });
});

describe("isValidCard", () => {
  it("needs an id, a 12 to 19 digit number and numbers for the dates", () => {
    expect(isValidCard(card())).toBe(true);
    expect(isValidCard(card({ number: "4111" }))).toBe(false);
    expect(isValidCard(card({ number: "4111a11111111111" }))).toBe(false);
    expect(isValidCard(card({ id: "" }))).toBe(false);
    expect(isValidCard({ ...card(), useCount: "1" })).toBe(false);
    expect(isValidCard(null)).toBe(false);
  });

  it("refuses a record that carries a CVV", () => {
    expect(isValidCard({ ...card(), cvv: "123" })).toBe(false);
    expect(isValidCard({ ...card(), csc: "123" })).toBe(false);
  });
});

describe("saving a sent card", () => {
  const ctx = { private: false, agent: false, enabled: true };

  it("matches the saved card by number", () => {
    expect(compareCapturedCard({ ...emptyCardFields(), number: VISA, nameOnCard: "Ana Example", expMonth: "08", expYear: "2028" }, [card()])).toEqual({ kind: "same", id: "c1" });
    expect(compareCapturedCard({ ...emptyCardFields(), number: VISA }, [card()])).toEqual({ kind: "same", id: "c1" });
    expect(compareCapturedCard({ ...emptyCardFields(), number: VISA, expMonth: "09", expYear: "2030" }, [card()])).toEqual({ kind: "update", id: "c1" });
    expect(compareCapturedCard({ ...emptyCardFields(), number: VISA, nameOnCard: "Ana B Example" }, [card()])).toEqual({ kind: "update", id: "c1" });
    expect(compareCapturedCard({ ...emptyCardFields(), number: MASTERCARD }, [card()])).toEqual({ kind: "new" });
  });

  it("offers only a Luhn-valid card, never in private windows, agent tabs or with the setting off", () => {
    const sent = { ...emptyCardFields(), number: MASTERCARD, expMonth: "01", expYear: "2030" };
    expect(cardSaveDecision(sent, [card()], ctx)).toEqual({ kind: "new" });
    expect(cardSaveDecision({ ...sent, number: "5555555555554445" }, [card()], ctx)).toEqual({ kind: "none" });
    expect(cardSaveDecision(sent, [card()], { ...ctx, private: true })).toEqual({ kind: "none" });
    expect(cardSaveDecision(sent, [card()], { ...ctx, agent: true })).toEqual({ kind: "none" });
    expect(cardSaveDecision(sent, [card()], { ...ctx, enabled: false })).toEqual({ kind: "none" });
    expect(cardSaveDecision({ ...emptyCardFields(), number: VISA }, [card()], ctx)).toEqual({ kind: "none" });
    expect(cardSaveDecision({ ...emptyCardFields(), number: VISA, expMonth: "09", expYear: "2031" }, [card()], ctx)).toEqual({ kind: "update", id: "c1" });
  });

  it("reads a sent form's card fields, the expiry in one field or two", () => {
    expect(capturedCard([{ role: "number", value: "4111 1111 1111 1111" }, { role: "name", value: "Ana Example" }, { role: "exp", value: "08 / 28" }])).toEqual({ number: VISA, nameOnCard: "Ana Example", expMonth: "08", expYear: "2028" });
    expect(capturedCard([{ role: "number", value: VISA }, { role: "expMonth", value: "8" }, { role: "expYear", value: "2028" }])).toEqual({ number: VISA, expMonth: "08", expYear: "2028" });
    expect(capturedCard([{ role: "number", value: VISA }, { role: "exp", value: "0828" }])).toMatchObject({ expMonth: "08", expYear: "2028" });
    expect(capturedCard([{ role: "number", value: VISA }, { role: "exp", value: "08/2028" }])).toMatchObject({ expMonth: "08", expYear: "2028" });
  });

  it("parses what a tab reports, leaving out any CVV-like role", () => {
    expect(parseCardCapture({ origin: "https://shop.example", fields: [{ role: "number", value: VISA }, { role: "csc", value: "123" }, { role: "cvv", value: "123" }] })).toEqual({ origin: "https://shop.example", fields: [{ role: "number", value: VISA }] });
    expect(parseCardCapture({ origin: "", fields: [] })).toBeNull();
    expect(parseCardCapture({ origin: "https://shop.example", fields: "x" })).toBeNull();
  });
});

describe("management", () => {
  it("parses what the page sends to save a card", () => {
    expect(parseCardSave({ fields: { number: VISA, nameOnCard: "Ana", expMonth: "8", expYear: "2028", cvv: "123" } })).toEqual({ fields: { label: "", number: VISA, nameOnCard: "Ana", expMonth: "08", expYear: "2028" } });
    expect(parseCardSave({ id: "c1", fields: { number: "" } })).toEqual({ id: "c1", fields: emptyCardFields() });
    expect(parseCardSave({ id: 3, fields: {} })).toBeNull();
    expect(parseCardSave({ fields: null })).toBeNull();
  });

  it("searches by label, name, brand and last digits", () => {
    const list = [card(), card({ id: "c2", number: MASTERCARD, nameOnCard: "Bob", label: "Trabajo" })].map(cardSummary);
    expect(searchCards(list, "visa").map((c) => c.id)).toEqual(["c1"]);
    expect(searchCards(list, "4444").map((c) => c.id)).toEqual(["c2"]);
    expect(searchCards(list, "trabajo").map((c) => c.id)).toEqual(["c2"]);
    expect(searchCards(list, "").map((c) => c.id)).toEqual(["c1", "c2"]);
  });
});
