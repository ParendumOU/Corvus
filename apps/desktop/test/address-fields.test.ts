import { describe, expect, it } from "vitest";
import { addressFieldFacts, classifyAddressField, foldText, isAddressForm, matchOption, planAddressFill, valuesForRoles, type AddressFieldFacts, type AddressFillField, type AddressRole } from "../src/shared/address-fields";
import { emptyAddressFields, type AddressFields } from "../src/shared/addresses";

function facts(partial: Partial<AddressFieldFacts>): AddressFieldFacts {
  return { tag: "INPUT", type: "text", autocomplete: "", name: "", id: "", label: "", placeholder: "", ...partial };
}

function address(partial: Partial<AddressFields>): AddressFields {
  return { ...emptyAddressFields(), ...partial };
}

const SPANISH: AddressRole[] = ["givenName", "familyName", "street", "postalCode", "city", "region", "phone", "email"];

describe("foldText", () => {
  it("lowercases, strips accents and trims", () => {
    expect(foldText("  Código Postal ")).toBe("codigo postal");
    expect(foldText("ESPAÑA")).toBe("espana");
  });
});

describe("classifyAddressField", () => {
  it("reads a Spanish form from name and id hints only", () => {
    const names = ["nombre", "apellidos", "direccion", "cp", "poblacion", "provincia", "telefono", "email"];
    expect(names.map((n) => classifyAddressField(facts({ name: n, id: n })))).toEqual(SPANISH);
  });

  it("uses the last meaningful autocomplete token", () => {
    expect(classifyAddressField(facts({ autocomplete: "shipping street-address" }))).toBe("street");
    expect(classifyAddressField(facts({ autocomplete: "section-a billing postal-code" }))).toBe("postalCode");
    expect(classifyAddressField(facts({ autocomplete: "address-line3" }))).toBe("line2");
    expect(classifyAddressField(facts({ autocomplete: "country-name" }))).toBe("country");
    expect(classifyAddressField(facts({ autocomplete: "tel-national" }))).toBe("phone");
  });

  it("autocomplete wins over the hints", () => {
    expect(classifyAddressField(facts({ autocomplete: "address-level2", name: "provincia" }))).toBe("city");
  });

  it("falls through to hints on off or unknown autocomplete", () => {
    expect(classifyAddressField(facts({ autocomplete: "off", name: "ciudad" }))).toBe("city");
    expect(classifyAddressField(facts({ autocomplete: "nope", label: "Zip code" }))).toBe("postalCode");
  });

  it("never treats card fields as address fields", () => {
    expect(classifyAddressField(facts({ autocomplete: "cc-number" }))).toBeNull();
    expect(classifyAddressField(facts({ autocomplete: "cc-name", name: "nombre" }))).toBeNull();
    expect(classifyAddressField(facts({ label: "Nombre del titular de la tarjeta" }))).toBeNull();
    expect(classifyAddressField(facts({ name: "cvv" }))).toBeNull();
  });

  it("does not take a user name as a given name", () => {
    expect(classifyAddressField(facts({ label: "Nombre de usuario" }))).not.toBe("givenName");
    expect(classifyAddressField(facts({ label: "Nombre de la empresa" }))).toBe("company");
  });

  it("ignores inputs that cannot hold an address value", () => {
    for (const type of ["password", "hidden", "checkbox", "radio", "submit", "button", "file", "search", "image", "reset"]) {
      expect(classifyAddressField(facts({ type, name: "direccion", autocomplete: "street-address" }))).toBeNull();
    }
  });

  it("keeps hints word aware", () => {
    expect(classifyAddressField(facts({ label: "Hotel" }))).not.toBe("phone");
    expect(classifyAddressField(facts({ name: "acceptance" }))).not.toBe("postalCode");
    expect(classifyAddressField(facts({ name: "tel" }))).toBe("phone");
    expect(classifyAddressField(facts({ label: "CP" }))).toBe("postalCode");
  });

  it("reads English hints", () => {
    expect(classifyAddressField(facts({ label: "First name" }))).toBe("givenName");
    expect(classifyAddressField(facts({ label: "Last name" }))).toBe("familyName");
    expect(classifyAddressField(facts({ label: "Full name" }))).toBe("name");
    expect(classifyAddressField(facts({ name: "name" }))).toBe("name");
    expect(classifyAddressField(facts({ label: "Address line 2" }))).toBe("line2");
    expect(classifyAddressField(facts({ label: "Street address" }))).toBe("street");
    expect(classifyAddressField(facts({ label: "State / Province" }))).toBe("region");
    expect(classifyAddressField(facts({ tag: "SELECT", type: "select-one", label: "Country" }))).toBe("country");
    expect(classifyAddressField(facts({ placeholder: "E-mail" }))).toBe("email");
  });

  it("reads more Spanish hints", () => {
    expect(classifyAddressField(facts({ label: "Piso / puerta" }))).toBe("line2");
    expect(classifyAddressField(facts({ label: "Dirección" }))).toBe("street");
    expect(classifyAddressField(facts({ label: "Código postal" }))).toBe("postalCode");
    expect(classifyAddressField(facts({ label: "País" }))).toBe("country");
    expect(classifyAddressField(facts({ label: "Móvil" }))).toBe("phone");
    expect(classifyAddressField(facts({ label: "Correo electrónico" }))).toBe("email");
    expect(classifyAddressField(facts({ label: "Nombre completo" }))).toBe("name");
    expect(classifyAddressField(facts({ label: "Razón social" }))).toBe("company");
  });

  it("ignores login, search and coupon fields", () => {
    expect(classifyAddressField(facts({ name: "login" }))).toBeNull();
    expect(classifyAddressField(facts({ placeholder: "Buscar" }))).toBeNull();
    expect(classifyAddressField(facts({ label: "Código de cupón" }))).toBeNull();
    expect(classifyAddressField(facts({ name: "user_email" }))).toBeNull();
  });
});

