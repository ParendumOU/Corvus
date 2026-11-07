import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CardVault } from "../src/main/card-store";
import { ConnectionStore } from "../src/main/connections";
import { CredentialVault } from "../src/main/credential-store";
import { KeePassStore } from "../src/main/keepass-store";
import { ProfileLock, ProfileLockedError, blobsReadBack, rewrapAll, type LockWrapped } from "../src/main/profile-lock";
import {
  COSE_EDDSA,
  COSE_ES256,
  COSE_RS256,
  b64url,
  open,
  prfKek,
  randomKey,
  seal,
  secretKek,
  verifyAssertion,
  type AssertionResult,
  type Expected,
} from "../src/main/profile-lock-crypto";
import type { SecretCipher } from "../src/main/settings-store";
import { FREE_LOCK_ATTEMPTS, lockBackoffMs, lockSecretProblem } from "../src/shared/profile-lock";
import { commandForInput, isPageFirst, pageCommand, type KeyInput } from "../src/shared/shortcuts";
import { lockedWindowState } from "../src/shared/window-state";
import { base32Decode, totpAt } from "../src/shared/totp";

/** Reversible stand-in for the OS keychain (same shape the other store tests use). */
const keychain: SecretCipher = {
  isEncryptionAvailable: () => true,
  encryptString: (plain) => Buffer.from(`enc:${plain}`),
  decryptString: (enc) => {
    const text = enc.toString();
    if (!text.startsWith("enc:")) throw new Error("not ours");
    return text.slice(4);
  },
};

/** Fast scrypt for tests (the real cost is LOCK_SCRYPT). */
const FAST = { N: 1024, r: 8, p: 1 };

const dirs: string[] = [];
function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "corvus-lock-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("lock rules", () => {
  it("takes a PIN of at least 6 digits and a password of at least 8 characters", () => {
    expect(lockSecretProblem("pin", "123456")).toBeNull();
    expect(lockSecretProblem("pin", "12345")).not.toBeNull();
    expect(lockSecretProblem("pin", "12345a")).not.toBeNull();
    expect(lockSecretProblem("password", "correct horse")).toBeNull();
    expect(lockSecretProblem("password", "short")).not.toBeNull();
  });

  it("makes the person wait longer after each wrong attempt past the free ones", () => {
    for (let i = 0; i < FREE_LOCK_ATTEMPTS; i++) expect(lockBackoffMs(i)).toBe(0);
    const waits = [3, 4, 5, 6, 7, 8, 20].map(lockBackoffMs);
    expect(waits[0]).toBeGreaterThan(0);
    for (let i = 1; i < waits.length; i++) expect(waits[i]!).toBeGreaterThanOrEqual(waits[i - 1]!);
    expect(lockBackoffMs(100)).toBe(300_000);
  });
});

describe("lock crypto", () => {
  it("opens what it sealed with the same key only", () => {
    const key = randomKey();
    const sealed = seal(key, Buffer.from("secret"), "aad");
    expect(open(key, sealed, "aad").toString()).toBe("secret");
    expect(() => open(randomKey(), sealed, "aad")).toThrow();
    expect(() => open(key, sealed, "other")).toThrow();
  });

  it("derives the PIN's key from the PIN, the salt and the keychain's pepper", async () => {
    const salt = randomKey(16);
    const pepper = randomKey();
    const a = await secretKek("123456", salt, FAST, pepper);
    expect(await secretKek("123456", salt, FAST, pepper)).toEqual(a);
    expect(await secretKek("123457", salt, FAST, pepper)).not.toEqual(a);
    expect(await secretKek("123456", salt, FAST, randomKey())).not.toEqual(a);
    expect(prfKek(randomKey(), salt)).toHaveLength(32);
  });
});

