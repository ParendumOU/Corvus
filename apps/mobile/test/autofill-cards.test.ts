import { afterEach, describe, expect, it } from 'vitest';

import { cardBrand, cardDetail, cardExpiry, cardFields, cardsOf, cardTitle, cleanCvv } from '../src/lib/autofill-cards';
import { setUiLanguage } from '../src/lib/i18n';
import { vaultSealer } from '../src/lib/password-vault';
import { PHONE_COLLECTIONS } from '../src/lib/replica';

const base = { label: '', nameOnCard: 'Ana Pérez', number: '4111111111111111', expMonth: '08', expYear: '2028' };

describe('saved cards', () => {
  afterEach(() => setUiLanguage('en'));

  it('are synced to the phone and sealed there', () => {
    expect(PHONE_COLLECTIONS).toContain('cards');
    expect(vaultSealer({ get: async () => null, set: async () => undefined }).collections).toContain('cards');
  });

  it('reads the valid synced records, most recently used first, and never a CVV', () => {
    const list = cardsOf({
      old: { ...base, updatedAt: 2, lastUsedAt: 0 },
      used: { ...base, number: '5555555555554444', updatedAt: 1, lastUsedAt: 9, cvv: '123' },
      short: { ...base, number: '4111' },
      spaced: { ...base, number: '4111 1111 1111 1111' },
      month: { ...base, expMonth: '13' },
      year: { ...base, expYear: '28' },
      wrong: { ...base, label: 5 },
      none: null,
    });
    expect(list.map((c) => c.id)).toEqual(['used', 'old']);
    expect(list[0]).toEqual({ ...base, number: '5555555555554444', id: 'used', updatedAt: 1, lastUsedAt: 9 });
    expect(JSON.stringify(list)).not.toContain('cvv');
  });

  it('names a card by brand, last digits and expiry only', () => {
    expect(cardTitle(base)).toBe('Visa ...1111');
    expect(cardExpiry(base)).toBe('08/28');
    expect(cardExpiry({ expMonth: '', expYear: '2028' })).toBe('');
    expect(cardDetail({ ...base, label: 'Work' })).toBe('Work - 08/28');
    expect(cardDetail({ ...base, expYear: '' })).toBe('');
    expect(['378282246310005', '5105105105105100', '2221000000000009', '6011111111111117', '3530111333300000', '30569309025904', '6200000000000005', '6759649826438453', '9999999999999'].map(cardBrand)).toEqual([
      'American Express',
      'Mastercard',
      'Mastercard',
      'Discover',
      'JCB',
      'Diners Club',
      'UnionPay',
      'Maestro',
      'Card',
    ]);
    setUiLanguage('es');
    expect(cardTitle({ number: '9999999999999' })).toBe('Tarjeta ...9999');
    expect(cardTitle(base)).toBe('Visa ...1111');
  });

  it('gives the fill only the card fields', () => {
    expect(cardFields({ ...base, id: 'x', updatedAt: 1, lastUsedAt: 2 } as never)).toEqual(base);
  });

  it('keeps a typed CVV to 3 or 4 digits', () => {
    expect(cleanCvv('12')).toEqual({ cvv: '12', ready: false });
    expect(cleanCvv('1a2 3')).toEqual({ cvv: '123', ready: true });
    expect(cleanCvv('123456')).toEqual({ cvv: '1234', ready: true });
  });
});
