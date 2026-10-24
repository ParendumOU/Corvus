/**
 * Checking what the person scanned or typed to pair the phone with a computer. Pure (no React
 * Native), so it unit-tests in Node.
 */
import { decodePairing, normalizeServerUrl, type PairingInfo } from '@corvus/shared';

import { chainIdForPhrase } from './sync';

export type PairingCheck = { ok: true; info: PairingInfo; chainId: string } | { ok: false; error: string };

const NOT_A_CODE = 'That is not a Corvus pairing code. On your computer, open Settings, then Sync, and choose “Pair a phone”.';

function withPhrase(serverUrl: string, phrase: string): PairingCheck {
  const chainId = chainIdForPhrase(phrase);
  if (!chainId) return { ok: false, error: 'The recovery phrase is not valid: check the 24 words.' };
  return { ok: true, info: { serverUrl, phrase: phrase.trim().toLowerCase().split(/\s+/).join(' ') }, chainId };
}

/** A scanned (or pasted) pairing code from the desktop's “Pair a phone”. */
export function checkPairingCode(text: string): PairingCheck {
  const info = decodePairing(text);
  return info ? withPhrase(info.serverUrl, info.phrase) : { ok: false, error: NOT_A_CODE };
}

/** Entered by hand: the sync server's address and the 24-word recovery phrase (or a pasted code). */
export function checkManualPairing(server: string, phraseOrCode: string): PairingCheck {
  if (phraseOrCode.trim().startsWith('corvus-pair:')) return checkPairingCode(phraseOrCode);
  const serverUrl = normalizeServerUrl(server);
  if (!serverUrl) return { ok: false, error: 'Enter the sync server address, starting with https:// or http://.' };
  return withPhrase(serverUrl, phraseOrCode);
}

/** How the phone appears in the computer's device list: its model, or the kind of phone. */
export function phoneDeviceName(model: string | null | undefined, os: string): string {
  const name = model?.trim();
  if (name) return name.slice(0, 60);
  return os === 'ios' ? 'iPhone' : os === 'android' ? 'Android phone' : 'Phone';
}
