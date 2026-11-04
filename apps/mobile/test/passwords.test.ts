import type { SyncCollection, SyncItem, SyncStateStorage } from '@corvus/shared';
import { describe, expect, it } from 'vitest';

import { VAULT_KEY, vaultSealer, type KeyStore } from '../src/lib/password-vault';
import { fillLoginScript, filterLogins, loginHost, loginsFor, loginsOf, type Login } from '../src/lib/passwords';
import { Replica, type ReplicaClient } from '../src/lib/replica';

const login = (id: string, origin: string, username: string, password = 'secret'): Login => ({ id, origin, username, password, notes: '', updatedAt: 1 });

describe('saved logins', () => {
  it('reads the valid synced records, by site then username', () => {
    const logins = loginsOf({
      b: { origin: 'https://www.zeta.example', username: 'ana', password: 'p1', updatedAt: 5 },
      a: { origin: 'https://alpha.example', username: 'bob', password: 'p2', notes: 'n' },
      c: { origin: 'https://alpha.example', username: 'al', password: 'p3' },
      bad: { origin: '', username: 'x', password: 'y' },
      worse: null,
    });
    expect(logins.map((l) => l.id)).toEqual(['c', 'a', 'b']);
    expect(logins[1]).toEqual({ id: 'a', origin: 'https://alpha.example', username: 'bob', password: 'p2', notes: 'n', updatedAt: 0 });
    expect(loginHost('https://www.zeta.example')).toBe('zeta.example');
  });

  it('filters by site and username', () => {
    const logins = [login('1', 'https://mail.example', 'ana'), login('2', 'https://shop.example', 'bob')];
    expect(filterLogins(logins, 'SHOP').map((l) => l.id)).toEqual(['2']);
    expect(filterLogins(logins, 'mail ana').map((l) => l.id)).toEqual(['1']);
    expect(filterLogins(logins, '  ')).toHaveLength(2);
  });

  it('matches a page to its own site only, the same origin first', () => {
    const logins = [
      login('http', 'http://router.lan', 'admin'),
      login('https', 'https://router.lan', 'root'),
      login('www', 'https://www.shop.example', 'ana'),
      login('evil', 'https://router.lan.evil.example', 'x'),
    ];
    expect(loginsFor(logins, 'https://router.lan/status').map((l) => l.id)).toEqual(['https', 'http']);
    expect(loginsFor(logins, 'router.lan').map((l) => l.id)).toEqual(['http', 'https']);
    expect(loginsFor(logins, 'https://shop.example/cart').map((l) => l.id)).toEqual(['www']);
    expect(loginsFor(logins, 'https://evil.example/')).toEqual([]);
    expect(loginsFor(logins, 'not a url ::')).toEqual([]);
  });

  it('never offers a login saved over https to a page over plain http', () => {
    const logins = [login('https', 'https://router.lan', 'root'), login('http', 'http://router.lan', 'admin')];
    expect(loginsFor(logins, 'http://router.lan/').map((l) => l.id)).toEqual(['http']);
    expect(loginsFor(logins, 'http://www.router.lan/').map((l) => l.id)).toEqual(['http']);
  });

  it('puts the login into the fill script as JSON strings', () => {
    const script = fillLoginScript({ origin: 'https://a.example', username: 'ana"</script>', password: "p'w\\d" });
    expect(script).toContain(JSON.stringify('ana"</script>'));
    expect(script).toContain(JSON.stringify("p'w\\d"));
  });

  it('fills nothing once the page is another site, or plain http for an https login', () => {
    const run = (origin: string, location: { host: string; protocol: string }): unknown =>
      new Function('location', 'document', `return ${fillLoginScript({ origin, username: 'ana', password: 'pw' })}`)(location, undefined);
    expect(run('https://a.example', { host: 'evil.example', protocol: 'https:' })).toBe(false);
    expect(run('https://a.example', { host: 'a.example.evil.example', protocol: 'https:' })).toBe(false);
    expect(run('https://a.example', { host: 'a.example', protocol: 'http:' })).toBe(false);
  });
});

function memory(): SyncStateStorage & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return { map, get: async (k) => map.get(k), set: async (k, v) => void map.set(k, v) };
}

function keyStore(): KeyStore & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return { map, get: async (k) => map.get(k) ?? null, set: async (k, v) => void map.set(k, v) };
}

class FakeChain implements ReplicaClient {
  readonly log: SyncItem[] = [];
  private position = 0;
  async cursor(): Promise<number> {
    return this.position;
  }
  async pullPages(onPage: (items: SyncItem[]) => Promise<void> | void): Promise<number> {
    const fresh = this.log.slice(this.position);
    if (fresh.length > 0) await onPage(fresh);
    this.position = this.log.length;
    return fresh.length;
  }
  async pullCollection(collection: SyncCollection, onPage: (items: SyncItem[]) => Promise<void> | void): Promise<number> {
    const items = this.log.filter((i) => i.collection === collection);
    if (items.length > 0) await onPage(items);
    return items.length;
  }
  async forgetCollection(): Promise<void> {}
}

describe('sealed passwords on the phone', () => {
  const cred = { collection: 'credentials' as const, id: 'c1', payload: { origin: 'https://a.example', username: 'ana', password: 'hunter2' }, deleted: false };

  it('writes the passwords encrypted and reads them back with the key', async () => {
    const storage = memory();
    const keys = keyStore();
    const chain = new FakeChain();
    chain.log.push(cred, { collection: 'bookmarks', id: 'b1', payload: { url: 'https://b.example/' }, deleted: false });
    const replica = new Replica(storage, 'chain/', ['credentials', 'bookmarks'], vaultSealer(keys));
    await replica.sync(chain);

    expect(keys.map.has(VAULT_KEY)).toBe(true);
    const raw = storage.map.get('chain/data/credentials') ?? '';
    expect(raw).not.toContain('hunter2');
    expect(raw).not.toContain('ana');
    expect(storage.map.get('chain/data/bookmarks')).toContain('b.example');

    const restarted = new Replica(storage, 'chain/', ['credentials', 'bookmarks'], vaultSealer(keys));
    expect(loginsOf(await restarted.records('credentials')).map((l) => l.password)).toEqual(['hunter2']);
  });

  it('writes the saved addresses encrypted too', async () => {
    const storage = memory();
    const keys = keyStore();
    const chain = new FakeChain();
    chain.log.push({ collection: 'addresses', id: 'a1', payload: { name: 'Ana Pérez', street: 'Calle Mayor 1', postalCode: '32001' }, deleted: false });
    await new Replica(storage, 'chain/', ['addresses'], vaultSealer(keys)).sync(chain);
    const raw = storage.map.get('chain/data/addresses') ?? '';
    expect(raw).not.toContain('Calle Mayor');
    expect(raw).not.toContain('32001');
    const restarted = new Replica(storage, 'chain/', ['addresses'], vaultSealer(keys));
    expect(await restarted.records('addresses')).toEqual({ a1: { name: 'Ana Pérez', street: 'Calle Mayor 1', postalCode: '32001' } });
  });

  it('fetches the passwords again when their key is gone', async () => {
    const storage = memory();
    const chain = new FakeChain();
    chain.log.push(cred);
    await new Replica(storage, 'chain/', ['credentials'], vaultSealer(keyStore())).sync(chain);

    const lostKey = new Replica(storage, 'chain/', ['credentials'], vaultSealer(keyStore()));
    expect(await lostKey.records('credentials')).toEqual({});
    await lostKey.sync(chain);
    expect(loginsOf(await lostKey.records('credentials')).map((l) => l.username)).toEqual(['ana']);
  });
});
