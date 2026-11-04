/**
 * Saved addresses (name, contact and postal address) that autofill fills into a page's address form.
 * Pure helpers: validation, cleaning, matching a submitted form against what is saved, and the
 * decision to offer saving it. Unit tested; the store seals the records at rest.
 */
import { ADDRESS_ROLES, type AddressRole } from "./address-fields";

export interface AutofillAddress {
  id: string;
  /** Optional name the person gives it ("Home", "Workshop"). */
  label: string;
  /** Full name. */
  name: string;
  givenName: string;
  familyName: string;
  company: string;
  /** Street address, lines separated by "\n". */
  street: string;
  postalCode: string;
  city: string;
  /** Province, state or region. */
  region: string;
  /** ISO 3166-1 alpha-2 code (uppercase), or "". */
  country: string;
  phone: string;
  email: string;
  createdAt: number;
  updatedAt: number;
  lastUsedAt: number;
  useCount: number;
}

export type AddressFields = Omit<AutofillAddress, "id" | "createdAt" | "updatedAt" | "lastUsedAt" | "useCount">;

export const ADDRESS_FIELD_KEYS = ["label", "name", "givenName", "familyName", "company", "street", "postalCode", "city", "region", "country", "phone", "email"] as const satisfies readonly (keyof AddressFields)[];

const NUMBER_KEYS = ["createdAt", "updatedAt", "lastUsedAt", "useCount"] as const;
/** Fields of which one at least must hold something for a record to be worth keeping. */
const CONTENT_KEYS = ["name", "street", "postalCode", "phone", "email"] as const;
export const MAX_ADDRESS_FIELD = 500;

export function emptyAddressFields(): AddressFields {
  return { label: "", name: "", givenName: "", familyName: "", company: "", street: "", postalCode: "", city: "", region: "", country: "", phone: "", email: "" };
}

export function isValidAddress(v: unknown): v is AutofillAddress {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  if (typeof r.id !== "string" || !r.id) return false;
  if (!ADDRESS_FIELD_KEYS.every((k) => typeof r[k] === "string" && (r[k] as string).length <= MAX_ADDRESS_FIELD)) return false;
  if (!NUMBER_KEYS.every((k) => typeof r[k] === "number" && Number.isFinite(r[k]))) return false;
  return CONTENT_KEYS.some((k) => (r[k] as string).trim() !== "");
}

const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim();

/** What a form, the import or the management page gave, made tidy: strings only, trimmed, capped. */
export function cleanAddressFields(raw: Partial<Record<keyof AddressFields, unknown>>): AddressFields {
  const out = emptyAddressFields();
  for (const k of ADDRESS_FIELD_KEYS) {
    const v = raw[k];
    if (typeof v !== "string") continue;
    const clean = k === "street" ? v.split(/\r?\n/).map(oneLine).filter(Boolean).join("\n") : oneLine(v);
    out[k] = clean.slice(0, MAX_ADDRESS_FIELD);
  }
  if (/^[a-z]{2}$/i.test(out.country)) out.country = out.country.toUpperCase();
  if (!out.name && (out.givenName || out.familyName)) out.name = oneLine(`${out.givenName} ${out.familyName}`);
  return out;
}

