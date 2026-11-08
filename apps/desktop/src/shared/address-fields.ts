/**
 * Address form detection and fill values: which saved-address value each field of a page form takes.
 * Everything lives inside addressKit; the tab preload calls its functions for the click, the fill and
 * the save prompt alike.
 */
import type { AddressFields } from "./addresses";

export const ADDRESS_ROLES = ["name", "givenName", "familyName", "company", "street", "line1", "line2", "postalCode", "city", "region", "country", "phone", "email"] as const;
export type AddressRole = (typeof ADDRESS_ROLES)[number];

/** What the page script reads from a form field to classify it. */
export interface AddressFieldFacts {
  tag: "INPUT" | "SELECT" | "TEXTAREA";
  type: string;
  autocomplete: string;
  name: string;
  id: string;
  label: string;
  placeholder: string;
}

interface DomText {
  readonly textContent: string | null;
}

/** The parts of a form field the facts are read from (the preload is type-checked without the DOM library). */
export interface AddressInputElement {
  readonly tagName: string;
  readonly name: string;
  readonly id: string;
  readonly labels: ArrayLike<DomText> | null;
  readonly ownerDocument: { getElementById(id: string): DomText | null };
  getAttribute(name: string): string | null;
}

/** A field of the form being filled: its facts, what it holds now, and whether it is the one clicked. */
export interface AddressFillField {
  facts: AddressFieldFacts;
  value: string;
  anchor: boolean;
}

export interface AddressKit {
  foldText(s: string): string;
  addressFieldFacts(el: AddressInputElement): AddressFieldFacts;
  classifyAddressField(f: AddressFieldFacts): AddressRole | null;
  isAddressForm(roles: readonly (AddressRole | null)[]): boolean;
  valuesForRoles(roles: readonly (AddressRole | null)[], a: AddressFields): (string | null)[];
  planAddressFill(fields: readonly AddressFillField[], a: AddressFields): (string | null)[];
  matchOption(options: readonly { value: string; text: string }[], wanted: string): string | null;
}

