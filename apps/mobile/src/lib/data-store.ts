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

// Each write gets its own temporary file, so two writes of the same key never share one.
let writes = 0;

export const dataStore: DataStore = {
  async get(key) {
    const file = new File(root(), fileName(key));
    return file.exists ? await file.text() : undefined;
  },
  async set(key, value) {
    const dir = root();
    if (!dir.exists) dir.create({ intermediates: true });
    const tmp = new File(dir, `${fileName(key)}.${Date.now().toString(36)}-${(writes++).toString(36)}.tmp`);
    if (tmp.exists) tmp.delete();
    tmp.create();
    await tmp.write(value);
    // move() returns a promise since expo-file-system 58: the value is only saved once it resolves.
    await tmp.move(new File(dir, fileName(key)), { overwrite: true });
  },
  async clear() {
    const dir = root();
    if (dir.exists) dir.delete();
  },
};
