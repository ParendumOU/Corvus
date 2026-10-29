/** The web build (automated checks only) keeps the pairing in local storage. */
import AsyncStorage from '@react-native-async-storage/async-storage';

export interface Secrets {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

export const secrets: Secrets = {
  get: (key) => AsyncStorage.getItem(key),
  set: (key, value) => AsyncStorage.setItem(key, value),
  remove: (key) => AsyncStorage.removeItem(key),
};
