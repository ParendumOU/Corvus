export type MergedItem<K, T> = { key: K; value: T } | { key: K; done: true } | { key: K; error: unknown };

/**
 * Reads several streams at once and yields their items as they come, each tagged with its key.
 * A stream that ends yields `done`; one that throws yields `error` and the others keep going.
 * Stopping early closes the streams that are still open.
 */
export async function* mergeStreams<K, T>(sources: ReadonlyArray<readonly [K, AsyncIterable<T>]>): AsyncGenerator<MergedItem<K, T>> {
  const streams = sources.map(([key, source]) => ({ key, it: source[Symbol.asyncIterator]() }));
  type Step = { i: number; result: IteratorResult<T> } | { i: number; error: unknown };
  const pending = new Map<number, Promise<Step>>();
  const pull = (i: number): void => {
    pending.set(
      i,
      streams[i]!.it.next().then(
        (result) => ({ i, result }),
        (error: unknown) => ({ i, error }),
      ),
    );
  };
  const open = new Set(streams.keys());
  streams.forEach((_, i) => pull(i));
  try {
    while (pending.size) {
      const step = await Promise.race(pending.values());
      pending.delete(step.i);
      const key = streams[step.i]!.key;
      if ("error" in step || step.result.done) {
        open.delete(step.i);
        yield "error" in step ? { key, error: step.error } : { key, done: true };
      } else {
        yield { key, value: step.result.value };
        pull(step.i);
      }
    }
  } finally {
    for (const i of open) void streams[i]!.it.return?.(undefined)?.catch(() => undefined);
  }
}
