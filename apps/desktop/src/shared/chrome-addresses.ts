/**
 * Saved addresses from a Chromium profile's `Web Data` SQLite file. Pure: takes an open database.
 * Schema verified against Chrome `Web Data` version 158: `addresses` (guid, record_type, ...) plus
 * `address_type_tokens` (guid, type, value). Older profiles use `local_addresses` +
 * `local_addresses_type_tokens`, and before that `autofill_profiles` with its names/emails/phones tables.
 */
import { type AddressFields, cleanAddressFields } from "./addresses";

/** The part of `node:sqlite` DatabaseSync the reader uses. */
export interface SqliteLike {
  prepare(sql: string): { all(...params: unknown[]): unknown[] };
}

/** Chromium FieldType numbers (components/autofill/core/browser/field_types.h). */
const FIELD = {
  NAME_FIRST: 3,
  NAME_LAST: 5,
  NAME_FULL: 7,
  EMAIL_ADDRESS: 9,
  PHONE_HOME_WHOLE_NUMBER: 14,
  ADDRESS_HOME_LINE1: 30,
  ADDRESS_HOME_LINE2: 31,
  ADDRESS_HOME_CITY: 33,
  ADDRESS_HOME_STATE: 34,
  ADDRESS_HOME_ZIP: 35,
  ADDRESS_HOME_COUNTRY: 36,
  COMPANY_NAME: 60,
  ADDRESS_HOME_STREET_ADDRESS: 77,
} as const;

type Row = Record<string, unknown>;

const text = (v: unknown): string => (typeof v === "string" ? v : "");

function tableNames(db: SqliteLike): Set<string> {
  const rows = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Row[];
  return new Set(rows.map((r) => text(r.name)));
}

function hasContent(f: AddressFields): boolean {
  return [f.name, f.street, f.postalCode, f.phone, f.email].some((v) => v !== "");
}

function fromTokens(db: SqliteLike, addresses: string, tokenTable: string): AddressFields[] {
  const guids = (db.prepare(`SELECT guid FROM ${addresses} ORDER BY rowid`).all() as Row[]).map((r) => text(r.guid));
  const byGuid = new Map<string, Map<number, string>>(guids.map((g) => [g, new Map()]));
  for (const r of db.prepare(`SELECT guid, type, value FROM ${tokenTable}`).all() as Row[]) {
    byGuid.get(text(r.guid))?.set(Number(r.type), text(r.value));
  }
  return [...byGuid.values()].map((t) => {
    const get = (type: number): string => t.get(type) ?? "";
    const street = get(FIELD.ADDRESS_HOME_STREET_ADDRESS) || [get(FIELD.ADDRESS_HOME_LINE1), get(FIELD.ADDRESS_HOME_LINE2)].filter(Boolean).join("\n");
    return cleanAddressFields({
      name: get(FIELD.NAME_FULL),
      givenName: get(FIELD.NAME_FIRST),
      familyName: get(FIELD.NAME_LAST),
      company: get(FIELD.COMPANY_NAME),
      street,
      postalCode: get(FIELD.ADDRESS_HOME_ZIP),
      city: get(FIELD.ADDRESS_HOME_CITY),
      region: get(FIELD.ADDRESS_HOME_STATE),
      country: get(FIELD.ADDRESS_HOME_COUNTRY),
      phone: get(FIELD.PHONE_HOME_WHOLE_NUMBER),
      email: get(FIELD.EMAIL_ADDRESS),
    });
  });
}

/** First value per guid of a legacy side table (Chrome kept several, the first is the primary one). */
function firstByGuid(db: SqliteLike, tables: Set<string>, table: string): Map<string, Row> {
  const out = new Map<string, Row>();
  if (!tables.has(table)) return out;
  for (const r of db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all() as Row[]) {
    const guid = text(r.guid);
    if (!out.has(guid)) out.set(guid, r);
  }
  return out;
}

function fromLegacy(db: SqliteLike, tables: Set<string>): AddressFields[] {
  const names = firstByGuid(db, tables, "autofill_profile_names");
  const emails = firstByGuid(db, tables, "autofill_profile_emails");
  const phones = firstByGuid(db, tables, "autofill_profile_phones");
  return (db.prepare("SELECT * FROM autofill_profiles ORDER BY rowid").all() as Row[]).map((p) => {
    const guid = text(p.guid);
    const n = names.get(guid) ?? {};
    return cleanAddressFields({
      name: text(n.full_name),
      givenName: text(n.first_name),
      familyName: text(n.last_name),
      company: text(p.company_name),
      street: text(p.street_address),
      postalCode: text(p.zipcode),
      city: text(p.city),
      region: text(p.state),
      country: text(p.country_code),
      phone: text(phones.get(guid)?.number),
      email: text(emails.get(guid)?.email),
    });
  });
}

/**
 * Every saved address of the profile, newest schema first. Local and Google account addresses both
 * import (`record_type` is not filtered: no value in it marks a server-only record).
 */
export function readChromiumAddresses(db: SqliteLike): AddressFields[] {
  const tables = tableNames(db);
  let all: AddressFields[] = [];
  if (tables.has("addresses") && tables.has("address_type_tokens")) all = fromTokens(db, "addresses", "address_type_tokens");
  else if (tables.has("local_addresses") && tables.has("local_addresses_type_tokens")) all = fromTokens(db, "local_addresses", "local_addresses_type_tokens");
  else if (tables.has("autofill_profiles")) all = fromLegacy(db, tables);
  return all.filter(hasContent);
}

export function countChromiumAddresses(db: SqliteLike): number {
  return readChromiumAddresses(db).length;
}
