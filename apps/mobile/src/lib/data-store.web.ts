/** The web build (automated checks only) keeps the synced collections in local storage. */
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { SyncStateStorage } from '@corvus/shared';

export interface DataStore extends SyncStateStorage {
  clear(): Promise<void>;
}

const PREFIX = 'corvus-data/';

export const dataStore: DataStore = {
  get: async (key) => (await AsyncStorage.getItem(PREFIX + key)) ?? undefined,
  set: (key, value) => AsyncStorage.setItem(PREFIX + key, value),
  async clear() {
    const keys = (await AsyncStorage.getAllKeys()).filter((k) => k.startsWith(PREFIX));
    if (keys.length > 0) await AsyncStorage.multiRemove(keys);
  },
};
