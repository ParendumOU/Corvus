import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { cardFromChromium, countChromiumCards, readChromiumCardRows } from "../src/shared/chrome-cards";

const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);

function webData(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE credit_cards (guid VARCHAR PRIMARY KEY, name_on_card VARCHAR, expiration_month INTEGER, expiration_year INTEGER, card_number_encrypted BLOB, date_modified INTEGER NOT NULL DEFAULT 0, origin VARCHAR DEFAULT '', use_count INTEGER NOT NULL DEFAULT 0, use_date INTEGER NOT NULL DEFAULT 0, billing_address_id VARCHAR, nickname VARCHAR);
    CREATE TABLE local_stored_cvc (guid VARCHAR PRIMARY KEY NOT NULL, value_encrypted VARCHAR NOT NULL, last_updated_timestamp INTEGER NOT NULL);
    CREATE TABLE masked_credit_cards (id VARCHAR, name_on_card VARCHAR, network VARCHAR, last_four VARCHAR, exp_month INTEGER, exp_year INTEGER);
    INSERT INTO masked_credit_cards (id, name_on_card, last_four) VALUES ('server', 'Server Card', '9999');
    INSERT INTO local_stored_cvc VALUES ('a', 'v10secret', 0);
  `);
  const insert = db.prepare("INSERT INTO credit_cards (guid, name_on_card, expiration_month, expiration_year, card_number_encrypted, nickname) VALUES (?, ?, ?, ?, ?, ?)");
  insert.run("a", "Ana Example", 8, 2028, bytes("v10aaaa"), "Personal");
  insert.run("b", "Bob Example", 12, 2030, bytes("v20bbbb"), null);
  insert.run("c", "Empty", 1, 2029, new Uint8Array(), null);
  return db;
}

describe("readChromiumCardRows", () => {
  it("reads only the local credit_cards rows that hold a number, still encrypted", () => {
    const rows = readChromiumCardRows(webData());
    expect(rows.map((r) => ({ ...r, encrypted: new TextDecoder().decode(r.encrypted) }))).toEqual([
      { name: "Ana Example", expMonth: 8, expYear: 2028, nickname: "Personal", encrypted: "v10aaaa" },
      { name: "Bob Example", expMonth: 12, expYear: 2030, nickname: "", encrypted: "v20bbbb" },
    ]);
  });

  it("works without a nickname column and with no card table at all", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE credit_cards (guid VARCHAR, name_on_card VARCHAR, expiration_month INTEGER, expiration_year INTEGER, card_number_encrypted BLOB)");
    db.prepare("INSERT INTO credit_cards VALUES ('a', 'Ana', 1, 2027, ?)").run(bytes("v10x"));
    expect(readChromiumCardRows(db).map((r) => r.nickname)).toEqual([""]);
    expect(readChromiumCardRows(new DatabaseSync(":memory:"))).toEqual([]);
  });
});

describe("countChromiumCards", () => {
  it("counts the cards and the app-bound ones from the prefix", () => {
    expect(countChromiumCards(webData())).toEqual({ total: 2, protected: 1 });
  });
});

describe("cardFromChromium", () => {
  it("builds the card with a two-digit month and a four-digit year", () => {
    expect(cardFromChromium({ name: "Ana Example", expMonth: 8, expYear: 2028, nickname: "Personal" }, "4111 1111 1111 1111")).toEqual({ label: "Personal", nameOnCard: "Ana Example", number: "4111111111111111", expMonth: "08", expYear: "2028" });
  });

  it("drops a value that is not a card number and an expiry out of range", () => {
    expect(cardFromChromium({ name: "", expMonth: 0, expYear: 0, nickname: "" }, "1234")).toBeNull();
    expect(cardFromChromium({ name: "", expMonth: 13, expYear: 99, nickname: "" }, "4111111111111111")).toMatchObject({ expMonth: "", expYear: "" });
  });
});
