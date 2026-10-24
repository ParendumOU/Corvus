/**
 * Where the phone keeps its copy of synced collections: files in the app's documents folder (no
 * size limit, unlike AsyncStorage's few MB on Android). Each value is written to a temporary file
 * and moved over the old one, so an interrupted write never leaves half a file.
 */
import type { SyncStateStorage } from '@corvus/shared';
import { Directory, File, Paths } from 'expo-file-system';

export interface DataStore extends SyncStateStorage {
  /** Removes everything (unpairing). */
  clear(): Promise<void>;
}

const root = (): Directory => new Directory(Paths.document, 'corvus-data');
const fileName = (key: string): string => `${encodeURIComponent(key)}.json`;

export const dataStore: DataStore = {
  async get(key) {
    const file = new File(root(), fileName(key));
    return file.exists ? await file.text() : undefined;
  },
  async set(key, value) {
    const dir = root();
    if (!dir.exists) dir.create({ intermediates: true });
    const tmp = new File(dir, `${fileName(key)}.tmp`);
    if (tmp.exists) tmp.delete();
    tmp.create();
    await tmp.write(value);
    tmp.move(new File(dir, fileName(key)), { overwrite: true });
  },
  async clear() {
    const dir = root();
    if (dir.exists) dir.delete();
  },
};