/** A software authenticator: signs assertions the way a security key or Windows Hello does. */
function authenticator(kind: "ec" | "rsa" | "ed25519") {
  const pair = kind === "ec" ? crypto.generateKeyPairSync("ec", { namedCurve: "P-256" }) : kind === "rsa" ? crypto.generateKeyPairSync("rsa", { modulusLength: 2048 }) : crypto.generateKeyPairSync("ed25519");
  const algorithm = kind === "ec" ? COSE_ES256 : kind === "rsa" ? COSE_RS256 : COSE_EDDSA;
  const credentialId = b64url(randomKey(16));
  const publicKey = b64url(pair.publicKey.export({ format: "der", type: "spki" }));
  let counter = 0;
  const assert = (expected: Expected, opts: { flags?: number; rpId?: string; origin?: string; challenge?: Buffer; prf?: Buffer } = {}): AssertionResult => {
    counter += 1;
    const authData = Buffer.alloc(37);
    crypto.createHash("sha256").update(opts.rpId ?? expected.rpId).digest().copy(authData, 0);
    authData[32] = opts.flags ?? 0x05;
    authData.writeUInt32BE(counter, 33);
    const clientData = Buffer.from(JSON.stringify({ type: expected.type, challenge: b64url(opts.challenge ?? expected.challenge), origin: opts.origin ?? expected.origin, crossOrigin: false }));
    const signed = Buffer.concat([authData, crypto.createHash("sha256").update(clientData).digest()]);
    const signature = kind === "ed25519" ? crypto.sign(null, signed, pair.privateKey) : crypto.sign("sha256", signed, pair.privateKey);
    return { credentialId, clientDataJSON: b64url(clientData), authenticatorData: b64url(authData), signature: b64url(signature), ...(opts.prf ? { prf: b64url(opts.prf) } : {}) };
  };
  return { credentialId, publicKey, algorithm, assert };
}

const expectation = (): Expected => ({ challenge: randomKey(), origin: "https://lock.corvus.invalid", rpId: "lock.corvus.invalid", type: "webauthn.get" });

describe("WebAuthn assertions", () => {
  it.each(["ec", "rsa", "ed25519"] as const)("verifies a %s signature and refuses tampering", (kind) => {
    const auth = authenticator(kind);
    const stored = { credentialId: auth.credentialId, publicKey: auth.publicKey, algorithm: auth.algorithm, signCount: 0 };
    const expected = expectation();
    expect(verifyAssertion(auth.assert(expected), stored, expected, true)).toBe(1);
    const good = auth.assert(expected);
    const tampered = { ...good, signature: b64url(Buffer.from(good.signature, "base64url").map((b, i) => (i === 10 ? b ^ 1 : b))) };
    expect(() => verifyAssertion(tampered, stored, expected, true)).toThrow();
  });

  it("refuses another challenge, origin, site, an untouched or unverified authenticator, and a counter going back", () => {
    const auth = authenticator("ec");
    const stored = { credentialId: auth.credentialId, publicKey: auth.publicKey, algorithm: auth.algorithm, signCount: 0 };
    const expected = expectation();
    expect(() => verifyAssertion(auth.assert(expected, { challenge: randomKey() }), stored, expected, false)).toThrow(/another request/);
    expect(() => verifyAssertion(auth.assert(expected, { origin: "https://example.com" }), stored, expected, false)).toThrow(/another site/);
    expect(() => verifyAssertion(auth.assert(expected, { rpId: "example.com" }), stored, expected, false)).toThrow(/another site/);
    expect(() => verifyAssertion(auth.assert(expected, { flags: 0x00 }), stored, expected, false)).toThrow(/not touched/);
    expect(() => verifyAssertion(auth.assert(expected, { flags: 0x01 }), stored, expected, true)).toThrow(/check it is you/);
    expect(verifyAssertion(auth.assert(expected, { flags: 0x01 }), stored, expected, false)).toBeGreaterThan(0);
    expect(() => verifyAssertion(auth.assert(expected), { ...stored, signCount: 1000 }, expected, false)).toThrow(/copied/);
    expect(() => verifyAssertion(auth.assert(expected), { ...stored, credentialId: "other" }, expected, false)).toThrow();
  });
});

