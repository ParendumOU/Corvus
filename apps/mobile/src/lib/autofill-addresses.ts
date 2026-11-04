/**
 * The addresses saved in Corvus on the computers (name, contact and postal address), as the phone
 * reads them from the sync chain (collection "addresses", end-to-end encrypted there and sealed again
 * on the phone, see password-vault.ts). The phone only reads them and fills them into pages: they are
 * added and changed on a computer. The record is the desktop's AutofillAddress
 * (apps/desktop/src/shared/addresses.ts). Pure so it is unit tested.
 */

/** What a saved address fills in (the desktop's AddressFields). */
export interface AddressFields {
  /** Optional name the person gave it ("Home", "Workshop"). */
  label: string;
  name: string;
  givenName: string;
  familyName: string;
  company: string;
  /** Street address, lines separated by "\n". */
  street: string;
  postalCode: string;
  city: string;
  region: string;
  /** ISO 3166-1 alpha-2 code, or "". */
  country: string;
  phone: string;
  email: string;
}

export interface SavedAddress extends AddressFields {
  id: string;
  updatedAt: number;
  lastUsedAt: number;
}

const FIELD_KEYS = ['label', 'name', 'givenName', 'familyName', 'company', 'street', 'postalCode', 'city', 'region', 'country', 'phone', 'email'] as const satisfies readonly (keyof AddressFields)[];
/** One of these must hold something for a record to be worth offering (as on the desktop). */
const CONTENT_KEYS = ['name', 'street', 'postalCode', 'phone', 'email'] as const;
const MAX_FIELD = 500;

/** The fields of an address, without its id and dates (what the fill script gets). */
export function addressFields(a: AddressFields): AddressFields {
  const out = {} as AddressFields;
  for (const k of FIELD_KEYS) out[k] = a[k];
  return out;
}

/** The saved addresses in the synced records: the valid ones, most recently used first. */
export function addressesOf(records: Record<string, unknown>): SavedAddress[] {
  const out: SavedAddress[] = [];
  for (const [id, raw] of Object.entries(records)) {
    if (typeof raw !== 'object' || raw === null) continue;
    const r = raw as Record<string, unknown>;
    const fields = {} as AddressFields;
    let valid = true;
    for (const k of FIELD_KEYS) {
      const v = r[k] ?? '';
      if (typeof v !== 'string' || v.length > MAX_FIELD) valid = false;
      fields[k] = typeof v === 'string' ? v : '';
    }
    if (!valid || !CONTENT_KEYS.some((k) => fields[k].trim() !== '')) continue;
    const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
    out.push({ ...fields, id, updatedAt: num(r.updatedAt), lastUsedAt: num(r.lastUsedAt) });
  }
  return out.sort((a, b) => b.lastUsedAt - a.lastUsedAt || b.updatedAt - a.updatedAt || addressTitle(a).localeCompare(addressTitle(b)));
}

/** The line people know an address by: its label, else the name, else the street. */
export function addressTitle(a: AddressFields): string {
  return a.label.trim() || a.name.trim() || a.street.split('\n')[0]?.trim() || a.email.trim() || a.phone.trim();
}

/** Where the address is, for the line under its title ("Calle X 1, Ourense"), or "" when that says nothing new. */
export function addressDetail(a: AddressFields): string {
  const street = a.street.split('\n')[0]?.trim() ?? '';
  const place = [street, a.city.trim()].filter(Boolean).join(', ');
  if (place && place !== addressTitle(a)) return place;
  const contact = a.email.trim() || a.phone.trim();
  return contact !== addressTitle(a) ? contact : '';
}
