import { describe, expect, it } from "vitest";
import {
  addressKey,
  addressLine,
  addressSaveDecision,
  cleanAddressFields,
  compareCaptured,
  emptyAddressFields,
  isValidAddress,
  isWorthSaving,
  parseAddressSave,
  searchAddresses,
  capturedAddress,
  countryCode,
  parseAddressCapture,
  splitName,
  type AddressFields,
  type AutofillAddress,
} from "../src/shared/addresses";

function fields(partial: Partial<AddressFields>): AddressFields {
  return { ...emptyAddressFields(), ...partial };
}

function saved(id: string, partial: Partial<AddressFields>): AutofillAddress {
  return { ...fields(partial), id, createdAt: 1, updatedAt: 1, lastUsedAt: 0, useCount: 0 };
}

const home = { name: "Ana Ejemplo", street: "Calle Mayor 1", postalCode: "28001", city: "Madrid", region: "Madrid", country: "ES", phone: "600000000", email: "ana@example.com" };

describe("isValidAddress", () => {
  it("accepts a complete record", () => {
    expect(isValidAddress(saved("a", home))).toBe(true);
  });
  it("rejects a record with a missing key or a wrong type", () => {
    const { phone: _phone, ...missing } = saved("a", home);
    expect(isValidAddress(missing)).toBe(false);
    expect(isValidAddress({ ...saved("a", home), city: 5 })).toBe(false);
    expect(isValidAddress(null)).toBe(false);
  });
  it("rejects an empty record and over-long values", () => {
    expect(isValidAddress(saved("a", {}))).toBe(false);
    expect(isValidAddress(saved("a", { ...home, street: "x".repeat(501) }))).toBe(false);
  });
});

describe("cleanAddressFields", () => {
  it("trims, collapses spaces, uppercases the country and drops non-strings", () => {
    const f = cleanAddressFields({ street: "  Calle  Mayor 1 ", country: "es", phone: 600 as unknown as string });
    expect(f.street).toBe("Calle Mayor 1");
    expect(f.country).toBe("ES");
    expect(f.phone).toBe("");
  });
  it("keeps street lines but cleans each one", () => {
    expect(cleanAddressFields({ street: " Calle Mayor 1 \n  2º B " }).street).toBe("Calle Mayor 1\n2º B");
  });
  it("fills the full name from the given and family names", () => {
    expect(cleanAddressFields({ givenName: "Ana", familyName: "Ejemplo" }).name).toBe("Ana Ejemplo");
  });
});

describe("addressKey", () => {
  it("ignores case, accents, punctuation and spaces", () => {
    expect(addressKey({ street: "Calle Mayor, 1", postalCode: "28001" })).toBe(addressKey({ street: "calle mayor 1", postalCode: "28 001" }));
    expect(addressKey({ street: "Rúa do Paxaro", postalCode: "" })).toBe(addressKey({ street: "Rua do paxaro", postalCode: "" }));
  });
  it("is empty without street and postal code", () => {
    expect(addressKey({ street: "", postalCode: "" })).toBe("");
  });
});

describe("compareCaptured", () => {
  const list = [saved("h", home)];
  it("finds the same address", () => {
    expect(compareCaptured(fields({ name: "Ana Ejemplo", street: "Calle Mayor 1", postalCode: "28001", city: "Madrid" }), list)).toEqual({ kind: "same", id: "h" });
  });
  it("offers an update when the place matches but a value changed", () => {
    expect(compareCaptured(fields({ ...home, phone: "699999999" }), list)).toEqual({ kind: "update", id: "h" });
  });
  it("is new otherwise", () => {
    expect(compareCaptured(fields({ ...home, street: "Avenida Buenos Aires 5", postalCode: "28002" }), list)).toEqual({ kind: "new" });
  });
  it("takes another person's name at the same place for a new address, a missing name for the same person", () => {
    expect(compareCaptured(fields({ ...home, name: "Eva Prueba", phone: "611111111" }), list)).toEqual({ kind: "new" });
    expect(compareCaptured(fields({ ...home, name: "ANA  ejemplo", phone: "699999999" }), list)).toEqual({ kind: "update", id: "h" });
    expect(compareCaptured(fields({ ...home, name: "", phone: "699999999" }), list)).toEqual({ kind: "update", id: "h" });
    expect(compareCaptured(fields({ ...home, phone: "699999999" }), [saved("n", { ...home, name: "" })])).toEqual({ kind: "update", id: "n" });
  });
});

