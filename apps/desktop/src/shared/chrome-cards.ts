/**
 * Saved payment cards from a Chromium profile's `Web Data` SQLite file. Pure: takes an open database
 * and returns the rows with the number still encrypted (main/browser-import.ts decrypts it with the
 * profile's key). Only the local `credit_cards` table is read: never `local_stored_cvc` or any other
 * security-code table, and never the Google account's server cards (`masked_credit_cards`).
 */
import { cleanCardFields, type CardFields } from "./cards";
import type { SqliteLike } from "./chrome-addresses";

/** One local card as Chromium stores it; `encrypted` is card_number_encrypted, unread. */
export interface ChromiumCardRow {
  name: string;
  expMonth: number;
  expYear: number;
  nickname: string;
  encrypted: Uint8Array;
}

type Row = Record<string, unknown>;

const text = (v: unknown): string => (typeof v === "string" ? v : "");
const int = (v: unknown): number => (typeof v === "number" || typeof v === "bigint" ? Number(v) : 0);

function columns(db: SqliteLike, table: string): Set<string> | null {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").all(table) as Row[];
  if (tables.length === 0) return null;
  return new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Row[]).map((r) => text(r.name)));
}

/** Every local card of the profile (none when the table is missing), oldest first. */
export function readChromiumCardRows(db: SqliteLike): ChromiumCardRow[] {
  const cols = columns(db, "credit_cards");
  if (!cols?.has("card_number_encrypted")) return [];
  const nickname = cols.has("nickname") ? "nickname" : "'' AS nickname";
  const rows = db.prepare(`SELECT name_on_card, expiration_month, expiration_year, ${nickname}, card_number_encrypted FROM credit_cards ORDER BY rowid`).all() as Row[];
  return rows
    .map((r) => ({
      name: text(r.name_on_card),
      expMonth: int(r.expiration_month),
      expYear: int(r.expiration_year),
      nickname: text(r.nickname),
      encrypted: r.card_number_encrypted instanceof Uint8Array ? r.card_number_encrypted : new Uint8Array(),
    }))
    .filter((r) => r.encrypted.length > 0);
}

/**
 * How many local cards the profile holds, and how many of them the browser protects itself (a value
 * version after v10/v11, Chrome's app-bound encryption): read from the version prefix, nothing decrypted.
 */
export function countChromiumCards(db: SqliteLike): { total: number; protected: number } {
  const rows = readChromiumCardRows(db);
  let isProtected = 0;
  for (const r of rows) {
    const prefix = String.fromCharCode(...r.encrypted.subarray(0, 3));
    if (/^v\d\d$/.test(prefix) && prefix !== "v10" && prefix !== "v11") isProtected++;
  }
  return { total: rows.length, protected: isProtected };
}

/** The card a row holds once its number is decrypted; null when the number is not a card number. */
export function cardFromChromium(row: Pick<ChromiumCardRow, "name" | "expMonth" | "expYear" | "nickname">, number: string): CardFields | null {
  const fields = cleanCardFields({
    label: row.nickname,
    nameOnCard: row.name,
    number,
    expMonth: row.expMonth >= 1 && row.expMonth <= 12 ? String(row.expMonth) : "",
    expYear: row.expYear >= 2000 && row.expYear <= 2200 ? String(row.expYear) : "",
  });
  return /^\d{12,19}$/.test(fields.number) ? fields : null;
}
