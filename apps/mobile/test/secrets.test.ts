/**
 * The secure storage's items on iOS, against an in-memory Keychain that, like expo-secure-store,
 * applies the accessibility given when an existing item is saved again and keeps it otherwise.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY = 'AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY';
const keychain = new Map<string, { value: string; accessible: string }>();
const storage = new Map<string, string>();
const platform = { OS: 'ios' };
let failWrites = false;

vi.mock('react-native', () => ({ Platform: platform }));
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (key: string) => storage.get(key) ?? null,
    setItem: async (key: string, value: string) => void storage.set(key, value),
  },
}));
vi.mock('expo-secure-store', () => ({
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
  getItemAsync: async (key: string) => keychain.get(key)?.value ?? null,
  setItemAsync: vi.fn(async (key: string, value: string, options?: { keychainAccessible?: string }) => {
    if (failWrites) throw new Error('errSecInteractionNotAllowed');
    keychain.set(key, { value, accessible: options?.keychainAccessible ?? keychain.get(key)?.accessible ?? 'WHEN_UNLOCKED' });
  }),
  deleteItemAsync: async (key: string) => void keychain.delete(key),
}));

const SecureStore = await import('expo-secure-store');
const { secrets } = await import('../src/lib/secrets');

/** As version 0.9.0 saved it: no options, so iOS's default. */
const savedBy090 = (key: string, value: string) => keychain.set(key, { value, accessible: 'WHEN_UNLOCKED' });

beforeEach(() => {
  keychain.clear();
  storage.clear();
  platform.OS = 'ios';
  failWrites = false;
  vi.mocked(SecureStore.setItemAsync).mockClear();
});

describe('secrets', () => {
  it('saves items readable after the first unlock, on this device only', async () => {
    await secrets.set('corvus.pairing', '{"chainId":"a"}');
    expect(keychain.get('corvus.pairing')).toEqual({ value: '{"chainId":"a"}', accessible: AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY });
  });

  it('keeps reading an item an earlier version saved, and saves it again once with the new setting', async () => {
    savedBy090('corvus.pairing', '{"chainId":"a"}');
    expect(await secrets.get('corvus.pairing')).toBe('{"chainId":"a"}');
    expect(keychain.get('corvus.pairing')).toEqual({ value: '{"chainId":"a"}', accessible: AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY });
    expect(await secrets.get('corvus.pairing')).toBe('{"chainId":"a"}');
    expect(SecureStore.setItemAsync).toHaveBeenCalledTimes(1);
  });

  it('still reads the item when saving it again fails, and tries again at the next read', async () => {
    savedBy090('corvus.pairing', '{"chainId":"a"}');
    failWrites = true;
    expect(await secrets.get('corvus.pairing')).toBe('{"chainId":"a"}');
    expect(keychain.get('corvus.pairing')?.accessible).toBe('WHEN_UNLOCKED');
    failWrites = false;
    expect(await secrets.get('corvus.pairing')).toBe('{"chainId":"a"}');
    expect(keychain.get('corvus.pairing')?.accessible).toBe(AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY);
  });

  it('writes nothing when there is no item', async () => {
    expect(await secrets.get('corvus.pairing')).toBeNull();
    expect(SecureStore.setItemAsync).not.toHaveBeenCalled();
  });

  it('only reads on Android', async () => {
    platform.OS = 'android';
    savedBy090('corvus.pairing', '{"chainId":"a"}');
    expect(await secrets.get('corvus.pairing')).toBe('{"chainId":"a"}');
    expect(SecureStore.setItemAsync).not.toHaveBeenCalled();
  });

  it('removes the item', async () => {
    await secrets.set('corvus.pairing', '{"chainId":"a"}');
    await secrets.remove('corvus.pairing');
    expect(await secrets.get('corvus.pairing')).toBeNull();
  });
});