export function addressKit(): AddressKit {
  /** Lowercase, accents removed, trimmed. */
  const foldText = (s: string): string =>
    s
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .trim();

  /** Reads a field's facts from the page: its labels (label elements and aria-labelledby) and aria-label count as its label. */
  const addressFieldFacts = (el: AddressInputElement): AddressFieldFacts => {
    const attr = (name: string): string => el.getAttribute(name) || "";
    const textOf = (node: DomText | null): string => (node?.textContent || "").replace(/\s+/g, " ").trim();
    const labels: string[] = [];
    for (let i = 0; el.labels && i < el.labels.length; i++) labels.push(textOf(el.labels[i] ?? null));
    const byIds = attr("aria-labelledby")
      .split(/\s+/)
      .filter(Boolean)
      .map((id) => textOf(el.ownerDocument.getElementById(id)));
    const tag = String(el.tagName).toUpperCase();
    return {
      tag: tag === "SELECT" || tag === "TEXTAREA" ? tag : "INPUT",
      type: (attr("type") || (tag === "INPUT" ? "text" : tag.toLowerCase())).toLowerCase(),
      autocomplete: attr("autocomplete").toLowerCase(),
      name: el.name || "",
      id: el.id || "",
      label: [...labels, ...byIds, attr("aria-label")].join(" ").replace(/\s+/g, " ").trim().slice(0, 200),
      placeholder: attr("placeholder"),
    };
  };

  const classifyAddressField = (f: AddressFieldFacts): AddressRole | null => {
    const skipTypes = ["password", "hidden", "checkbox", "radio", "submit", "button", "file", "search", "image", "reset"];
    if (f.tag === "INPUT" && skipTypes.includes(foldText(f.type))) return null;

    const tokens = foldText(f.autocomplete)
      .split(/\s+/)
      .filter((t) => t && t !== "shipping" && t !== "billing" && !t.startsWith("section-"));
    const token = tokens[tokens.length - 1] ?? "";
    if (token.startsWith("cc-")) return null;
    const byToken: Record<string, AddressRole> = {
      name: "name",
      "given-name": "givenName",
      "family-name": "familyName",
      organization: "company",
      "street-address": "street",
      "address-line1": "line1",
      "address-line2": "line2",
      "address-line3": "line2",
      "postal-code": "postalCode",
      "address-level2": "city",
      "address-level1": "region",
      country: "country",
      "country-name": "country",
      tel: "phone",
      "tel-national": "phone",
      email: "email",
    };
    const fromToken = Object.prototype.hasOwnProperty.call(byToken, token) ? byToken[token] : undefined;
    if (fromToken) return fromToken;

    const words = (s: string): string =>
      foldText(s.replace(/([a-z])([A-Z])/g, "$1 $2"))
        .replace(/[^a-z0-9]+/g, " ")
        .trim();
    const pieces = [f.name, f.id, f.label, f.placeholder].map(words).filter(Boolean);
    const hint = pieces.join(" ");
    if (!hint) return null;
    if (/card|tarjeta|\bcvv|\bcvc|password|contrasena|usuario|\buser|login|search|buscar|coupon|cupon/.test(hint)) return null;

    const rules: [RegExp, AddressRole][] = [
      [/\bzip|postal|\bpost ?code|codigo postal|\bcp\b/, "postalCode"],
      [/\be ?mail|\bcorreo/, "email"],
      [/phone|\btel|\bmovil|\bmobile/, "phone"],
      [/\baddress ?(line )?[23]\b|\bline ?[23]\b|\bpiso\b|\bpuerta\b|\bescalera\b|apartment|\bapt\b/, "line2"],
      [/company|empresa|organi[sz]ation|razon social/, "company"],
      [/\bfirst ?name|\bgiven|\bfname\b|\bnombre\b(?! (de (la )?empresa|de usuario|completo|y apellido))/, "givenName"],
      [/\blast ?name|surname|\bfamily|\bapellido|\blname\b/, "familyName"],
      [/\bfull ?name|nombre completo|nombre y apellido|destinatario/, "name"],
      [/address|street|direccion|\bcalle\b|domicilio/, "street"],
      [/city|\btown\b|ciudad|localidad|poblacion|municipio/, "city"],
      [/\bstate\b|provinc|region|county/, "region"],
      [/country|\bpais\b/, "country"],
    ];
    for (const [re, role] of rules) if (re.test(hint)) return role;
    return pieces.includes("name") ? "name" : null;
  };

  /** Enough distinct address fields, one of them a place (street, postal code or city). */
  const isAddressForm = (roles: readonly (AddressRole | null)[]): boolean => {
    const found = new Set(roles.filter((r): r is AddressRole => r !== null));
    return found.size >= 3 && ["street", "line1", "postalCode", "city"].some((r) => found.has(r as AddressRole));
  };

  /** The value each field takes from a saved address, in the same order as the roles. */
  const valuesForRoles = (roles: readonly (AddressRole | null)[], a: AddressFields): (string | null)[] => {
    const lines = a.street
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    const hasLine2 = roles.includes("line2");
    const words = a.name.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
    return roles.map((role) => {
      switch (role) {
        case null:
          return null;
        case "name":
          return a.name;
        case "givenName":
          return a.givenName || (words[0] ?? "");
        case "familyName":
          return a.familyName || words.slice(1).join(" ");
        case "street":
        case "line1":
          return hasLine2 ? (lines[0] ?? "") : lines.join(", ");
        case "line2":
          return lines.slice(1).join(", ");
        default:
          return a[role];
      }
    });
  };

  /**
   * What each field of a form gets from a saved address: null leaves it alone. Nothing unless the
   * clicked field takes an address value and the form is an address form; a field that already holds
   * something stays as it is (except the one clicked), and so does one the address has nothing for.
   */
  const planAddressFill = (fields: readonly AddressFillField[], a: AddressFields): (string | null)[] => {
    const roles = fields.map((f) => classifyAddressField(f.facts));
    const anchor = fields.findIndex((f) => f.anchor);
    if (anchor < 0 || roles[anchor] === null || !isAddressForm(roles)) return fields.map(() => null);
    const values = valuesForRoles(roles, a);
    return fields.map((f, i) => {
      const v = values[i] ?? null;
      if (v === null || v === "") return null;
      return f.anchor || f.value.trim() === "" ? v : null;
    });
  };

  /** The value of the select option that fits the wanted value, or null. */
  const matchOption = (options: readonly { value: string; text: string }[], wanted: string): string | null => {
    const w = foldText(wanted);
    if (!w) return null;
    const candidates = [w];
    if (/^[a-z]{2}$/.test(w)) {
      for (const lang of ["es", "en"]) {
        try {
          const country = new Intl.DisplayNames([lang], { type: "region" }).of(w.toUpperCase());
          if (country) candidates.push(foldText(country));
        } catch {
          // No region data for this code: compare the code only.
        }
      }
    }
    const folded = options.map((o) => ({ value: o.value, v: foldText(o.value), t: foldText(o.text) }));
    const pick = (test: (o: { v: string; t: string }, c: string) => boolean): string | null => {
      for (const c of candidates) {
        const hit = folded.find((o) => test(o, c));
        if (hit) return hit.value;
      }
      return null;
    };
    return pick((o, c) => o.v === c) ?? pick((o, c) => o.t === c) ?? pick((o, c) => o.t !== "" && o.t.startsWith(c));
  };

  return { foldText, addressFieldFacts, classifyAddressField, isAddressForm, valuesForRoles, planAddressFill, matchOption };
}

export const { foldText, addressFieldFacts, classifyAddressField, isAddressForm, valuesForRoles, planAddressFill, matchOption } = addressKit();
