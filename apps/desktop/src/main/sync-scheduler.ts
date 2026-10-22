export interface SyncSchedulerOptions {
  /** One sync cycle. Errors are the caller's to record; the scheduler only sequences runs. */
  run: () => Promise<unknown>;
  /** Quiet period after the last local change before syncing. */
  debounceMs: number;
  /** Upper bound on how long a stream of changes can postpone a sync. */
  maxWaitMs: number;
  /** Periodic sync, measured from the end of the previous run. 0 disables it. */
  intervalMs: number;
}

/**
 * When to sync one profile: shortly after local changes (debounced), periodically, or on demand.
 * Runs never overlap; a change that arrives during a run schedules another one.
 */
export class SyncScheduler {
  private debounce: ReturnType<typeof setTimeout> | null = null;
  private periodic: ReturnType<typeof setTimeout> | null = null;
  private firstChangeAt: number | null = null;
  private running: Promise<void> | null = null;
  private stopped = false;

  constructor(
    private readonly opts: SyncSchedulerOptions,
    private readonly now: () => number = Date.now,
  ) {
    this.armPeriodic();
  }

  get busy(): boolean {
    return this.running !== null;
  }

  /** A local change happened. */
  poke(): void {
    if (this.stopped) return;
    const t = this.now();
    this.firstChangeAt ??= t;
    const wait = Math.max(0, Math.min(this.opts.debounceMs, this.firstChangeAt + this.opts.maxWaitMs - t));
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => {
      this.debounce = null;
      void this.trigger();
    }, wait);
  }

  setIntervalMs(ms: number): void {
    this.opts.intervalMs = ms;
    this.armPeriodic();
  }

  /** Sync now. If a run is in progress, waits for it and then runs again. */
  async trigger(): Promise<void> {
    if (this.stopped) return;
    if (this.running) {
      await this.running;
      if (this.running) return this.running;
      if (this.stopped) return;
    }
    if (this.debounce) {
      clearTimeout(this.debounce);
      this.debounce = null;
    }
    this.firstChangeAt = null;
    this.running = this.opts
      .run()
      .then(
        () => undefined,
        () => undefined,
      )
      .finally(() => {
        this.running = null;
        this.armPeriodic();
      });
    return this.running;
  }

  /** Resolves once no cycle is running (use after stop() to hand over cleanly). */
  async idle(): Promise<void> {
    while (this.running) await this.running.catch(() => undefined);
  }

  stop(): void {
    this.stopped = true;
    if (this.debounce) clearTimeout(this.debounce);
    if (this.periodic) clearTimeout(this.periodic);
    this.debounce = null;
    this.periodic = null;
  }

  private armPeriodic(): void {
    if (this.periodic) clearTimeout(this.periodic);
    this.periodic = null;
    if (this.stopped || this.opts.intervalMs <= 0) return;
    this.periodic = setTimeout(() => {
      this.periodic = null;
      void this.trigger();
    }, this.opts.intervalMs);
    this.periodic.unref?.();
  }
}
