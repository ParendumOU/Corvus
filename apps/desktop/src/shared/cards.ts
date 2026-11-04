/**
 * Saved payment cards that autofill fills into a page's card form. Pure helpers: validation, cleaning,
 * the brand and how a card is named, matching a sent form against what is saved, and the decision to
 * offer saving it. Unit tested; the store seals the records at rest.
 *
 * A card never has a CVV: the type has no such field, cleaning drops anything it does not know, and a
 * record that carries one is refused. The CVV is asked for each fill and forgotten right after.
 */
import type { CardRole } from "./card-fields";

export interface AutofillCard {
  id: string;
  /** Optional nickname ("Work"). */
  label: string;
  nameOnCard: string;
  /** Digits only. */
  number: string;
  /** "01" to "12", or "". */
  expMonth: string;
  /** Four digits ("2028"), or "". */
  expYear: string;
  createdAt: number;
  updatedAt: number;
  lastUsedAt: number;
  useCount: number;
}

export type CardFields = Omit<AutofillCard, "id" | "createdAt" | "updatedAt" | "lastUsedAt" | "useCount">;

export const CARD_FIELD_KEYS = ["label", "nameOnCard", "number", "expMonth", "expYear"] as const satisfies readonly (keyof CardFields)[];

/** The roles a sent form's fields may be reported with: never the security code. */
export const CARD_CAPTURE_ROLES = ["number", "name", "givenName", "familyName", "exp", "expMonth", "expYear"] as const satisfies readonly CardRole[];
export type CardCaptureRole = (typeof CARD_CAPTURE_ROLES)[number];

const NUMBER_KEYS = ["createdAt", "updatedAt", "lastUsedAt", "useCount"] as const;
const RECORD_KEYS: readonly string[] = ["id", ...CARD_FIELD_KEYS, ...NUMBER_KEYS];
export const MAX_CARD_FIELD = 200;

/** The card as lists show it (no number): brand, last digits and expiry. */
export interface CardSummary {
  id: string;
  label: string;
  nameOnCard: string;
  brand: string;
  last4: string;
  expMonth: string;
  expYear: string;
  createdAt: number;
  updatedAt: number;
  lastUsedAt: number;
  useCount: number;
}

export function emptyCardFields(): CardFields {
  return { label: "", nameOnCard: "", number: "", expMonth: "", expYear: "" };
}

const digits = (s: string): string => s.replace(/\D/g, "");
const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim();

/** The Luhn check digit holds (12 to 19 digits; spaces and dashes ignored). */
export function luhnValid(number: string): boolean {
  if (/[^\d\s-]/.test(number)) return false;
  const d = digits(number);
  if (d.length < 12 || d.length > 19) return false;
  let sum = 0;
  for (let i = 0; i < d.length; i++) {
    let n = Number(d[d.length - 1 - i]);
    if (i % 2 === 1) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
  }
  return sum % 10 === 0;
}

/** The card's brand, from its first digits. */
export function cardBrand(number: string): string {
  const d = digits(number);
  const head = (n: number): number => Number(d.slice(0, n));
  if (/^4/.test(d)) return "Visa";
  if (/^3[47]/.test(d)) return "American Express";
  if (/^5[1-5]/.test(d) || (head(4) >= 2221 && head(4) <= 2720)) return "Mastercard";
  if (/^(6011|65|64[4-9])/.test(d)) return "Discover";
  if (/^35(2[89]|[3-8])/.test(d)) return "JCB";
  if (/^3(0[0-5]|[689])/.test(d)) return "Diners Club";
  if (/^62/.test(d)) return "UnionPay";
  if (/^(5[06-9]|6[0-9])/.test(d)) return "Maestro";
  return "Card";
}

export const last4 = (number: string): string => digits(number).slice(-4);

/** "Visa ...1111". */
export function cardTitle(c: Pick<CardFields, "number">): string {
  return `${cardBrand(c.number)} ...${last4(c.number)}`;
}

