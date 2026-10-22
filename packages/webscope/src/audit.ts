import type { AuditAction, AuditEntry } from "./types.js";

/**
 * Append-only audit log of security-relevant actions (scope/rules changes, repeater sends, fuzz runs).
 * Bounded so it never grows without limit; the newest entries are kept.
 */
export class AuditLog {
  private entries: AuditEntry[] = [];

  constructor(private readonly max = 2000) {}

  record(action: AuditAction, detail: string): AuditEntry {
    const entry: AuditEntry = { at: Date.now(), action, detail };
    this.entries.push(entry);
    if (this.entries.length > this.max) this.entries.splice(0, this.entries.length - this.max);
    return entry;
  }

  /** Most recent first. */
  list(limit = 200): AuditEntry[] {
    return this.entries.slice(-limit).reverse();
  }

  clear(): void {
    this.entries = [];
  }
}
