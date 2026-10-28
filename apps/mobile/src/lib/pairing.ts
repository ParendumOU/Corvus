/**
 * Checking what the person scanned or typed to pair the phone with a computer. Pure (no React
 * Native), so it unit-tests in Node.
 */
import { decodePairing, isLoopbackUrl, normalizeServerUrl, type PairingInfo } from '@corvus/shared';

import { isUnreachable, pairingUnreachableMessage } from './reach';
import { chainIdForPhrase } from './sync';
import { t } from './i18n';

export type PairingCheck = { ok: true; info: PairingInfo; chainId: string } | { ok: false; error: string };

const notACode = (): string => t('That is not a Corvus pairing code. On your computer, open Settings, then Sync, and choose “Pair a device”.');

function withPhrase(serverUrl: string, phrase: string): PairingCheck {
  const chainId = chainIdForPhrase(phrase);
  if (!chainId) return { ok: false, error: t('The recovery phrase is not valid: check the 24 words.') };
  return { ok: true, info: { serverUrl, phrase: phrase.trim().toLowerCase().split(/\s+/).join(' ') }, chainId };
}

/** A scanned (or pasted) pairing code from the desktop's “Pair a device”. */
export function checkPairingCode(text: string): PairingCheck {
  const info = decodePairing(text);
  return info ? withPhrase(info.serverUrl, info.phrase) : { ok: false, error: notACode() };
}

/** Entered by hand: the sync server's address and the 24-word recovery phrase (or a pasted code). */
export function checkManualPairing(server: string, phraseOrCode: string): PairingCheck {
  if (phraseOrCode.trim().startsWith('corvus-pair:')) return checkPairingCode(phraseOrCode);
  const serverUrl = normalizeServerUrl(server);
  if (!serverUrl) return { ok: false, error: t('Enter the sync server address, starting with https:// or http://.') };
  return withPhrase(serverUrl, phraseOrCode);
}

/**
 * What to show when joining the chain failed. A code from an older Corvus on the computer can carry
 * the server's localhost address, which on the phone means the phone itself: instead of the raw
 * connection error, say what to do; the same when the computer does not answer (another network,
 * computer off, firewall). An answer from a server (an HTTP status) is shown as it is.
 */
export function pairingFailedMessage(err: unknown, serverUrl: string): string {
  const answered = typeof (err as { status?: unknown } | null)?.status === 'number';
  if (!answered && isLoopbackUrl(serverUrl)) {
    return t('This code points to the computer itself (localhost). Update Corvus on the computer, or enter its network address by hand.');
  }
  if (isUnreachable(err)) return pairingUnreachableMessage(serverUrl);
  return t('Could not join the sync chain: {error}', { error: err instanceof Error ? err.message : String(err) });
}

/** How the phone appears in the computer's device list: its model, or the kind of phone. */
export function phoneDeviceName(model: string | null | undefined, os: string): string {
  const name = model?.trim();
  if (name) return name.slice(0, 60);
  return os === 'ios' ? 'iPhone' : os === 'android' ? t('Android phone') : t('Phone');
}
