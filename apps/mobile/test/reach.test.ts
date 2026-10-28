import type { SyncStateStorage } from '@corvus/shared';
import { describe, expect, it } from 'vitest';

import { Outbox } from '../src/lib/outbox';
import { pairingFailedMessage } from '../src/lib/pairing';
import { isHomeServer, isUnreachable, needsServerMessage, unreachableNote } from '../src/lib/reach';

function memory(): SyncStateStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, get: async (k) => data.get(k), set: async (k, v) => void data.set(k, v) };
}

describe('unreachable server', () => {
  it('tells no answer apart from an answer', () => {
    expect(isUnreachable(new TypeError('Network request failed'))).toBe(true);
    expect(isUnreachable(Object.assign(new Error('The sync server did not answer within 30 s'), { status: 0, code: 'timeout' }))).toBe(true);
    expect(isUnreachable(Object.assign(new Error('Unknown sync chain'), { status: 404, code: 'chain_not_found' }))).toBe(false);
    expect(isUnreachable(Object.assign(new Error('Too many requests'), { status: 429, code: 'rate_limited' }))).toBe(false);
    expect(isUnreachable(new Error('Something else'))).toBe(false);
    expect(isUnreachable(null)).toBe(false);
  });

  it('a computer at home is said calmly, an own server too', () => {
    expect(isHomeServer('http://192.168.1.20:8797')).toBe(true);
    expect(isHomeServer('http://100.101.102.103:8797')).toBe(true);
    expect(isHomeServer('http://my-pc.local:8797')).toBe(true);
    expect(isHomeServer('https://sync.example.org')).toBe(false);
    expect(unreachableNote('http://192.168.1.20:8797')).toBe('Your computer is not reachable. Changes are kept and sync when you are on the same Wi-Fi as it.');
    expect(unreachableNote('https://sync.example.org')).toMatch(/sync server is not reachable/);
    expect(needsServerMessage('http://10.0.0.4:8797')).toMatch(/same Wi-Fi/);
  });

  it('pairing that times out says what to check', () => {
    const timeout = Object.assign(new Error('The sync server did not answer within 30 s'), { status: 0, code: 'timeout' });
    const message = pairingFailedMessage(timeout, 'http://192.168.1.20:8797');
    expect(message).toMatch(/same Wi-Fi/);
    expect(message).toMatch(/firewall/);
    expect(message).not.toMatch(/30 s/);
    expect(pairingFailedMessage(Object.assign(new Error('Device was removed'), { status: 403 }), 'http://192.168.1.20:8797')).toMatch(/Device was removed/);
  });
});

describe('outbox', () => {
  it('keeps what changed while unreachable and hands it over with what the replica holds then', async () => {
    const storage = memory();
    const outbox = new Outbox(storage, 'corvus-sync/chain/outbox');
    await outbox.add('reading', 'https://a.example/');
    await outbox.add('bookmarks', 'b1');
    await outbox.add('reading', 'https://a.example/');
    const replica: Record<string, Record<string, unknown>> = { reading: { 'https://a.example/': { url: 'https://a.example/' } }, bookmarks: {} };
    const again = new Outbox(storage, 'corvus-sync/chain/outbox');
    expect(await again.size()).toBe(2);
    const items = await again.items({ records: async (c) => replica[c] ?? {} });
    expect(items).toEqual([
      { collection: 'reading', id: 'https://a.example/', payload: { url: 'https://a.example/' }, deleted: false },
      { collection: 'bookmarks', id: 'b1', payload: null, deleted: true },
    ]);
    await again.done(items.slice(0, 1));
    expect(await new Outbox(storage, 'corvus-sync/chain/outbox').size()).toBe(1);
  });

  it('ignores a damaged list', async () => {
    const storage = memory();
    await storage.set('k', '{not json');
    expect(await new Outbox(storage, 'k').size()).toBe(0);
    await storage.set('k', JSON.stringify(['nope\u0000x', 'reading\u0000y']));
    expect(await new Outbox(storage, 'k').size()).toBe(1);
  });
});
