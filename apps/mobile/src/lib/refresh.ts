/**
 * Keeps a refresh from ever wedging the app. A refresh reports each step it starts; when one makes
 * no progress for too long (a native call whose promise never settles, a stalled download), the
 * refresh fails with the step it was stuck on instead of leaving the home screen loading forever,
 * and the next pull to refresh starts a new one. Pure, so it unit-tests in Node.
 */
import type { SyncCollection } from '@corvus/shared';

import { t } from './i18n';

/** What a refresh is doing: listing the devices, downloading, saving a collection, wrapping up, preparing the view. */
export type RefreshStep = { kind: 'devices' } | { kind: 'download' } | { kind: 'save'; collection: SyncCollection } | { kind: 'finish' } | { kind: 'view' };

export type Progress = (step: RefreshStep) => void;

/** How long a refresh may go without progress before it is given up (longer than a request's timeout). */
export const REFRESH_IDLE_MS = 45_000;

/** The step in words, for the error the home screen shows and the log. */
export function describeStep(step: RefreshStep): string {
  switch (step.kind) {
    case 'devices':
      return t('listing your devices');
    case 'download':
      return t('downloading the changes');
    case 'save':
      return t('saving what was downloaded ({collection})', { collection: step.collection });
    case 'finish':
      return t('finishing the download');
    case 'view':
      return t('reading what is saved on the phone');
  }
}

export class RefreshStalled extends Error {
  constructor(
    readonly step: RefreshStep,
    readonly idleMs: number,
  ) {
    super(t('Refreshing stopped while {step}. Pull down to try again.', { step: describeStep(step) }));
    this.name = 'RefreshStalled';
  }
}

/**
 * Runs `work`, rejecting with RefreshStalled when it goes `idleMs` without reporting progress. Each
 * report restarts the clock, so a big chain that keeps moving is never cut short. The work is not
 * stopped (nothing can stop a stuck native call); its late result is ignored.
 */
export function watchdog<T>(work: (progress: Progress) => Promise<T>, idleMs: number = REFRESH_IDLE_MS): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let step: RefreshStep = { kind: 'devices' };
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = (): void => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        settled = true;
        reject(new RefreshStalled(step, idleMs));
      }, idleMs);
    };
    const progress: Progress = (next) => {
      if (settled) return;
      step = next;
      arm();
    };
    arm();
    let running: Promise<T>;
    try {
      running = work(progress);
    } catch (err) {
      running = Promise.reject(err);
    }
    running.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/** One run at a time: callers during a run share it; once it settles (always, with a watchdog), the next call starts anew. */
export class SingleFlight<T> {
  private current: Promise<T> | null = null;

  get running(): boolean {
    return this.current !== null;
  }

  run(start: () => Promise<T>): Promise<T> {
    if (this.current) return this.current;
    const run = (async () => start())().finally(() => {
      if (this.current === run) this.current = null;
    });
    this.current = run;
    return run;
  }
}