describe("splitName", () => {
  it("takes the first word as the given name", () => {
    expect(splitName("Ana Ejemplo López")).toEqual({ given: "Ana", family: "Ejemplo López" });
    expect(splitName("Ana")).toEqual({ given: "Ana", family: "" });
  });
});

describe("addressLine", () => {
  it("names the address, its first street line and city", () => {
    expect(addressLine(fields({ ...home, street: "Calle Mayor 1\n2º B" }))).toBe("Ana Ejemplo - Calle Mayor 1, Madrid");
    expect(addressLine(fields({ ...home, label: "Casa" }))).toBe("Casa - Calle Mayor 1, Madrid");
    expect(addressLine(fields({ name: "Ana Ejemplo" }))).toBe("Ana Ejemplo");
  });
});

describe("isWorthSaving", () => {
  it("needs a name and a street, or a name with postal code and city", () => {
    expect(isWorthSaving(fields(home))).toBe(true);
    expect(isWorthSaving(fields({ name: "Ana", postalCode: "28001", city: "Madrid" }))).toBe(true);
    expect(isWorthSaving(fields({ name: "Ana", email: "ana@example.com" }))).toBe(false);
    expect(isWorthSaving(fields({ street: "Calle Mayor 1" }))).toBe(false);
  });
});

describe("addressSaveDecision", () => {
  const ctx = { private: false, agent: false, enabled: true };
  const list = [saved("h", home)];
  it("offers nothing in private windows, agent tabs or with the setting off", () => {
    expect(addressSaveDecision(fields(home), [], { ...ctx, private: true })).toEqual({ kind: "none" });
    expect(addressSaveDecision(fields(home), [], { ...ctx, agent: true })).toEqual({ kind: "none" });
    expect(addressSaveDecision(fields(home), [], { ...ctx, enabled: false })).toEqual({ kind: "none" });
  });
  it("offers nothing for an incomplete or already saved address", () => {
    expect(addressSaveDecision(fields({ name: "Ana" }), [], ctx)).toEqual({ kind: "none" });
    expect(addressSaveDecision(fields(home), list, ctx)).toEqual({ kind: "none" });
  });
  it("offers an update or a new save", () => {
    expect(addressSaveDecision(fields({ ...home, phone: "699999999" }), list, ctx)).toEqual({ kind: "update", id: "h" });
    expect(addressSaveDecision(fields(home), [], ctx)).toEqual({ kind: "new" });
    expect(addressSaveDecision(fields({ ...home, name: "Eva Prueba" }), list, ctx)).toEqual({ kind: "new" });
  });
});

describe("searchAddresses", () => {
  const list = [saved("a", home), saved("b", { label: "Taller", name: "Ana Pérez", street: "Rúa Nova 5", city: "Vigo" })];
  it("matches every word in any field, ignoring accents and case", () => {
    expect(searchAddresses(list, "").map((a) => a.id)).toEqual(["a", "b"]);
    expect(searchAddresses(list, "perez VIGO").map((a) => a.id)).toEqual(["b"]);
    expect(searchAddresses(list, "28001").map((a) => a.id)).toEqual(["a"]);
    expect(searchAddresses(list, "taller madrid")).toEqual([]);
  });
});

