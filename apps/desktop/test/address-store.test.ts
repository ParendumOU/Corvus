import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AddressVault } from "../src/main/address-store";
import type { SecretCipher } from "../src/main/settings-store";
import { emptyAddressFields, type AddressFields, type AutofillAddress } from "../src/shared/addresses";

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "corvus-addresses-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const fields = (partial: Partial<AddressFields>): AddressFields => ({ ...emptyAddressFields(), ...partial });
const home = fields({ name: "Ana Ejemplo", street: "Calle Mayor 1", postalCode: "28001", city: "Madrid", phone: "600000000" });

describe("AddressVault", () => {
  it("keeps addresses across restarts, sealed on disk", () => {
    const dir = tmp();
    const vault = new AddressVault(dir, keychain);
    const a = vault.add(home);
    vault.flush();
    const raw = fs.readFileSync(path.join(dir, "addresses.json"), "utf8");
    expect(raw).not.toContain("Calle Mayor");
    expect(raw).not.toContain("600000000");
    const again = new AddressVault(dir, keychain);
    expect(again.get(a.id)?.street).toBe("Calle Mayor 1");
    expect(again.all()).toHaveLength(1);
  });

  it("writes nothing without a keychain", () => {
    const dir = tmp();
    const vault = new AddressVault(dir, noKeychain);
    vault.add(home);
    vault.flush();
    expect(vault.secretsPersisted).toBe(false);
    expect(fs.existsSync(path.join(dir, "addresses.json"))).toBe(false);
    expect(vault.all()).toHaveLength(1);
  });

  it("updates and removes, and announces each change", () => {
    const vault = new AddressVault(tmp(), keychain);
    let changes = 0;
    vault.changes.on(() => changes++);
    const a = vault.add(home);
    expect(vault.update(a.id, { phone: "699999999" })?.phone).toBe("699999999");
    expect(vault.update("missing", { phone: "1" })).toBeNull();
    expect(vault.remove(a.id)).toBe(true);
    expect(vault.remove(a.id)).toBe(false);
    expect(changes).toBe(3);
  });

  it("lists the most recently used first", () => {
    const vault = new AddressVault(tmp(), keychain);
    const a = vault.add(home);
    const b = vault.add(fields({ name: "Taller", street: "Avenida Buenos Aires 5", postalCode: "28002", city: "Madrid" }));
    vault.noteUsed(a.id);
    expect(vault.all().map((x) => x.id)).toEqual([a.id, b.id]);
    expect(vault.get(a.id)?.useCount).toBe(1);
  });

  it("imports without duplicates", () => {
    const vault = new AddressVault(tmp(), keychain);
    vault.add(home);
    const result = vault.importMany([home, fields({ ...home, phone: "699999999" }), fields({ name: "Ana", street: "Rua Nova 3", postalCode: "15001", city: "A Coruna" })]);
    expect(result).toEqual({ added: 1, updated: 1, unchanged: 1 });
    expect(vault.all()).toHaveLength(2);
  });

  it("imports another person at the same place as a new address, never over the saved one", () => {
    const vault = new AddressVault(tmp(), keychain);
    const a = vault.add(home);
    expect(vault.importMany([fields({ ...home, name: "Eva Prueba", phone: "611111111" })])).toEqual({ added: 1, updated: 0, unchanged: 0 });
    expect(vault.get(a.id)).toMatchObject({ name: "Ana Ejemplo", phone: "600000000" });
    expect(vault.all()).toHaveLength(2);
  });

  it("applies remote changes, keeping the newer one", () => {
    const vault = new AddressVault(tmp(), keychain);
    const a = vault.add(home);
    const older: AutofillAddress = { ...a, city: "Vigo", updatedAt: a.updatedAt - 1000 };
    vault.applyRemote([{ id: a.id, address: older }]);
    expect(vault.get(a.id)?.city).toBe("Madrid");
    const newer: AutofillAddress = { ...a, city: "Vigo", updatedAt: a.updatedAt + 1000 };
    vault.applyRemote([{ id: a.id, address: newer }]);
    expect(vault.get(a.id)?.city).toBe("Vigo");
    vault.applyRemote([{ id: a.id, address: null }]);
    expect(vault.get(a.id)).toBeNull();
  });
});
