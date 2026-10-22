/** Fixed-window counter per key. In-memory: one server process per database. */
export class RateLimiter {
  private readonly windows = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  /** Returns 0 if allowed, otherwise the number of ms until the window resets. */
  hit(key: string, now: number): number {
    if (this.windows.size > 100_000) this.prune(now);
    let w = this.windows.get(key);
    if (!w || w.resetAt <= now) {
      w = { count: 0, resetAt: now + this.windowMs };
      this.windows.set(key, w);
    }
    w.count++;
    return w.count > this.limit ? w.resetAt - now : 0;
  }

  private prune(now: number): void {
    for (const [key, w] of this.windows) if (w.resetAt <= now) this.windows.delete(key);
  }
}

/** Remembers verified signatures until they can no longer pass the clock-skew check. */
export class ReplayCache {
  private readonly seen = new Map<string, number>();

  constructor(private readonly ttlMs: number) {}

  /** Returns false if the signature was already used. */
  checkAndRemember(signature: string, now: number): boolean {
    for (const [sig, expiresAt] of this.seen) {
      if (expiresAt > now) break;
      this.seen.delete(sig);
    }
    if (this.seen.has(signature)) return false;
    this.seen.set(signature, now + this.ttlMs);
    return true;
  }
}
