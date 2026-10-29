/**
 * The OS's secure storage (Keychain / Keystore), where the pairing and its recovery phrase live.
 *
 * On iOS its items are readable once the iPhone has been unlocked after starting up, locked again
 * or not, so the background check behind notifications reads the pairing on a locked iPhone; and
 * they stay on this iPhone: a backup never brings them to another one. Android has no such setting
 * (expo-secure-store ignores it there).
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

export interface Secrets {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

const OPTIONS: SecureStore.SecureStoreOptions = { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY };

/** Set per key once its item is saved with OPTIONS. */
const UPGRADED_PREFIX = 'corvus.secrets.upgraded/';

/**
 * Version 0.9.0 and earlier saved items with iOS's default, readable only while the iPhone is
 * unlocked: saved again once with OPTIONS (expo-secure-store applies them to the existing item).
 */
async function upgrade(key: string, value: string): Promise<void> {
  if (await AsyncStorage.getItem(UPGRADED_PREFIX + key)) return;
  await SecureStore.setItemAsync(key, value, OPTIONS);
  await AsyncStorage.setItem(UPGRADED_PREFIX + key, '1');
}

export const secrets: Secrets = {
  async get(key) {
    const value = await SecureStore.getItemAsync(key);
    // Read means writable now; a failed upgrade is tried again at the next read.
    if (value !== null && Platform.OS === 'ios') await upgrade(key, value).catch(() => undefined);
    return value;
  },
  set: (key, value) => SecureStore.setItemAsync(key, value, OPTIONS),
  remove: (key) => SecureStore.deleteItemAsync(key),
};
