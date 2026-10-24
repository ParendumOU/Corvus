/**
 * A record this device publishes about itself (per-device sync collections). Its `updatedAt` only
 * moves when the content changes, so an unchanged state never produces a new record (the sync
 * engine diffs by payload fingerprint).
 */
export class StampedRecord<T extends object> {
  private current: (T & { updatedAt: number }) | null = null;

  constructor(
    private readonly source: () => T,
    private readonly now: () => number = Date.now,
  ) {}

  record(): T & { updatedAt: number } {
    const next = this.source();
    if (!this.current || JSON.stringify({ ...this.current, updatedAt: 0 }) !== JSON.stringify({ ...next, updatedAt: 0 })) {
      this.current = { ...next, updatedAt: this.now() };
    }
    return this.current;
  }
}