describe("ProfileLock", () => {
  it("adds a PIN lock, locks, refuses a wrong PIN and opens with the right one", async () => {
    const dir = tmp();
    const lock = new ProfileLock(dir, keychain);
    expect(lock.configured).toBe(false);
    await lock.create("pin", "246810", FAST);
    expect(lock.configured && !lock.locked && lock.pending).toBe(true);
    const wrapped = lock.cipher.encryptString("vault key");
    expect(keychain.decryptString(wrapped)).toMatch(/^corvus-lk1:/);
    lock.lock();
    expect(lock.locked).toBe(true);
    expect(() => lock.cipher.decryptString(wrapped)).toThrow(ProfileLockedError);
    expect(() => lock.cipher.encryptString("x")).toThrow(ProfileLockedError);
    expect(await lock.unlockWithSecret("111111")).toMatchObject({ ok: false, error: "Wrong PIN." });
    expect(await lock.unlockWithSecret("246810")).toEqual({ ok: true });
    expect(lock.cipher.decryptString(wrapped)).toBe("vault key");
  });

  it("starts locked after a restart, and the old key still opens the secrets", async () => {
    const dir = tmp();
    const first = new ProfileLock(dir, keychain);
    await first.create("password", "correct horse", FAST);
    const wrapped = first.cipher.encryptString("phrase");
    const again = new ProfileLock(dir, keychain);
    expect(again.locked).toBe(true);
    expect(again.kind).toBe("password");
    expect(await again.unlockWithSecret("correct horse")).toEqual({ ok: true });
    expect(again.cipher.decryptString(wrapped)).toBe("phrase");
  });

  it("makes the person wait after repeated wrong attempts, also across restarts", async () => {
    const dir = tmp();
    let now = 1_000_000;
    const lock = new ProfileLock(dir, keychain, () => now);
    await lock.create("pin", "135790", FAST);
    lock.lock();
    for (let i = 0; i < FREE_LOCK_ATTEMPTS; i++) await lock.unlockWithSecret("000000");
    const waiting = await lock.unlockWithSecret("135790");
    expect(waiting.ok).toBe(false);
    expect(waiting.ok === false && waiting.retryAt).toBe(now + lockBackoffMs(FREE_LOCK_ATTEMPTS));
    expect(new ProfileLock(dir, keychain, () => now).retryAt()).toBe(now + lockBackoffMs(FREE_LOCK_ATTEMPTS));
    now += lockBackoffMs(FREE_LOCK_ATTEMPTS);
    expect(await lock.unlockWithSecret("135790")).toEqual({ ok: true });
    expect(lock.retryAt()).toBeNull();
  });

  it("changes the PIN without touching the secrets", async () => {
    const lock = new ProfileLock(tmp(), keychain);
    await lock.create("pin", "112233", FAST);
    const wrapped = lock.cipher.encryptString("card key");
    await lock.changeSecret("password", "a longer secret", FAST);
    lock.lock();
    expect((await lock.unlockWithSecret("112233")).ok).toBe(false);
    expect(await lock.unlockWithSecret("a longer secret")).toEqual({ ok: true });
    expect(lock.cipher.decryptString(wrapped)).toBe("card key");
  });

  it("opens with an authenticator app's code, once per code", async () => {
    let now = 1_700_000_000_000;
    const lock = new ProfileLock(tmp(), keychain, () => now);
    await lock.create("pin", "123123", FAST);
    const secret = ProfileLock.newTotpSecret();
    const code = (at: number): Promise<string> => totpAt(base32Decode(secret), Math.floor(at / 1000));
    expect(await lock.addTotp(secret, "000000", "Phone")).toBe(false);
    expect(await lock.addTotp(secret, await code(now), "Phone")).toBe(true);
    expect(lock.methods()).toMatchObject([{ type: "totp", label: "Phone", keyBound: false }]);
    now += 30_000;
    lock.lock();
    const fresh = await code(now);
    expect(await lock.unlockWithTotp(fresh)).toEqual({ ok: true });
    lock.lock();
    expect((await lock.unlockWithTotp(fresh)).ok).toBe(false);
  });

  it("opens with a security key's PRF output, which seals the key", async () => {
    const lock = new ProfileLock(tmp(), keychain);
    await lock.create("pin", "987654", FAST);
    const auth = authenticator("ec");
    const prfSalt = randomKey();
    const prf = randomKey();
    lock.addCredential({ type: "fido2", label: "", credentialId: auth.credentialId, publicKey: auth.publicKey, algorithm: auth.algorithm, signCount: 0, prfSalt, prfOutput: prf });
    expect(lock.methods()).toMatchObject([{ type: "fido2", label: "Security key", keyBound: true }]);
    expect(lock.credentials("fido2")).toEqual([{ credentialId: auth.credentialId, prfSalt: b64url(prfSalt) }]);
    const wrapped = lock.cipher.encryptString("totp secrets");
    lock.lock();
    let expected = expectation();
    expect((lock.unlockWithAssertion(auth.assert(expected, { prf: randomKey() }), expected)).ok).toBe(false);
    expect(lock.locked).toBe(true);
    expected = expectation();
    expect(lock.unlockWithAssertion(auth.assert(expected), expected).ok).toBe(false);
    expected = expectation();
    expect(lock.unlockWithAssertion(auth.assert(expected, { prf }), expected)).toEqual({ ok: true });
    expect(lock.cipher.decryptString(wrapped)).toBe("totp secrets");
  });

  it("opens with Windows Hello without PRF through the keychain copy, after checking the signature", async () => {
    const lock = new ProfileLock(tmp(), keychain);
    await lock.create("pin", "555555", FAST);
    const hello = authenticator("rsa");
    lock.addCredential({ type: "hello", label: "Windows Hello", credentialId: hello.credentialId, publicKey: hello.publicKey, algorithm: hello.algorithm, signCount: 0 });
    expect(lock.methods()[0]?.keyBound).toBe(false);
    lock.lock();
    const expected = expectation();
    const forged = authenticator("rsa").assert(expected);
    expect(lock.unlockWithAssertion({ ...forged, credentialId: hello.credentialId }, expected).ok).toBe(false);
    expect(lock.unlockWithAssertion(hello.assert(expected), expected)).toEqual({ ok: true });
  });

  it("removes the lock: secrets are written without the lock key again", async () => {
    const dir = tmp();
    const lock = new ProfileLock(dir, keychain);
    await lock.create("pin", "192837", FAST);
    const layered = lock.cipher.encryptString("x");
    lock.beginRemove();
    const plain = lock.cipher.encryptString("y");
    expect(keychain.decryptString(plain)).toBe("y");
    expect(lock.cipher.decryptString(layered)).toBe("x");
    lock.finishRemove();
    expect(lock.configured).toBe(false);
    expect(fs.existsSync(path.join(dir, "lock.json"))).toBe(false);
    expect(lock.cipher.decryptString(plain)).toBe("y");
  });
});

