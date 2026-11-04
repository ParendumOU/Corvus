import { describe, expect, it } from 'vitest';

import { addressDetail, addressesOf, addressFields, addressTitle } from '../src/lib/autofill-addresses';
import { PHONE_COLLECTIONS } from '../src/lib/replica';
import { vaultSealer } from '../src/lib/password-vault';

const base = { label: '', name: '', givenName: '', familyName: '', company: '', street: '', postalCode: '', city: '', region: '', country: '', phone: '', email: '' };

describe('saved addresses', () => {
  it('are synced to the phone and sealed there', () => {
    expect(PHONE_COLLECTIONS).toContain('addresses');
    expect(vaultSealer({ get: async () => null, set: async () => undefined }).collections).toContain('addresses');
  });

  it('reads the valid synced records, most recently used first', () => {
    const list = addressesOf({
      old: { ...base, name: 'Ana', street: 'Calle A 1', createdAt: 1, updatedAt: 2, lastUsedAt: 0, useCount: 0 },
      used: { ...base, label: 'Work', street: 'Calle B 2', city: 'Ourense', updatedAt: 1, lastUsedAt: 9 },
      partial: { name: 'Bob', street: 'Rúa C 3' },
      empty: { ...base, label: 'Nothing here', city: 'Vigo' },
      wrong: { ...base, name: 5 },
      long: { ...base, name: 'x'.repeat(501) },
      none: null,
    });
    expect(list.map((a) => a.id)).toEqual(['used', 'old', 'partial']);
    expect(list[2]).toEqual({ ...base, id: 'partial', name: 'Bob', street: 'Rúa C 3', updatedAt: 0, lastUsedAt: 0 });
  });

  it('names an address by its label, name or street, and says where it is', () => {
    const home = { ...base, label: 'Home', name: 'Ana', street: 'Calle Mayor 1\nPiso 2', city: 'Ourense' };
    expect(addressTitle(home)).toBe('Home');
    expect(addressDetail(home)).toBe('Calle Mayor 1, Ourense');
    expect(addressTitle({ ...home, label: ' ' })).toBe('Ana');
    expect(addressTitle({ ...base, street: 'Calle Mayor 1\nPiso 2' })).toBe('Calle Mayor 1');
    expect(addressDetail({ ...base, street: 'Calle Mayor 1' })).toBe('');
    expect(addressDetail({ ...base, name: 'Ana', email: 'ana@example.com' })).toBe('ana@example.com');
  });

  it('gives the fill only the address fields', () => {
    const saved = { ...base, id: 'x', name: 'Ana', updatedAt: 3, lastUsedAt: 4 };
    const fields = addressFields(saved);
    expect(fields).toEqual({ ...base, name: 'Ana' });
  });
});
