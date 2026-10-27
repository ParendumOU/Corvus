/**
 * Settles like `work`, or rejects with `onTimeout()` once `ms` pass first. The work itself is not
 * stopped (the caller cancels what it can in `onTimeout`): this only guarantees that whoever awaits
 * it is never left waiting forever on a promise that does not settle.
 */
export function withDeadline<T>(work: Promise<T>, ms: number, onTimeout: () => Error): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(onTimeout()), ms);
  });
  return Promise.race([work, expired]).finally(() => clearTimeout(timer));
}
