/**
 * The replica's files on the phone, against an in-memory expo-file-system whose write() and move()
 * are asynchronous, as in expo-file-system 58: a value is saved only once its move has finished.
 */
import { describe, expect, it, vi } from 'vitest';

const files = new Map<string, string>();
const dirs = new Set<string>();
const later = () => new Promise((r) => setTimeout(r, 5));

vi.mock('expo-file-system', () => {
  const path = (parts: unknown[]) => parts.map((p) => (typeof p === 'string' ? p : (p as { uri: string }).uri)).join('/');
  class Directory {
    readonly uri: string;
    constructor(...parts: unknown[]) {
      this.uri = path(parts);
    }
    get exists() {
      return dirs.has(this.uri);
    }
    create() {
      dirs.add(this.uri);
    }
    delete() {
      dirs.delete(this.uri);
      for (const k of [...files.keys()]) if (k.startsWith(`${this.uri}/`)) files.delete(k);
    }
  }
  class File {
    uri: string;
    constructor(...parts: unknown[]) {
      this.uri = path(parts);
    }
    get exists() {
      return files.has(this.uri);
    }
    create() {
      if (files.has(this.uri)) throw new Error(`exists: ${this.uri}`);
      files.set(this.uri, '');
    }
    delete() {
      files.delete(this.uri);
    }
    async write(value: string) {
      await later();
      if (!files.has(this.uri)) throw new Error(`gone: ${this.uri}`);
      files.set(this.uri, value);
    }
    async text() {
      await later();
      return files.get(this.uri) ?? '';
    }
    async move(to: File) {
      await later();
      const value = files.get(this.uri);
      if (value === undefined) throw new Error(`gone: ${this.uri}`);
      files.delete(this.uri);
      files.set(to.uri, value);
      this.uri = to.uri;
    }
  }
  return { Directory, File, Paths: { document: new Directory('file:///docs') } };
});

const { dataStore } = await import('../src/lib/data-store');

describe('replica files on the phone', () => {
  it('has a value saved once set() resolves, and leaves no temporary files', async () => {
    await dataStore.set('chain/data/open_tabs', '{"a":1}');
    expect(await dataStore.get('chain/data/open_tabs')).toBe('{"a":1}');
    expect([...files.keys()].filter((k) => k.endsWith('.tmp'))).toEqual([]);
  });

  it('keeps the last of two writes of the same key, without either failing', async () => {
    await Promise.all([dataStore.set('chain/data/bookmarks', 'first'), dataStore.set('chain/data/bookmarks', 'second')]);
    expect(await dataStore.get('chain/data/bookmarks')).toBe('second');
    await dataStore.clear();
    expect(await dataStore.get('chain/data/bookmarks')).toBeUndefined();
  });
});