/** Lowercase, without accents, letters and digits only. */
function fold(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** The place an address names (street and postal code), for telling the same place from another. */
export function addressKey(a: Pick<AddressFields, "street" | "postalCode">): string {
  const street = fold(a.street);
  const postal = fold(a.postalCode);
  return street || postal ? `${street}|${postal}` : "";
}

const same = (a: string, b: string): boolean => fold(a) === fold(b);

/** Two full names of the same person: the same once folded, or one of them missing. */
const samePerson = (a: string, b: string): boolean => !fold(a) || !fold(b) || same(a, b);

/**
 * A submitted form against the saved addresses: the same one (every value it holds is already saved),
 * the same place and person with something new (offer an update), or a new address. Another person's
 * name at the same place is a new address, never an update of the saved one.
 */
export function compareCaptured(captured: AddressFields, saved: readonly AutofillAddress[]): { kind: "same"; id: string } | { kind: "update"; id: string } | { kind: "new" } {
  const c = cleanAddressFields(captured);
  const filled = ADDRESS_FIELD_KEYS.filter((k) => k !== "label" && c[k] !== "");
  const exact = saved.find((s) => filled.every((k) => same(c[k], s[k]) || (k === "street" && same(c.street.replace(/\n/g, " "), s.street.replace(/\n/g, " ")))));
  if (exact) return { kind: "same", id: exact.id };
  const key = addressKey(c);
  const place = key ? saved.find((s) => addressKey(s) === key && samePerson(c.name, s.name)) : undefined;
  return place ? { kind: "update", id: place.id } : { kind: "new" };
}

export function splitName(full: string): { given: string; family: string } {
  const words = oneLine(full).split(" ").filter(Boolean);
  return { given: words[0] ?? "", family: words.slice(1).join(" ") };
}

/** How a list names an address: its label or name, then the first street line and the city. */
export function addressLine(a: AddressFields): string {
  const title = a.label || a.name || a.company || a.email || a.phone;
  const where = [a.street.split("\n")[0] ?? "", a.city].filter(Boolean).join(", ");
  return [title, where].filter(Boolean).join(" - ");
}

/** A submitted form holds enough of an address to be worth offering to save. */
export function isWorthSaving(f: AddressFields): boolean {
  return f.name.trim() !== "" && (f.street.trim() !== "" || (f.postalCode.trim() !== "" && f.city.trim() !== ""));
}

/** Whether to offer saving a submitted address: never in private windows, agent tabs or with the setting off. */
export function addressSaveDecision(
  captured: AddressFields,
  saved: readonly AutofillAddress[],
  ctx: { private: boolean; agent: boolean; enabled: boolean },
): { kind: "none" } | { kind: "update"; id: string } | { kind: "new" } {
  if (ctx.private || ctx.agent || !ctx.enabled) return { kind: "none" };
  const c = cleanAddressFields(captured);
  if (!isWorthSaving(c)) return { kind: "none" };
  const found = compareCaptured(c, saved);
  return found.kind === "same" ? { kind: "none" } : found;
}

/** The addresses whose fields hold every word of the query (accents and case ignored). */
export function searchAddresses(list: readonly AutofillAddress[], query: string): AutofillAddress[] {
  const words = query.split(/\s+/).map(fold).filter(Boolean);
  if (!words.length) return [...list];
  return list.filter((a) => {
    const text = ADDRESS_FIELD_KEYS.map((k) => fold(a[k])).join(" ");
    return words.every((w) => text.includes(w));
  });
}

/** What the management page sends to save an address: cleaned fields, and the id when it edits one. Null when malformed. */
export function parseAddressSave(raw: unknown): { id?: string; fields: AddressFields } | null {
  if (typeof raw !== "object" || raw === null) return null;
  const { id, fields } = raw as { id?: unknown; fields?: unknown };
  if (id !== undefined && id !== null && (typeof id !== "string" || !id || id.length > 128)) return null;
  if (typeof fields !== "object" || fields === null || Array.isArray(fields)) return null;
  const clean = cleanAddressFields(fields as Partial<Record<keyof AddressFields, unknown>>);
  return typeof id === "string" ? { id, fields: clean } : { fields: clean };
}

/**
 * What a sent address form holds, as address fields: its street lines joined one per line, and the
 * name made of its parts when the form had no full-name field. Empty values are left out.
 */
let countryNames: Map<string, string> | null = null;

/**
 * A country as a form gave it (a select's option text such as "España" or "France", or a code) as its
 * ISO 3166-1 alpha-2 code, as saved addresses keep it; a name it does not know stays as it is.
 */
export function countryCode(value: string): string {
  const v = oneLine(value);
  if (/^[a-z]{2}$/i.test(v)) return v.toUpperCase();
  if (!countryNames) {
    countryNames = new Map();
    for (const lang of ["es", "en"]) {
      let names: Intl.DisplayNames;
      try {
        names = new Intl.DisplayNames([lang], { type: "region", fallback: "none" });
      } catch {
        continue;
      }
      for (let a = 65; a <= 90; a++) {
        for (let b = 65; b <= 90; b++) {
          const code = String.fromCharCode(a, b);
          const name = names.of(code);
          if (name && !countryNames.has(fold(name))) countryNames.set(fold(name), code);
        }
      }
    }
  }
  return countryNames.get(fold(v)) ?? v;
}

export function capturedAddress(entries: readonly { role: AddressRole; value: string }[]): Partial<AddressFields> {
  const out: Partial<AddressFields> = {};
  const lines: string[] = [];
  for (const { role, value } of entries) {
    const v = value.trim();
    if (!v) continue;
    if (role === "street" || role === "line1") lines.unshift(v);
    else if (role === "line2") lines.push(v);
    else if (role === "country") out.country ??= countryCode(v);
    else out[role] ??= v;
  }
  if (lines.length) out.street = lines.join("\n");
  if (!out.name && (out.givenName || out.familyName)) out.name = [out.givenName, out.familyName].filter(Boolean).join(" ");
  return out;
}

/** A sent address form as a tab reports it: known roles with text values (an oversized value is left out). Null when malformed. */
export function parseAddressCapture(raw: unknown): { origin: string; fields: { role: AddressRole; value: string }[] } | null {
  if (typeof raw !== "object" || raw === null) return null;
  const { origin, fields } = raw as { origin?: unknown; fields?: unknown };
  if (typeof origin !== "string" || !origin || origin.length > 4096 || !Array.isArray(fields) || fields.length > 200) return null;
  const roles: readonly string[] = ADDRESS_ROLES;
  const out: { role: AddressRole; value: string }[] = [];
  for (const f of fields as unknown[]) {
    const { role, value } = (typeof f === "object" && f !== null ? f : {}) as { role?: unknown; value?: unknown };
    if (typeof role === "string" && roles.includes(role) && typeof value === "string" && value.length <= MAX_ADDRESS_FIELD) out.push({ role: role as AddressRole, value });
  }
  return { origin, fields: out };
}
