/**
 * The phone's side of Corvus sync: the same end-to-end encrypted chain the desktop uses, from the
 * same recovery phrase. Pure (no React Native), so it unit-tests in Node.
 */
import { deriveKeys, normalizeRecoveryPhrase, validateRecoveryPhrase } from '@corvus/sync-core';

/** The sync chain a recovery phrase opens, or null when the phrase is not a valid one. */
export function chainIdForPhrase(phrase: string): string | null {
  const normalized = normalizeRecoveryPhrase(phrase);
  if (!validateRecoveryPhrase(normalized)) return null;
  return deriveKeys(normalized).chainId;
}
