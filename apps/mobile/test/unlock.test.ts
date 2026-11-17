/** What an unlock of the passwords shows hides again once they lock (lib/unlock.ts). */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let appStateListener: ((next: string) => void) | null = null;

vi.mock('react-native', () => ({
  Platform: { OS: 'android' },
  AppState: { addEventListener: (_: string, listener: (next: string) => void) => void (appStateListener = listener) },
}));
vi.mock('expo-local-authentication', () => ({
  SecurityLevel: { NONE: 0, BIOMETRIC: 2 },
  getEnrolledLevelAsync: async () => 2,
  authenticateAsync: async () => ({ success: true }),
}));

const { UNLOCKED_FOR_MS, lockPasswords, unlockPasswords, whileUnlocked } = await import('../src/lib/unlock');

beforeEach(() => {
  vi.useFakeTimers();
  lockPasswords();
});
afterEach(() => vi.useRealTimers());

describe('a password shown after the phone lock', () => {
  it('hides when the app goes to the background', async () => {
    await unlockPasswords();
    const hide = vi.fn();
    whileUnlocked(hide);
    appStateListener?.('background');
    expect(hide).toHaveBeenCalledTimes(1);
  });

  it('hides when the unlock minutes are over', async () => {
    await unlockPasswords();
    const hide = vi.fn();
    whileUnlocked(hide);
    vi.advanceTimersByTime(UNLOCKED_FOR_MS - 1);
    expect(hide).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(hide).toHaveBeenCalledTimes(1);
    // Once only, and a later lock calls nothing that stopped listening.
    lockPasswords();
    expect(hide).toHaveBeenCalledTimes(1);
  });

  it('hides at once while locked, and not after it stopped listening', async () => {
    const early = vi.fn();
    whileUnlocked(early);
    expect(early).toHaveBeenCalledTimes(1);

    await unlockPasswords();
    const hide = vi.fn();
    whileUnlocked(hide)();
    lockPasswords();
    vi.advanceTimersByTime(UNLOCKED_FOR_MS);
    expect(hide).not.toHaveBeenCalled();
  });
});
