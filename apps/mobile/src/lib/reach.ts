/**
 * When the phone cannot reach its sync server: telling that apart from a server that answered with
 * an error, and saying it calmly. A computer syncing through the server built into Corvus is only
 * reachable on its own network (or Tailscale), so being away from home or the computer being off is
 * normal, not an error. Pure, so it unit-tests in Node.
 */
import { t } from './i18n';

/** No answer from the server at all: offline, wrong network, computer off, firewall, or a timeout. */
export function isUnreachable(err: unknown): boolean {
  if (err === null || typeof err !== 'object') return false;
  const { status, code } = err as { status?: unknown; code?: unknown };
  if (code === 'timeout') return true;
  if (typeof status === 'number') return status === 0;
  return err instanceof TypeError || /network request failed|fetch failed|failed to fetch|network error/i.test(String((err as { message?: unknown }).message ?? ''));
}

/**
 * Whether the server is on a home network: a private or Tailscale address, or a .local name. That
 * is a computer syncing through Corvus's own server (or another server at home).
 */
export function isHomeServer(serverUrl: string): boolean {
  let host: string;
  try {
    host = new URL(serverUrl).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host.endsWith('.local')) return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(host);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

/** The home screen's note while the server cannot be reached: changes wait on the phone. */
export function unreachableNote(serverUrl: string): string {
  return isHomeServer(serverUrl)
    ? t('Your computer is not reachable. Changes are kept and sync when you are on the same Wi-Fi as it.')
    : t('Your sync server is not reachable. Changes are kept and sync when it is back.');
}

/** For something that needs the computer now (sending a page, asking a question). */
export function needsServerMessage(serverUrl: string): string {
  return isHomeServer(serverUrl)
    ? t('Your computer is not reachable right now. Try again when you are on the same Wi-Fi as it, with Corvus open on it.')
    : t('Your sync server is not reachable right now. Try again later.');
}

/** Pairing could not reach the computer: what to check, instead of a raw timeout. */
export function pairingUnreachableMessage(serverUrl: string): string {
  return isHomeServer(serverUrl)
    ? t('Could not reach your computer. Check that the phone is on the same Wi-Fi as the computer (not a guest Wi-Fi), that the computer is on with Corvus open, and that its firewall lets Corvus through: on the computer, Settings, Sync, Pair a device, “Phone cannot connect?”.')
    : t('Could not reach the sync server at {url}. Check the address and that the server is running.', { url: serverUrl });
}
