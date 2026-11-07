import crypto from "node:crypto";
import { cleanAddressFields, compareCaptured, isValidAddress, type AddressFields, type AutofillAddress } from "../shared/addresses";
import { SealedRecords } from "./sealed-records";
import type { SecretCipher } from "./settings-store";

/**
 * The profile's saved addresses (addresses.json), sealed at rest like the credential vault (see
 * sealed-records.ts) and synced end to end as the `addresses` collection (see sync-adapters.ts).
 */
export class AddressVault {
  private readonly records: SealedRecords<AutofillAddress>;
  readonly changes: SealedRecords<AutofillAddress>["changes"];

  constructor(dir: string, cipher: SecretCipher) {
    this.records = new SealedRecords(dir, "addresses.json", cipher, isValidAddress);
    this.changes = this.records.changes;
  }

  get secretsPersisted(): boolean {
    return this.records.secretsPersisted;
  }

  /** Most recently used first, then most recently changed. */
  all(): AutofillAddress[] {
    return this.records.all().sort((a, b) => b.lastUsedAt - a.lastUsedAt || b.updatedAt - a.updatedAt);
  }

  get(id: string): AutofillAddress | null {
    return this.records.get(id);
  }

  /** A new address; throws when it holds nothing worth keeping (see isValidAddress). */
  add(f: Partial<AddressFields>): AutofillAddress {
    const now = Date.now();
    const address: AutofillAddress = { ...cleanAddressFields(f), id: crypto.randomUUID(), createdAt: now, updatedAt: now, lastUsedAt: 0, useCount: 0 };
    if (!this.records.put([{ id: address.id, record: address }])) throw new Error("An address needs a name, street, postal code, phone or e-mail.");
    return address;
  }

  update(id: string, f: Partial<AddressFields>): AutofillAddress | null {
    const current = this.records.get(id);
    if (!current) return null;
    const next: AutofillAddress = { ...current, ...cleanAddressFields({ ...current, ...f }), updatedAt: Math.max(Date.now(), current.updatedAt + 1) };
    return this.records.put([{ id, record: next }]) ? next : null;
  }

  remove(id: string): boolean {
    return this.records.put([{ id, record: null }]);
  }

  /** The address was filled into a page. */
  noteUsed(id: string): void {
    const current = this.records.get(id);
    if (!current) return;
    this.records.put([{ id, record: { ...current, lastUsedAt: Date.now(), useCount: current.useCount + 1 } }]);
  }

  /** Addresses from another browser: the same place updates the saved one, nothing is duplicated. */
  importMany(list: Partial<AddressFields>[]): { added: number; updated: number; unchanged: number } {
    const result = { added: 0, updated: 0, unchanged: 0 };
    const now = Date.now();
    const working = new Map(this.records.all().map((a) => [a.id, a]));
    const changes = new Map<string, AutofillAddress>();
    for (const raw of list) {
      const f = cleanAddressFields(raw);
      const found = compareCaptured(f, [...working.values()]);
      if (found.kind === "same") {
        result.unchanged++;
        continue;
      }
      if (found.kind === "update") {
        const current = working.get(found.id)!;
        const filled = Object.fromEntries(Object.entries(f).filter(([, v]) => v !== "")) as Partial<AddressFields>;
        const next: AutofillAddress = { ...current, ...filled, updatedAt: Math.max(now, current.updatedAt + 1) };
        if (!isValidAddress(next)) continue;
        working.set(next.id, next);
        changes.set(next.id, next);
        result.updated++;
        continue;
      }
      const address: AutofillAddress = { ...f, id: crypto.randomUUID(), createdAt: now, updatedAt: now, lastUsedAt: 0, useCount: 0 };
      if (!isValidAddress(address)) continue;
      working.set(address.id, address);
      changes.set(address.id, address);
      result.added++;
    }
    this.records.put([...changes.values()].map((record) => ({ id: record.id, record })));
    return result;
  }

  /** Changes from the sync chain: the newer record wins (by updatedAt); null deletes. */
  applyRemote(changes: Array<{ id: string; address: AutofillAddress | null }>): void {
    const apply: Array<{ id: string; record: AutofillAddress | null }> = [];
    for (const { id, address } of changes) {
      if (address === null) apply.push({ id, record: null });
      else if (isValidAddress(address)) {
        const local = this.records.get(id);
        if (!local || address.updatedAt >= local.updatedAt) apply.push({ id, record: { ...address, id } });
      }
    }
    if (this.records.put(apply)) this.records.flush();
  }

  /** See SealedRecords: drop what is decrypted (the profile locked), wrap the key again, check the file. */
  unload(): void {
    this.records.unload();
  }

  rewrap(): void {
    this.records.rewrap();
  }

  verify(): boolean {
    return this.records.verify();
  }

  flush(): void {
    this.records.flush();
  }
}
