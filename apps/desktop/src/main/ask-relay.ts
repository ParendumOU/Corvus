import { MAX_ANSWER, MAX_ASK_SOURCES, type Ask, type SearchEvent } from "@corvus/shared";

export interface AskRelayDeps {
  /** The computer's AI search (quick depth), as corvus://search runs it. */
  stream(question: string, signal: AbortSignal): AsyncIterable<SearchEvent>;
  /** Writes the record on the chain; false when the phone took the question back meanwhile. */
  push(ask: Ask): Promise<boolean>;
  /** This computer's name, shown on the phone. */
  deviceName: string;
  now(): number;
  /** How often the answer so far is written while it streams in. */
  progressMs?: number;
  signal?: AbortSignal;
}

const PROGRESS_MS = 1200;

/**
 * Answers one question from the phone with this computer's AI search: marks it as being answered,
 * writes the answer as it streams in (at most every `progressMs`), then the whole answer with its
 * sources ([n] in the answer is sources[n - 1]) and follow-up questions. Stops when the phone
 * deletes the question. Returns the last state written.
 */
export async function answerAsk(ask: Ask, deps: AskRelayDeps): Promise<Ask> {
  const controller = new AbortController();
  const stop = (): void => controller.abort();
  deps.signal?.addEventListener("abort", stop, { once: true });
  let current: Ask = { ...ask, state: "answering", answer: "", sources: [], followUps: [], error: "", answeredBy: deps.deviceName, updatedAt: deps.now() };
  let lastPush = 0;
  let pushing: Promise<boolean> | null = null;
  const write = async (next: Ask): Promise<boolean> => {
    current = { ...next, updatedAt: deps.now() };
    lastPush = deps.now();
    if (!(await deps.push(current))) {
      controller.abort();
      return false;
    }
    return true;
  };

  try {
    if (!(await write(current))) return current;
    let answer = "";
    let sources: Ask["sources"] = [];
    const followUps: string[] = [];
    for await (const event of deps.stream(ask.question, controller.signal)) {
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
        await write({ ...current, state: "error", answer, sources, error: event.message.slice(0, 500) });
        return current;
      }
      // Progress while the answer streams in; the last write below carries the rest.
      if (event.type === "answer-delta" && !pushing && deps.now() - lastPush >= (deps.progressMs ?? PROGRESS_MS)) {
        pushing = write({ ...current, answer, sources }).finally(() => {
          pushing = null;
        });
      }
    }
    if (pushing) await pushing;
    if (controller.signal.aborted) return current;
    if (!answer.trim()) {
      await write({ ...current, state: "error", sources, error: "The search found no answer." });
      return current;
    }
    await write({ ...current, state: "done", answer, sources, followUps });
    return current;
  } catch (err) {
    if (!controller.signal.aborted) await write({ ...current, state: "error", error: (err instanceof Error ? err.message : String(err)).slice(0, 500) }).catch(() => undefined);
    return current;
  } finally {
    deps.signal?.removeEventListener("abort", stop);
  }
}
