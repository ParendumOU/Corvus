/**
 * The payment cards saved in Corvus on the computers, as the phone reads them from the sync chain
 * (collection "cards", end-to-end encrypted there and sealed again on the phone, see
 * password-vault.ts). The phone only reads them and fills them into pages: they are added and changed
 * on a computer. The record is the desktop's AutofillCard (apps/desktop/src/shared/cards.ts). A card
 * never has a CVV: only the known fields are read, and the CVV is asked for each fill and forgotten
 * right after. Pure so it is unit tested.
 */
import { t } from './i18n';

/** What a saved card fills in (the desktop's CardFields). */
export interface CardFields {
  label: string;
  nameOnCard: string;
  /** Digits only. */
  number: string;
  /** "01" to "12", or "". */
  expMonth: string;
  /** Four digits, or "". */
  expYear: string;
}

export interface SavedCard extends CardFields {
  id: string;
  updatedAt: number;
  lastUsedAt: number;
}

const FIELD_KEYS = ['label', 'nameOnCard', 'number', 'expMonth', 'expYear'] as const satisfies readonly (keyof CardFields)[];
const MAX_FIELD = 200;

/** The fields of a card, without its id and dates (what the fill script gets). */
export function cardFields(c: CardFields): CardFields {
  return { label: c.label, nameOnCard: c.nameOnCard, number: c.number, expMonth: c.expMonth, expYear: c.expYear };
}

/** The saved cards in the synced records: the valid ones, most recently used first. */
export function cardsOf(records: Record<string, unknown>): SavedCard[] {
  const out: SavedCard[] = [];
  for (const [id, raw] of Object.entries(records)) {
    if (typeof raw !== 'object' || raw === null) continue;
    const r = raw as Record<string, unknown>;
    const fields = {} as CardFields;
    let valid = true;
    for (const k of FIELD_KEYS) {
      const v = r[k] ?? '';
      if (typeof v !== 'string' || v.length > MAX_FIELD) valid = false;
      fields[k] = typeof v === 'string' ? v : '';
    }
    if (!valid || !/^\d{12,19}$/.test(fields.number)) continue;
    if (!/^(0[1-9]|1[0-2])?$/.test(fields.expMonth) || !/^(\d{4})?$/.test(fields.expYear)) continue;
    const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
    out.push({ ...fields, id, updatedAt: num(r.updatedAt), lastUsedAt: num(r.lastUsedAt) });
  }
  return out.sort((a, b) => b.lastUsedAt - a.lastUsedAt || b.updatedAt - a.updatedAt || a.number.slice(-4).localeCompare(b.number.slice(-4)));
}

/** The card's brand, from its first digits (as the desktop's cardBrand); a plain "Card", translated, for an unknown one. */
export function cardBrand(number: string): string {
  const d = number.replace(/\D/g, '');
  const head = Number(d.slice(0, 4));
  if (/^4/.test(d)) return 'Visa';
  if (/^3[47]/.test(d)) return 'American Express';
  if (/^5[1-5]/.test(d) || (head >= 2221 && head <= 2720)) return 'Mastercard';
  if (/^(6011|65|64[4-9])/.test(d)) return 'Discover';
  if (/^35(2[89]|[3-8])/.test(d)) return 'JCB';
  if (/^3(0[0-5]|[689])/.test(d)) return 'Diners Club';
  if (/^62/.test(d)) return 'UnionPay';
  if (/^(5[06-9]|6[0-9])/.test(d)) return 'Maestro';
  return t('Card');
}

/** "Visa ...1111": all a list ever shows of the number. */
export function cardTitle(c: Pick<CardFields, 'number'>): string {
  return `${cardBrand(c.number)} ...${c.number.replace(/\D/g, '').slice(-4)}`;
}

/** "08/28", or "" without an expiry. */
export function cardExpiry(c: Pick<CardFields, 'expMonth' | 'expYear'>): string {
  return c.expMonth && c.expYear ? `${c.expMonth}/${c.expYear.slice(-2)}` : '';
}

/** The line under a card's title: its label and expiry ("Work - 08/28"). */
export function cardDetail(c: CardFields): string {
  return [c.label.trim(), cardExpiry(c)].filter(Boolean).join(' - ');
}

/** What the CVV field holds once cleaned (digits only, at most 4); `ready` when it is 3 or 4 digits. */
export function cleanCvv(typed: string): { cvv: string; ready: boolean } {
  const cvv = typed.replace(/\D/g, '').slice(0, 4);
  return { cvv, ready: cvv.length >= 3 };
}