/** "08/28", or "" without an expiry. */
export function cardExpiry(c: Pick<CardFields, "expMonth" | "expYear">): string {
  return c.expMonth && c.expYear ? `${c.expMonth}/${c.expYear.slice(-2)}` : "";
}

/** "Visa ...1111 - 08/28", as the dropdown and the save prompt name a card. */
export function cardLine(c: Pick<CardFields, "number" | "expMonth" | "expYear">): string {
  return [cardTitle(c), cardExpiry(c)].filter(Boolean).join(" - ");
}

/** "**** **** **** 1111". */
export function maskedCardNumber(number: string): string {
  return `**** **** **** ${last4(number)}`;
}

export function cardSummary(c: AutofillCard): CardSummary {
  return {
    id: c.id,
    label: c.label,
    nameOnCard: c.nameOnCard,
    brand: cardBrand(c.number),
    last4: last4(c.number),
    expMonth: c.expMonth,
    expYear: c.expYear,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    lastUsedAt: c.lastUsedAt,
    useCount: c.useCount,
  };
}

function month(v: string): string {
  const d = digits(v);
  const n = Number(d);
  return d && d.length <= 2 && n >= 1 && n <= 12 ? String(n).padStart(2, "0") : "";
}

function year(v: string): string {
  const d = digits(v);
  const full = d.length === 2 ? `20${d}` : d.length === 4 ? d : "";
  return full && Number(full) >= 2000 && Number(full) <= 2099 ? full : "";
}

export function isValidCard(v: unknown): v is AutofillCard {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  if (Object.keys(r).some((k) => !RECORD_KEYS.includes(k))) return false;
  if (typeof r.id !== "string" || !r.id) return false;
  if (!CARD_FIELD_KEYS.every((k) => typeof r[k] === "string" && (r[k] as string).length <= MAX_CARD_FIELD)) return false;
  if (!NUMBER_KEYS.every((k) => typeof r[k] === "number" && Number.isFinite(r[k]))) return false;
  return /^\d{12,19}$/.test(r.number as string);
}

/** What a form, the import or the management page gave, made tidy: only the known fields, trimmed, capped. */
export function cleanCardFields(raw: Partial<Record<keyof CardFields, unknown>>): CardFields {
  const str = (k: keyof CardFields): string => (typeof raw[k] === "string" ? (raw[k] as string) : "");
  return {
    label: oneLine(str("label")).slice(0, 100),
    nameOnCard: oneLine(str("nameOnCard")).slice(0, MAX_CARD_FIELD),
    number: digits(str("number")).slice(0, 19),
    expMonth: month(str("expMonth")),
    expYear: year(str("expYear")),
  };
}

