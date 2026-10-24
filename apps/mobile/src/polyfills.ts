/**
 * What the shared sync code expects from its runtime, for React Native: a global Buffer (base64
 * of records) and crypto.getRandomValues (keys, nonces). Imported first, before anything else.
 */
import { Buffer } from 'buffer';
import * as ExpoCrypto from 'expo-crypto';

const g = globalThis as unknown as { Buffer?: typeof Buffer; crypto?: { getRandomValues?: unknown } };

if (!g.Buffer) g.Buffer = Buffer;

if (typeof g.crypto?.getRandomValues !== 'function') {
  g.crypto = { ...(g.crypto ?? {}), getRandomValues: ExpoCrypto.getRandomValues };
}