/** A profile folder with secrets in every store a lock seals. */
function profileStores(dir: string, cipher: SecretCipher) {
  const credentials = new CredentialVault(dir, cipher);
  const cards = new CardVault(dir, cipher);
  const keepass = new KeePassStore(dir, cipher, { watch: false });
  const connections = new ConnectionStore(dir, cipher);
  const wrapped: LockWrapped[] = [
    { rewrap: () => credentials.rewrap(), verify: () => credentials.verify(), reread: () => credentials.unload() },
    { rewrap: () => cards.rewrap(), verify: () => cards.verify(), reread: () => cards.unload() },
    { rewrap: () => keepass.rewrap(), verify: () => keepass.verify(), reread: () => keepass.reread() },
    { rewrap: () => connections.rewrap(), verify: () => connections.verify(), reread: () => connections.reread() },
  ];
  return { credentials, cards, keepass, connections, wrapped };
}

const FILES = ["credentials.json", "cards.json", "keepass.json", "connections.json"];

describe("adding and removing a lock", () => {
  it("seals every secret under the lock key, refuses them while locked, and gives them back unchanged", async () => {
    const dir = tmp();
    const lock = new ProfileLock(dir, keychain);
    const stores = profileStores(dir, lock.cipher);
    const login = stores.credentials.add({ origin: "https://example.com", username: "ana", password: "s3cret", totp: { secret: "JBSWY3DPEHPK3PXP", algorithm: "SHA1", digits: 6, period: 30 } });
    stores.cards.add({ number: "4111111111111111", nameOnCard: "Ana", expMonth: "12", expYear: "2030" });
    const proxy = stores.connections.saveProxy({ name: "work", kind: "http", host: "proxy.example.com", port: 8080, username: "u", password: "proxy-pw" });

    await lock.create("pin", "424242", FAST);
    rewrapAll(dir, FILES, stores.wrapped);
    lock.completeMigration();
    const vaultFile = JSON.parse(fs.readFileSync(path.join(dir, "credentials.json"), "utf8")) as { key: { data: string } };
    expect(keychain.decryptString(Buffer.from(vaultFile.key.data, "base64"))).toMatch(/^corvus-lk1:/);
    expect(fs.readdirSync(dir).some((f) => f.startsWith("lock-backup"))).toBe(false);

    lock.lock();
    stores.credentials.unload();
    stores.cards.unload();
    const before = fs.readFileSync(path.join(dir, "credentials.json"), "utf8");
    expect(() => stores.credentials.list()).toThrow(ProfileLockedError);
    expect(() => stores.credentials.add({ origin: "https://example.org", username: "x", password: "y" })).toThrow(ProfileLockedError);
    expect(() => stores.cards.all()).toThrow(ProfileLockedError);
    expect(stores.connections.password(proxy.id)).toBeNull();
    // A store opened while locked (a restart) neither reads as empty nor writes over the file.
    const reopened = new CredentialVault(dir, lock.cipher);
    expect(() => reopened.all()).toThrow(ProfileLockedError);
    reopened.flush();
    expect(fs.readFileSync(path.join(dir, "credentials.json"), "utf8")).toBe(before);

    expect(await lock.unlockWithSecret("424242")).toEqual({ ok: true });
    expect(stores.credentials.get(login.id)).toMatchObject({ username: "ana", password: "s3cret", totp: { secret: "JBSWY3DPEHPK3PXP" } });
    expect(reopened.get(login.id)?.password).toBe("s3cret");
    expect(stores.cards.all()).toHaveLength(1);
    expect(stores.connections.password(proxy.id)).toBe("proxy-pw");

    lock.beginRemove();
    rewrapAll(dir, FILES, stores.wrapped);
    lock.finishRemove();
    const plainFile = JSON.parse(fs.readFileSync(path.join(dir, "credentials.json"), "utf8")) as { key: { data: string } };
    expect(keychain.decryptString(Buffer.from(plainFile.key.data, "base64"))).not.toMatch(/^corvus-lk1:/);
    const after = profileStores(dir, keychain);
    expect(after.credentials.get(login.id)?.password).toBe("s3cret");
    expect(after.cards.all()).toHaveLength(1);
    expect(after.connections.password(proxy.id)).toBe("proxy-pw");
  });

  it("puts every file back when one store does not read back, and throws", async () => {
    const dir = tmp();
    const lock = new ProfileLock(dir, keychain);
    const stores = profileStores(dir, lock.cipher);
    const login = stores.credentials.add({ origin: "https://example.com", username: "ana", password: "pw" });
    const before = fs.readFileSync(path.join(dir, "credentials.json"), "utf8");
    await lock.create("pin", "777777", FAST);
    const broken: LockWrapped = { rewrap: () => undefined, verify: () => false, reread: () => undefined };
    expect(() => rewrapAll(dir, FILES, [...stores.wrapped, broken])).toThrow(/Nothing was changed/);
    expect(fs.readFileSync(path.join(dir, "credentials.json"), "utf8")).toBe(before);
    lock.beginRemove();
    lock.finishRemove();
    expect(new CredentialVault(dir, keychain).get(login.id)?.password).toBe("pw");
  });
});

