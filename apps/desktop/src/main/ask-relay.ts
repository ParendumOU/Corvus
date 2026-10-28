import { MAX_ANSWER, MAX_ASK_SOURCES, type Ask, type SearchEvent, type SearchTurn } from "@corvus/shared";

export interface AskRelayDeps {
  /**
   * The computer's AI search (quick depth), as corvus://search runs it; `context` holds the earlier
   * turns of the conversation when the question is a follow-up (empty otherwise).
   */
  stream(question: string, signal: AbortSignal, context: SearchTurn[]): AsyncIterable<SearchEvent>;
  /** Writes the record on the chain; false when the phone took the question back meanwhile. */
  push(ask: Ask): Promise<boolean>;
  /** This computer's name, shown on the phone. */
  deviceName: string;
  now(): number;
  /** How often the answer so far is written while it streams in (see progressDue). */
  progressMs?: number;
  signal?: AbortSignal;
}

/** A question still marked as being answered after this long lost its computer (Corvus quit). */
export const ASK_STALE_MS = 2 * 60_000;
/** Questions older than this are left unanswered. */
export const ASK_MAX_AGE_MS = 7 * 24 * 60 * 60_000;

/**
 * Whether this computer (device id `own`) should answer the question: a recent one sent to it that
 * waits, or that a computer started but stopped answering (Corvus quit meanwhile). Never one whose
 * answer the person stopped: that one is "done" and marked `stopped`.
 */
export function toAnswer(ask: Ask, own: string, now: number): boolean {
  if (ask.to !== own || ask.stopped || now - ask.askedAt >= ASK_MAX_AGE_MS) return false;
  return ask.state === "waiting" || (ask.state === "answering" && now - ask.updatedAt > ASK_STALE_MS);
}

/** The answer so far is written about this often while it streams in. */
export const PROGRESS_MS = 500;
/** ...or sooner when this much more text came, but never more often than PROGRESS_MIN_MS. */
export const PROGRESS_CHARS = 400;
export const PROGRESS_MIN_MS = 200;

/**
 * Whether the answer so far is worth writing now: its first words at once (what the person waits
 * for), then every `everyMs`, or after PROGRESS_CHARS more characters. Each write replaces the last
 * one on the chain (the phone reads whichever is newest), so the record's size stays one answer and
 * the sync server sees at most a few writes a second.
 */
export function progressDue(written: { at: number; length: number }, now: number, length: number, everyMs: number = PROGRESS_MS): boolean {
  if (length <= written.length) return false;
  if (written.length === 0) return true;
  const since = now - written.at;
  return since >= everyMs || (since >= PROGRESS_MIN_MS && length - written.length >= PROGRESS_CHARS);
}

/**
 * Answers one question from the phone with this computer's AI search: marks it as being answered,
 * writes the answer as it streams in (progressDue), then the whole answer with its
 * sources ([n] in the answer is sources[n - 1]) and follow-up questions. Stops when the phone
 * deletes the question (or stops its answer, which deletes it too): once a write finds it gone,
 * nothing is written again, so the question is never brought back. Returns the last state written.
 */
export async function answerAsk(ask: Ask, deps: AskRelayDeps): Promise<Ask> {
  const controller = new AbortController();
  const stop = (): void => controller.abort();
  deps.signal?.addEventListener("abort", stop, { once: true });
  const context = ask.context ?? [];
  // A follow-up says it was answered in its conversation's context (a phone tells older computers apart).
  let current: Ask = {
    ...ask,
    state: "answering",
    answer: "",
    sources: [],
    followUps: [],
    error: "",
    answeredBy: deps.deviceName,
    updatedAt: deps.now(),
    ...(context.length ? { withContext: true } : {}),
  };
  let written = { at: 0, length: 0 };
  let pushing: Promise<boolean> | null = null;
  const write = async (next: Ask): Promise<boolean> => {
    if (controller.signal.aborted) return false;
    current = { ...next, updatedAt: deps.now() };
    written = { at: current.updatedAt, length: next.answer.length };
    if (!(await deps.push(current))) {
      controller.abort();
      return false;
    }
    return true;
  };
  // Writes go one at a time: a last write waits for the progress write on its way, and is left out
  // when that one found the question gone.
  const settled = async (): Promise<boolean> => {
    if (pushing) await pushing.catch(() => false);
    return !controller.signal.aborted;
  };

  try {
    if (!(await write(current))) return current;
    let answer = "";
    let sources: Ask["sources"] = [];
    const followUps: string[] = [];
    for await (const event of deps.stream(ask.question, controller.signal, context)) {
      if (controller.signal.aborted) break;
      if (event.type === "results") {
        sources = event.results.slice(0, MAX_ASK_SOURCES).map((r) => ({ title: r.title.slice(0, 300), url: r.url }));
      } else if (event.type === "answer-delta") {
        answer = (answer + event.text).slice(0, MAX_ANSWER);
      } else if (event.type === "answer-done") {
        answer = event.text.slice(0, MAX_ANSWER);
      } else if (event.type === "follow-up" && followUps.length < 5) {
        followUps.push(event.question.slice(0, 300));
      } else if (event.type === "error" && !event.recoverable) {
        if (await settled()) await write({ ...current, state: "error", answer, sources, error: event.message.slice(0, 500) });
        return current;
      }
      // Progress while the answer streams in; the last write below carries the rest.
      if (event.type === "answer-delta" && !pushing && progressDue(written, deps.now(), answer.length, deps.progressMs)) {
        pushing = write({ ...current, answer, sources }).finally(() => {
          pushing = null;
        });
      }
    }
    if (!(await settled())) return current;
    if (!answer.trim()) {
      await write({ ...current, state: "error", sources, error: "The search found no answer." });
      return current;
    }
    await write({ ...current, state: "done", answer, sources, followUps });
    return current;
  } catch (err) {
    if (await settled()) await write({ ...current, state: "error", error: (err instanceof Error ? err.message : String(err)).slice(0, 500) }).catch(() => undefined);
    return current;
  } finally {
    deps.signal?.removeEventListener("abort", stop);
  }
}
