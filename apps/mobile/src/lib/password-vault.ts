/**
 * The phone's saved passwords, addresses and cards are written to its storage encrypted: the replica's
 * "credentials", "addresses" and "cards" collections are sealed (XChaCha20-Poly1305, the vault primitive of
 * @corvus/sync-core) with a random key kept in the OS's secure storage (Android Keystore, iOS
 * Keychain), never next to the data. A lost key only means they are fetched again from the chain.
 */
import { fromBase64, generateVaultKey, openSecret, sealSecret, toBase64 } from '@corvus/sync-core';

import type { Sealer } from './replica';

export const VAULT_KEY = 'corvus.passwords.vault-key';

export interface KeyStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
}

/** Seals the collections with secrets in them, with the vault key from `store` (made the first time). */
export function vaultSealer(store: KeyStore): Sealer {
  let key: Promise<Uint8Array> | null = null;
  const vaultKey = (create: boolean): Promise<Uint8Array> => {
    key ??= (async () => {
      const saved = await store.get(VAULT_KEY);
      if (saved) return fromBase64(saved);
      if (!create) throw new Error('No vault key');
      const fresh = generateVaultKey();
      await store.set(VAULT_KEY, toBase64(fresh));
      return fresh;
    })();
    return key.catch((err: unknown) => {
      key = null;
      throw err;
    });
  };
  return {
    collections: ['credentials', 'addresses', 'cards'],
    seal: async (text, aad) => sealSecret(await vaultKey(true), text, aad),
    open: async (sealed, aad) => openSecret(await vaultKey(false), sealed, aad),
  };
}