describe("locking with the computer", () => {
  it("is off until turned on, kept in the lock file, and gone with the lock", async () => {
    const dir = tmp();
    const lock = new ProfileLock(dir, keychain);
    expect(() => lock.setLocksWithComputer(true)).toThrow();
    await lock.create("pin", "246810", FAST);
    expect(lock.locksWithComputer).toBe(false);
    lock.setLocksWithComputer(true);
    expect(new ProfileLock(dir, keychain).locksWithComputer).toBe(true);
    lock.setLocksWithComputer(false);
    expect(new ProfileLock(dir, keychain).locksWithComputer).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(dir, "lock.json"), "utf8"))).not.toHaveProperty("withComputer");
    lock.setLocksWithComputer(true);
    lock.beginRemove();
    lock.finishRemove();
    expect(lock.locksWithComputer).toBe(false);
  });

  it("tells its listeners when it changes (the watcher starts and stops with it)", async () => {
    const lock = new ProfileLock(tmp(), keychain);
    await lock.create("pin", "246810", FAST);
    let changes = 0;
    lock.onChange(() => changes++);
    lock.setLocksWithComputer(true);
    expect(changes).toBe(1);
  });
});

const key = (k: string, mods: Partial<KeyInput> = {}): KeyInput => ({ type: "keyDown", key: k, control: false, meta: false, shift: false, alt: false, ...mods });

