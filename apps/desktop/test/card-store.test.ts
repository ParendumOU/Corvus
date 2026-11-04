import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CardVault } from "../src/main/card-store";
import type { SecretCipher } from "../src/main/settings-store";
import { emptyCardFields, type AutofillCard, type CardFields } from "../src/shared/cards";

const keychain: SecretCipher = {
  isEncryptionAvailable: () => true,
  encryptString: (plain) => Buffer.from(`enc:${plain}`),
  decryptString: (enc) => enc.toString().slice(4),
};

const noKeychain: SecretCipher = {
  isEncryptionAvailable: () => false,
  encryptString: () => {
    throw new Error("unavailable");
  },
  decryptString: () => {
    throw new Error("unavailable");
  },
};

const dirs: string[] = [];
function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "corvus-cards-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const VISA = "4111111111111111";
const MASTERCARD = "5555555555554444";
const fields = (partial: Partial<CardFields>): CardFields => ({ ...emptyCardFields(), ...partial });
const visa = fields({ number: VISA, nameOnCard: "Ana Example", expMonth: "08", expYear: "2028" });

describe("CardVault", () => {
  it("keeps cards across restarts, sealed on disk", () => {
    const dir = tmp();
    const vault = new CardVault(dir, keychain);
    const card = vault.add(visa);
    vault.flush();
    const raw = fs.readFileSync(path.join(dir, "cards.json"), "utf8");
    expect(raw).not.toContain(VISA);
    expect(raw).not.toContain("Ana Example");
    expect(new CardVault(dir, keychain).get(card.id)).toEqual(card);
  });

  it("runs memory-only without a keychain", () => {
    const dir = tmp();
    const vault = new CardVault(dir, noKeychain);
    vault.add(visa);
    vault.flush();
    expect(vault.secretsPersisted).toBe(false);
    expect(fs.existsSync(path.join(dir, "cards.json")) ? fs.readFileSync(path.join(dir, "cards.json"), "utf8") : "").not.toContain(VISA);
  });

  it("refuses a card without a valid number and never keeps a CVV", () => {
    const vault = new CardVault(tmp(), keychain);
    expect(() => vault.add(fields({ number: "1234" }))).toThrow();
    const card = vault.add({ ...visa, cvv: "123" } as never);
    expect(Object.keys(card)).not.toContain("cvv");
  });

  it("updates, notes use, lists most recently used first, and removes", () => {
    const vault = new CardVault(tmp(), keychain);
    const a = vault.add(visa);
    const b = vault.add(fields({ number: MASTERCARD }));
    vault.noteUsed(a.id);
    expect(vault.all().map((c) => c.id)).toEqual([a.id, b.id]);
    expect(vault.get(a.id)?.useCount).toBe(1);
    const updated = vault.update(a.id, { expMonth: "09", expYear: "2031" });
    expect(updated).toMatchObject({ number: VISA, expMonth: "09", expYear: "2031", nameOnCard: "Ana Example" });
    expect(updated!.updatedAt).toBeGreaterThan(a.updatedAt);
    expect(vault.update(a.id, { number: "12" })).toBeNull();
    expect(vault.remove(b.id)).toBe(true);
    expect(vault.all().map((c) => c.id)).toEqual([a.id]);
  });

  it("imports without duplicates: the same number updates the saved card", () => {
    const vault = new CardVault(tmp(), keychain);
    vault.add(visa);
    expect(vault.importMany([visa, fields({ number: VISA, expMonth: "10", expYear: "2030" }), fields({ number: MASTERCARD, nameOnCard: "Bob" }), fields({ number: MASTERCARD }), fields({ number: "12" })])).toEqual({ added: 1, updated: 1, unchanged: 2 });
    expect(vault.all()).toHaveLength(2);
    expect(vault.all().find((c) => c.number === VISA)).toMatchObject({ expMonth: "10", expYear: "2030", nameOnCard: "Ana Example" });
  });

  it("applies remote changes: newer wins, null deletes, a record with a CVV is refused", () => {
    const vault = new CardVault(tmp(), keychain);
    const local = vault.add(visa);
    const older: AutofillCard = { ...local, nameOnCard: "Old", updatedAt: local.updatedAt - 1 };
    vault.applyRemote([{ id: local.id, card: older }]);
    expect(vault.get(local.id)?.nameOnCard).toBe("Ana Example");
    const newer: AutofillCard = { ...local, nameOnCard: "New", updatedAt: local.updatedAt + 1 };
    vault.applyRemote([{ id: local.id, card: newer }]);
    expect(vault.get(local.id)?.nameOnCard).toBe("New");
    vault.applyRemote([{ id: "x", card: { ...newer, id: "x", cvv: "123" } as never }]);
    expect(vault.get("x")).toBeNull();
    vault.applyRemote([{ id: local.id, card: null }]);
    expect(vault.all()).toEqual([]);
  });
});