describe("isAddressForm", () => {
  it("needs three roles and a place", () => {
    expect(isAddressForm(["email", "phone"])).toBe(false);
    expect(isAddressForm(["email", "phone", "name"])).toBe(false);
    expect(isAddressForm(["email", "phone", "email", "city"])).toBe(true);
    expect(isAddressForm([null, "name", null, "postalCode", "phone"])).toBe(true);
    expect(isAddressForm(SPANISH)).toBe(true);
  });
});

describe("valuesForRoles", () => {
  const a = address({ name: "Ana Pérez López", street: "Calle Mayor 1\n2º B\nEscalera 3", postalCode: "28001", city: "Madrid", region: "Madrid", country: "ES", phone: "600000000", email: "ana@example.com", company: "Taller" });

  it("joins the street lines when the form has no line2", () => {
    expect(valuesForRoles(["street", "postalCode", null], a)).toEqual(["Calle Mayor 1, 2º B, Escalera 3", "28001", null]);
  });

  it("splits the street when the form has a line2", () => {
    expect(valuesForRoles(["line1", "line2"], a)).toEqual(["Calle Mayor 1", "2º B, Escalera 3"]);
    expect(valuesForRoles(["street", "line2"], a)).toEqual(["Calle Mayor 1", "2º B, Escalera 3"]);
  });

  it("splits a full name when given and family are missing", () => {
    expect(valuesForRoles(["givenName", "familyName", "name"], a)).toEqual(["Ana", "Pérez López", "Ana Pérez López"]);
    expect(valuesForRoles(["givenName", "familyName"], address({ name: "Ana Pérez", givenName: "Anabel", familyName: "Pérez Gil" }))).toEqual(["Anabel", "Pérez Gil"]);
  });

  it("copies the other values as stored", () => {
    expect(valuesForRoles(["company", "city", "region", "country", "phone", "email"], a)).toEqual(["Taller", "Madrid", "Madrid", "ES", "600000000", "ana@example.com"]);
  });
});

describe("matchOption", () => {
  it("matches by value, then text, accent and case insensitive", () => {
    expect(matchOption([{ value: "GA", text: "GALICIA" }], "Galicia")).toBe("GA");
    expect(matchOption([{ value: "es", text: "España" }], "ES")).toBe("es");
    expect(matchOption([{ value: "1", text: "Espana" }], "España")).toBe("1");
  });

  it("falls back to a text that starts with the wanted value", () => {
    expect(matchOption([{ value: "", text: "Elige" }, { value: "32", text: "Ourense (Orense)" }], "Ourense")).toBe("32");
  });

  it("matches a country code against the country name", () => {
    expect(matchOption([{ value: "", text: "-" }, { value: "724", text: "España" }], "ES")).toBe("724");
    expect(matchOption([{ value: "x", text: "France" }, { value: "y", text: "Portugal" }], "PT")).toBe("y");
  });

  it("returns null when nothing fits or nothing is wanted", () => {
    expect(matchOption([{ value: "a", text: "A" }], "")).toBeNull();
    expect(matchOption([{ value: "a", text: "A" }], "Zamora")).toBeNull();
  });
});

describe("planAddressFill", () => {
  const home = address({ name: "Ana Ejemplo", street: "Calle Mayor 1\n2º B", postalCode: "28001", city: "Madrid", region: "Madrid", country: "ES", phone: "600000000", email: "ana@example.com" });
  const field = (name: string, value = "", anchor = false): AddressFillField => ({ facts: facts({ name, id: name }), value, anchor });

  it("fills a Spanish form from the clicked field", () => {
    const form = [field("nombre", "", true), field("apellidos"), field("direccion"), field("cp"), field("poblacion"), field("telefono"), field("email")];
    expect(planAddressFill(form, home)).toEqual(["Ana", "Ejemplo", "Calle Mayor 1, 2º B", "28001", "Madrid", "600000000", "ana@example.com"]);
  });

  it("leaves fields that already hold something, except the one clicked", () => {
    const form = [field("nombre", "N", true), field("direccion", "Otra calle"), field("cp"), field("poblacion")];
    expect(planAddressFill(form, home)).toEqual(["Ana", null, "28001", "Madrid"]);
  });

  it("fills nothing outside an address form or from a field that is not an address field", () => {
    expect(planAddressFill([field("email", "", true), field("password")], home)).toEqual([null, null]);
    expect(planAddressFill([field("coupon", "", true), field("direccion"), field("cp"), field("poblacion")], home)).toEqual([null, null, null, null]);
  });
});

describe("addressFieldFacts", () => {
  it("reads labels, aria-labelledby and aria-label", () => {
    const el = {
      tagName: "select",
      name: "pais",
      id: "c",
      labels: [{ textContent: " País\n de envío " }],
      ownerDocument: { getElementById: (id: string) => (id === "h" ? { textContent: "Destino" } : null) },
      getAttribute: (n: string) => ({ "aria-labelledby": "h", "aria-label": "Country" })[n] ?? null,
    };
    expect(addressFieldFacts(el)).toEqual({ tag: "SELECT", type: "select", autocomplete: "", name: "pais", id: "c", label: "País de envío Destino Country", placeholder: "" });
  });
});
