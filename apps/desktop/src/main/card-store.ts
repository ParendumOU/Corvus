import crypto from "node:crypto";
import { cleanCardFields, compareCapturedCard, isValidCard, type AutofillCard, type CardFields } from "../shared/cards";
import { SealedRecords } from "./sealed-records";
import type { SecretCipher } from "./settings-store";

/**
 * The profile's saved payment cards (cards.json), sealed at rest like the credential vault (see
 * sealed-records.ts) and synced end to end as the `cards` collection (see sync-adapters.ts). A card
 * never holds a CVV: isValidCard refuses any record with a field it does not know.
 */
export class CardVault {
  private readonly records: SealedRecords<AutofillCard>;
  readonly changes: SealedRecords<AutofillCard>["changes"];

  constructor(dir: string, cipher: SecretCipher) {
    this.records = new SealedRecords(dir, "cards.json", cipher, isValidCard);
    this.changes = this.records.changes;
  }

  get secretsPersisted(): boolean {
    return this.records.secretsPersisted;
  }

  /** Most recently used first, then most recently changed. */
  all(): AutofillCard[] {
    return this.records.all().sort((a, b) => b.lastUsedAt - a.lastUsedAt || b.updatedAt - a.updatedAt);
  }

  get(id: string): AutofillCard | null {
    return this.records.get(id);
  }

  /** A new card; throws when its number is not a card number. */
  add(f: Partial<CardFields>): AutofillCard {
    const now = Date.now();
    const card: AutofillCard = { ...cleanCardFields(f), id: crypto.randomUUID(), createdAt: now, updatedAt: now, lastUsedAt: 0, useCount: 0 };
    if (!this.records.put([{ id: card.id, record: card }])) throw new Error("A card needs a card number.");
    return card;
  }

  update(id: string, f: Partial<CardFields>): AutofillCard | null {
    const current = this.records.get(id);
    if (!current) return null;
    const next: AutofillCard = { ...current, ...cleanCardFields({ ...current, ...f }), updatedAt: Math.max(Date.now(), current.updatedAt + 1) };
    return this.records.put([{ id, record: next }]) ? next : null;
  }

  remove(id: string): boolean {
    return this.records.put([{ id, record: null }]);
  }

  /** The card was filled into a page. */
  noteUsed(id: string): void {
    const current = this.records.get(id);
    if (!current) return;
    this.records.put([{ id, record: { ...current, lastUsedAt: Date.now(), useCount: current.useCount + 1 } }]);
  }

  /** Cards from another browser: the same number updates the saved card, nothing is duplicated. */
  importMany(list: Partial<CardFields>[]): { added: number; updated: number; unchanged: number } {
    const result = { added: 0, updated: 0, unchanged: 0 };
    const now = Date.now();
    const working = new Map(this.records.all().map((c) => [c.id, c]));
    const changes = new Map<string, AutofillCard>();
    for (const raw of list) {
      const f = cleanCardFields(raw);
      if (!/^\d{12,19}$/.test(f.number)) continue;
      const found = compareCapturedCard(f, [...working.values()]);
      if (found.kind === "same") {
        result.unchanged++;
        continue;
      }
      if (found.kind === "update") {
        const current = working.get(found.id)!;
        const filled = Object.fromEntries(Object.entries(f).filter(([, v]) => v !== "")) as Partial<CardFields>;
        const next: AutofillCard = { ...current, ...filled, updatedAt: Math.max(now, current.updatedAt + 1) };
        working.set(next.id, next);
        changes.set(next.id, next);
        result.updated++;
        continue;
      }
      const card: AutofillCard = { ...f, id: crypto.randomUUID(), createdAt: now, updatedAt: now, lastUsedAt: 0, useCount: 0 };
      working.set(card.id, card);
      changes.set(card.id, card);
      result.added++;
    }
    this.records.put([...changes.values()].map((record) => ({ id: record.id, record })));
    return result;
  }

  /** Changes from the sync chain: the newer record wins (by updatedAt); null deletes. */
  applyRemote(changes: Array<{ id: string; card: AutofillCard | null }>): void {
    const apply: Array<{ id: string; record: AutofillCard | null }> = [];
    for (const { id, card } of changes) {
      if (card === null) apply.push({ id, record: null });
      else if (isValidCard({ ...card, id })) {
        const local = this.records.get(id);
        if (!local || card.updatedAt >= local.updatedAt) apply.push({ id, record: { ...card, id } });
      }
    }
    if (this.records.put(apply)) this.records.flush();
  }

  flush(): void {
    this.records.flush();
  }
}