describe("the lock shortcut", () => {
  const lock = { type: "lock-profile" };

  it("is Alt+L on Windows and Linux, like Win+L", () => {
    expect(commandForInput(key("l", { alt: true, code: "KeyL" }), "win32")).toEqual(lock);
    expect(commandForInput(key("L", { alt: true, code: "KeyL" }), "linux")).toEqual(lock);
    expect(commandForInput(key("l", { alt: true, shift: true }), "win32")).toBeNull();
    // AltGr is Ctrl+Alt on Windows: AltGr+L types a letter on some layouts (Polish ł).
    expect(commandForInput(key("ł", { alt: true, control: true, code: "KeyL" }), "win32")).not.toEqual(lock);
    expect(commandForInput({ ...key("l", { alt: true }), type: "keyUp" }, "win32")).toBeNull();
  });

  it("is ⌃⌘L on macOS: Option+L types a character there (@ on German keyboards)", () => {
    expect(commandForInput(key("l", { control: true, meta: true, code: "KeyL" }), "darwin")).toEqual(lock);
    expect(commandForInput(key("@", { alt: true, code: "KeyL" }), "darwin")).toBeNull();
    expect(commandForInput(key("¬", { alt: true, code: "KeyL" }), "darwin")).toBeNull();
    expect(commandForInput(key("l", { meta: true, code: "KeyL" }), "darwin")).toEqual({ type: "focus-omnibox" });
    expect(commandForInput(key("l", { alt: true, control: true, meta: true, code: "KeyL" }), "darwin")).not.toEqual(lock);
  });

  it("follows the key's letter, and its place only where the layout types no Latin letter", () => {
    // Russian: the L key types д.
    expect(commandForInput(key("д", { alt: true, code: "KeyL" }), "win32")).toEqual(lock);
    // Dvorak: the L key types N, and L sits elsewhere.
    expect(commandForInput(key("n", { alt: true, code: "KeyL" }), "win32")).toBeNull();
    expect(commandForInput(key("l", { alt: true, code: "KeyP" }), "linux")).toEqual(lock);
  });

  it("leaves Alt+H to the page now", () => {
    expect(commandForInput(key("h", { alt: true, code: "KeyH" }), "win32")).toBeNull();
    expect(commandForInput(key("˙", { alt: true, code: "KeyH" }), "darwin")).toBeNull();
  });

  it("is never left to the page first: a page cannot swallow it", () => {
    expect(isPageFirst({ type: "lock-profile" })).toBe(false);
    expect(pageCommand("lock-profile", Date.now(), Date.now())).toBeNull();
  });
});

describe("a locked window's state", () => {
  it("carries the lock screen and nothing of the profile's pages", () => {
    const lock = { profileId: "p1", name: "Work", kind: "pin" as const, methods: { totp: true, hello: false, fido2: false }, retryAt: null, profiles: [] };
    const state = lockedWindowState(
      {
        windowId: "w1",
        platform: "win32",
        profile: { id: "p1", name: "Work" },
        profiles: [{ id: "p1", name: "Work" }],
        partition: "persist:profile-p1",
        privateWindow: false,
        maximized: false,
        dark: false,
        tabLayout: "horizontal",
        sidebarWidth: 240,
        sidebarCollapsed: false,
        dialog: null,
      },
      lock,
    );
    expect(state.lock).toEqual(lock);
    expect(state.tabs).toEqual([]);
    expect(state.activeTabId).toBeNull();
    expect(state.bookmarksBar).toEqual([]);
    expect(state.downloads.recent).toEqual([]);
    expect(state.agentRun).toBeNull();
    expect(state.adblock.host).toBe("");
    // Nothing that looks like a page's address or title is anywhere in it.
    expect(JSON.stringify(state)).not.toMatch(/https?:\/\//);
  });
});

describe("reading wrapped values back", () => {
  it("takes a file never written as holding nothing, and refuses one that does not open", () => {
    const dir = tmp();
    const file = path.join(dir, "sync.json");
    const blobsOf = (raw: unknown): string[] => [(raw as { phrase: string }).phrase];
    expect(blobsReadBack(file, keychain, blobsOf, 0)).toBe(true);
    expect(blobsReadBack(file, keychain, blobsOf, 1)).toBe(false);
    fs.writeFileSync(file, JSON.stringify({ phrase: keychain.encryptString("words").toString("base64") }));
    expect(blobsReadBack(file, keychain, blobsOf, 1)).toBe(true);
    fs.writeFileSync(file, JSON.stringify({ phrase: Buffer.from("garbage").toString("base64") }));
    expect(blobsReadBack(file, keychain, blobsOf, 1)).toBe(false);
  });
});