/** Lowercase, without accents, letters and digits only. */
function fold(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** A sent card against the saved ones: the same card (same number, nothing new), the same number with a new name or expiry, or a new card. */
export function compareCapturedCard(captured: CardFields, saved: readonly AutofillCard[]): { kind: "same"; id: string } | { kind: "update"; id: string } | { kind: "new" } {
  const c = cleanCardFields(captured);
  const found = saved.find((s) => s.number === c.number);
  if (!found) return { kind: "new" };
  const nameChanged = c.nameOnCard !== "" && fold(c.nameOnCard) !== fold(found.nameOnCard);
  const expiryChanged = (c.expMonth !== "" && c.expMonth !== found.expMonth) || (c.expYear !== "" && c.expYear !== found.expYear);
  return nameChanged || expiryChanged ? { kind: "update", id: found.id } : { kind: "same", id: found.id };
}

/** Whether to offer saving a sent card: a Luhn-valid number, never in private windows, agent tabs or with the setting off. */
export function cardSaveDecision(
  captured: CardFields,
  saved: readonly AutofillCard[],
  ctx: { private: boolean; agent: boolean; enabled: boolean },
): { kind: "none" } | { kind: "update"; id: string } | { kind: "new" } {
  if (ctx.private || ctx.agent || !ctx.enabled) return { kind: "none" };
  const c = cleanCardFields(captured);
  if (!luhnValid(c.number)) return { kind: "none" };
  const found = compareCapturedCard(c, saved);
  return found.kind === "same" ? { kind: "none" } : found;
}

/** The cards (as the management page lists them) whose label, name, brand or last digits hold every word of the query. */
export function searchCards(list: readonly CardSummary[], query: string): CardSummary[] {
  const words = query.split(/\s+/).map(fold).filter(Boolean);
  if (!words.length) return [...list];
  return list.filter((c) => {
    const text = [c.label, c.nameOnCard, c.brand, c.last4].map(fold).join(" ");
    return words.every((w) => text.includes(w));
  });
}

/** What the management page sends to save a card: cleaned fields, and the id when it edits one. Null when malformed. */
export function parseCardSave(raw: unknown): { id?: string; fields: CardFields } | null {
  if (typeof raw !== "object" || raw === null) return null;
  const { id, fields } = raw as { id?: unknown; fields?: unknown };
  if (id !== undefined && id !== null && (typeof id !== "string" || !id || id.length > 128)) return null;
  if (typeof fields !== "object" || fields === null || Array.isArray(fields)) return null;
  const clean = cleanCardFields(fields as Partial<Record<keyof CardFields, unknown>>);
  return typeof id === "string" ? { id, fields: clean } : { fields: clean };
}

/** An expiry typed in one field ("08/28", "08 / 2028", "0828") as month and year. */
export function splitExpiry(value: string): { expMonth: string; expYear: string } {
  const parts = value.split(/[^\d]+/).filter(Boolean);
  if (parts.length >= 2) return { expMonth: month(parts[0]!), expYear: year(parts[1]!) };
  const d = digits(value);
  if (d.length === 4) return { expMonth: month(d.slice(0, 2)), expYear: year(d.slice(2)) };
  if (d.length === 6) return { expMonth: month(d.slice(0, 2)), expYear: year(d.slice(2)) };
  if (d.length === 3) return { expMonth: month(d.slice(0, 1)), expYear: year(d.slice(1)) };
  return { expMonth: "", expYear: "" };
}

/** What a sent card form holds, as card fields. Empty values are left out. */
export function capturedCard(entries: readonly { role: CardCaptureRole; value: string }[]): Partial<CardFields> {
  const out: Partial<CardFields> = {};
  const parts: string[] = [];
  for (const { role, value } of entries) {
    const v = value.trim();
    if (!v) continue;
    if (role === "number") out.number ??= digits(v);
    else if (role === "name") out.nameOnCard ??= oneLine(v);
    else if (role === "givenName") parts.unshift(oneLine(v));
    else if (role === "familyName") parts.push(oneLine(v));
    else if (role === "expMonth") out.expMonth ??= month(v);
    else if (role === "expYear") out.expYear ??= year(v);
    else {
      const { expMonth, expYear } = splitExpiry(v);
      if (expMonth) out.expMonth ??= expMonth;
      if (expYear) out.expYear ??= expYear;
    }
  }
  if (!out.nameOnCard && parts.length) out.nameOnCard = parts.join(" ");
  return out;
}

/** A sent card form as a tab reports it: known roles with text values (never a security code). Null when malformed. */
export function parseCardCapture(raw: unknown): { origin: string; fields: { role: CardCaptureRole; value: string }[] } | null {
  if (typeof raw !== "object" || raw === null) return null;
  const { origin, fields } = raw as { origin?: unknown; fields?: unknown };
  if (typeof origin !== "string" || !origin || origin.length > 4096 || !Array.isArray(fields) || fields.length > 50) return null;
  const roles: readonly string[] = CARD_CAPTURE_ROLES;
  const out: { role: CardCaptureRole; value: string }[] = [];
  for (const f of fields as unknown[]) {
    const { role, value } = (typeof f === "object" && f !== null ? f : {}) as { role?: unknown; value?: unknown };
    if (typeof role === "string" && roles.includes(role) && typeof value === "string" && value.length <= MAX_CARD_FIELD) out.push({ role: role as CardCaptureRole, value });
  }
  return { origin, fields: out };
}
