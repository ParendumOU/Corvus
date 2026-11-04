import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { emptyAddressFields } from "../src/shared/addresses";
import { countChromiumAddresses, readChromiumAddresses } from "../src/shared/chrome-addresses";

function tokens(db: DatabaseSync, table: string, guid: string, values: Record<number, string>): void {
  const insert = db.prepare(`INSERT INTO ${table} (guid, type, value) VALUES (?, ?, ?)`);
  for (const [type, value] of Object.entries(values)) insert.run(guid, Number(type), value);
}

function currentDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE addresses (guid VARCHAR PRIMARY KEY, use_count INTEGER, use_date INTEGER, date_modified INTEGER, language_code VARCHAR, label VARCHAR, initial_creator_id INTEGER, record_type INTEGER);
    CREATE TABLE address_type_tokens (guid VARCHAR, type INTEGER, value VARCHAR, verification_status INTEGER, observations BLOB, PRIMARY KEY (guid, type));
    INSERT INTO addresses (guid, use_count, record_type) VALUES ('a', 3, 0), ('b', 1, 2), ('c', 0, 1), ('empty', 0, 0);
  `);
  tokens(db, "address_type_tokens", "a", { 3: "Ana", 5: "Lopez Garcia", 7: "Ana Lopez Garcia", 9: "ana@example.test", 14: "+34600000000", 30: "Calle Mayor 1", 31: "2B", 77: "Calle Mayor 1\n2B", 33: "Madrid", 34: "Madrid", 35: "28001", 36: "es", 60: "Acme" });
  tokens(db, "address_type_tokens", "b", { 7: "  Bob   Smith ", 30: "1 Main St", 31: "Apt 4", 33: "Springfield", 35: "12345", 36: "US" });
  tokens(db, "address_type_tokens", "c", { 3: "Carla", 5: "Ruiz", 9: "carla@example.test" });
  tokens(db, "address_type_tokens", "empty", { 33: "Nowhere", 36: "FR" });
  return db;
}

describe("readChromiumAddresses", () => {
  it("reads the current addresses + address_type_tokens schema", () => {
    const db = currentDb();
    const got = readChromiumAddresses(db);
    expect(got).toEqual([
      { ...emptyAddressFields(), name: "Ana Lopez Garcia", givenName: "Ana", familyName: "Lopez Garcia", email: "ana@example.test", phone: "+34600000000", street: "Calle Mayor 1\n2B", city: "Madrid", region: "Madrid", postalCode: "28001", country: "ES", company: "Acme" },
      { ...emptyAddressFields(), name: "Bob Smith", street: "1 Main St\nApt 4", city: "Springfield", postalCode: "12345", country: "US" },
      { ...emptyAddressFields(), name: "Carla Ruiz", givenName: "Carla", familyName: "Ruiz", email: "carla@example.test" },
    ]);
    expect(countChromiumAddresses(db)).toBe(3);
  });

  it("falls back to local_addresses + local_addresses_type_tokens", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(`
      CREATE TABLE local_addresses (guid VARCHAR PRIMARY KEY, use_count INTEGER, use_date INTEGER, date_modified INTEGER, language_code VARCHAR, label VARCHAR);
      CREATE TABLE local_addresses_type_tokens (guid VARCHAR, type INTEGER, value VARCHAR, verification_status INTEGER, observations BLOB, PRIMARY KEY (guid, type));
      INSERT INTO local_addresses (guid) VALUES ('x');
    `);
    tokens(db, "local_addresses_type_tokens", "x", { 7: "Dana Diaz", 77: "Gran Via 5", 33: "Bilbao", 35: "48001", 36: "ES" });
    expect(readChromiumAddresses(db)).toEqual([{ ...emptyAddressFields(), name: "Dana Diaz", street: "Gran Via 5", city: "Bilbao", postalCode: "48001", country: "ES" }]);
    expect(countChromiumAddresses(db)).toBe(1);
  });

  it("falls back to the legacy autofill_profiles tables", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(`
      CREATE TABLE autofill_profiles (guid VARCHAR PRIMARY KEY, company_name VARCHAR, street_address VARCHAR, dependent_locality VARCHAR, city VARCHAR, state VARCHAR, zipcode VARCHAR, sorting_code VARCHAR, country_code VARCHAR, date_modified INTEGER, origin VARCHAR, use_count INTEGER, use_date INTEGER, language_code VARCHAR);
      CREATE TABLE autofill_profile_names (guid VARCHAR, first_name VARCHAR, middle_name VARCHAR, last_name VARCHAR, full_name VARCHAR);
      CREATE TABLE autofill_profile_emails (guid VARCHAR, email VARCHAR);
      CREATE TABLE autofill_profile_phones (guid VARCHAR, number VARCHAR);
      INSERT INTO autofill_profiles (guid, company_name, street_address, city, state, zipcode, country_code) VALUES ('p1', 'Shop', 'Rua Nova 3', 'Porto', '', '4000-001', 'pt'), ('p2', '', '', 'Lyon', '', '', 'FR');
      INSERT INTO autofill_profile_names (guid, first_name, middle_name, last_name, full_name) VALUES ('p1', 'Eva', '', 'Silva', '');
      INSERT INTO autofill_profile_emails (guid, email) VALUES ('p1', 'eva@example.test');
      INSERT INTO autofill_profile_phones (guid, number) VALUES ('p1', '+351900000000');
    `);
    expect(readChromiumAddresses(db)).toEqual([{ ...emptyAddressFields(), name: "Eva Silva", givenName: "Eva", familyName: "Silva", company: "Shop", street: "Rua Nova 3", city: "Porto", postalCode: "4000-001", country: "PT", email: "eva@example.test", phone: "+351900000000" }]);
    expect(countChromiumAddresses(db)).toBe(1);
  });

  it("reads legacy profiles without the side tables", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(`
      CREATE TABLE autofill_profiles (guid VARCHAR PRIMARY KEY, company_name VARCHAR, street_address VARCHAR, city VARCHAR, state VARCHAR, zipcode VARCHAR, country_code VARCHAR);
      INSERT INTO autofill_profiles (guid, street_address, zipcode) VALUES ('p', 'Main 1', '1000');
    `);
    expect(readChromiumAddresses(db)).toEqual([{ ...emptyAddressFields(), street: "Main 1", postalCode: "1000" }]);
  });

  it("returns nothing for an empty or unknown database", () => {
    const empty = new DatabaseSync(":memory:");
    expect(readChromiumAddresses(empty)).toEqual([]);
    expect(countChromiumAddresses(empty)).toBe(0);
    const other = new DatabaseSync(":memory:");
    other.exec("CREATE TABLE keywords (id INTEGER, keyword VARCHAR)");
    expect(readChromiumAddresses(other)).toEqual([]);
    expect(countChromiumAddresses(other)).toBe(0);
  });

  it("uses an empty current schema rather than falling back", () => {
    const db = currentDb();
    db.exec("DELETE FROM address_type_tokens; DELETE FROM addresses; CREATE TABLE autofill_profiles (guid VARCHAR, street_address VARCHAR); INSERT INTO autofill_profiles VALUES ('old', 'Old 1');");
    expect(readChromiumAddresses(db)).toEqual([]);
  });
});
