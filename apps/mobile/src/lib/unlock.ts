/**
 * Asks for the phone's own lock (fingerprint, face or PIN) before a saved password is shown, copied
 * or filled. Unlocked once, the passwords stay open for a few minutes, as in a password manager. A
 * phone with no lock set opens them directly: there is nothing to ask for.
 */
import * as LocalAuthentication from 'expo-local-authentication';
import { AppState, Platform } from 'react-native';

import { t } from './i18n';

export const UNLOCKED_FOR_MS = 3 * 60 * 1000;

let unlockedAt = 0;

/** True when the passwords may be used now (asking for the phone's lock if needed). */
export async function unlockPasswords(now = Date.now()): Promise<boolean> {
  if (now - unlockedAt < UNLOCKED_FOR_MS) return true;
  if (Platform.OS === 'web') return true;
  const level = await LocalAuthentication.getEnrolledLevelAsync().catch(() => LocalAuthentication.SecurityLevel.NONE);
  if (level === LocalAuthentication.SecurityLevel.NONE) {
    unlockedAt = now;
    return true;
  }
  const result = await LocalAuthentication.authenticateAsync({ promptMessage: t('Unlock your passwords'), cancelLabel: t('Cancel'), disableDeviceFallback: false });
  if (!result.success) return false;
  unlockedAt = Date.now();
  return true;
}

/** Locks the passwords again (the app went to the background). */
export function lockPasswords(): void {
  unlockedAt = 0;
}

AppState.addEventListener('change', (next) => {
  if (next === 'background') lockPasswords();
});