describe("parseAddressSave", () => {
  it("cleans the fields and keeps the id when it edits one", () => {
    expect(parseAddressSave({ fields: { name: "  Ana  ", country: "es", street: "a\n\n b ", extra: 1 } })).toEqual({ fields: fields({ name: "Ana", country: "ES", street: "a\nb" }) });
    expect(parseAddressSave({ id: "x1", fields: { phone: 600, email: "ana@example.com" } })).toEqual({ id: "x1", fields: fields({ email: "ana@example.com" }) });
    expect(parseAddressSave({ id: null, fields: {} })).toEqual({ fields: emptyAddressFields() });
  });
  it("rejects anything malformed", () => {
    for (const raw of [null, "x", 3, {}, { fields: null }, { fields: [] }, { fields: "x" }, { id: 5, fields: {} }, { id: "", fields: {} }, { id: "a".repeat(129), fields: {} }]) {
      expect(parseAddressSave(raw)).toBeNull();
    }
  });
});

describe("capturedAddress", () => {
  it("joins the street lines and the name parts of a sent form", () => {
    const f = capturedAddress([
      { role: "givenName", value: " Ana " },
      { role: "familyName", value: "García López" },
      { role: "line1", value: "Calle Mayor 1" },
      { role: "line2", value: "2º B" },
      { role: "postalCode", value: "28013" },
      { role: "city", value: "Madrid" },
      { role: "country", value: "España" },
      { role: "phone", value: "600000000" },
    ]);
    expect(f).toEqual({ givenName: "Ana", familyName: "García López", name: "Ana García López", street: "Calle Mayor 1\n2º B", postalCode: "28013", city: "Madrid", country: "ES", phone: "600000000" });
  });

  it("keeps a full name field over the parts and ignores empty values", () => {
    const f = capturedAddress([
      { role: "name", value: "Ana García" },
      { role: "givenName", value: "Ana" },
      { role: "street", value: "Calle Mayor 1" },
      { role: "email", value: "" },
    ]);
    expect(f).toEqual({ name: "Ana García", givenName: "Ana", street: "Calle Mayor 1" });
  });
});

describe("countryCode", () => {
  it("turns a select's country name (Spanish or English, any case or accents) or a code into the ISO code", () => {
    expect(countryCode("España")).toBe("ES");
    expect(countryCode("espana")).toBe("ES");
    expect(countryCode("Francia")).toBe("FR");
    expect(countryCode("France")).toBe("FR");
    expect(countryCode("pt")).toBe("PT");
    expect(countryCode("Atlantis")).toBe("Atlantis");
  });

  it("makes a sent form with the country chosen in a select the same as the saved address it was filled from", () => {
    const saved: AutofillAddress = { ...fields({ name: "Ana Prueba", street: "Calle Falsa 1", postalCode: "28999", country: "ES" }), id: "a1", createdAt: 1, updatedAt: 1, lastUsedAt: 0, useCount: 0 };
    const sent = cleanAddressFields(capturedAddress([{ role: "name", value: "Ana Prueba" }, { role: "street", value: "Calle Falsa 1" }, { role: "postalCode", value: "28999" }, { role: "country", value: "España" }]));
    expect(compareCaptured(sent, [saved])).toEqual({ kind: "same", id: "a1" });
  });
});

describe("parseAddressCapture", () => {
  it("keeps known roles with text values", () => {
    expect(parseAddressCapture({ origin: "https://shop.example", fields: [{ role: "city", value: "Madrid" }, { role: "cc-number", value: "4111" }, { role: "phone", value: 5 }] })).toEqual({
      origin: "https://shop.example",
      fields: [{ role: "city", value: "Madrid" }],
    });
  });

  it("rejects malformed or oversized captures", () => {
    expect(parseAddressCapture(null)).toBeNull();
    expect(parseAddressCapture({ origin: 1, fields: [] })).toBeNull();
    expect(parseAddressCapture({ origin: "https://a.example", fields: "x" })).toBeNull();
    expect(parseAddressCapture({ origin: "https://a.example", fields: Array.from({ length: 201 }, () => ({ role: "city", value: "x" })) })).toBeNull();
    expect(parseAddressCapture({ origin: "https://a.example", fields: [{ role: "city", value: "x".repeat(501) }] })?.fields).toEqual([]);
  });
});
