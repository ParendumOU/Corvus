import { MAX_CONTEXT_ANSWER, newAsk, parseAsk, stoppedAsk, type Ask, type SearchEvent } from "@corvus/shared";
import { describe, expect, it } from "vitest";
import { ASK_MAX_AGE_MS, ASK_STALE_MS, PROGRESS_CHARS, PROGRESS_MS, answerAsk, progressDue, toAnswer } from "../src/main/ask-relay";

const PHONE = "phone-0000-0001";
const DESK = "desk-0000-0001";
const question = newAsk("How long do ravens live?", DESK, PHONE, "Pixel", 1000);
const result = (n: number) => ({ url: `https://r${n}.example/`, title: `Result ${n}`, snippet: "", source: `r${n}.example`, rank: n });

async function* events(list: SearchEvent[]): AsyncIterable<SearchEvent> {
  for (const e of list) yield e;
}

function relay(list: SearchEvent[], opts: { gone?: (ask: Ask, n: number) => boolean } = {}) {
  const pushed: Ask[] = [];
  let clock = 2000;
  const done = answerAsk(question, {
    stream: () => events(list),
    push: async (ask) => {
      pushed.push(ask);
      return !(opts.gone?.(ask, pushed.length) ?? false);
    },
    deviceName: "Desk",
    // Every call moves the clock on, so progress is written between deltas.
    now: () => (clock += 500),
    progressMs: 1000,
  });
  return { pushed, done };
}

describe("answering a question from the phone", () => {
  it("marks it, streams the answer, then writes it whole with sources and follow-ups", async () => {
    const { pushed, done } = relay([
      { type: "results", results: [result(1), result(2)], retriever: "searxng", cached: false },
      { type: "answer-delta", text: "Ravens live " },
      { type: "answer-delta", text: "10-15 years [1]" },
      { type: "answer-delta", text: " in the wild [2]." },
      { type: "answer-done", text: "Ravens live 10-15 years [1] in the wild [2].", citations: [0, 1] },
      { type: "follow-up", question: "Do ravens mate for life?" },
    ]);
    const last = await done;
    expect(pushed[0]).toMatchObject({ state: "answering", answeredBy: "Desk", answer: "" });
    expect(pushed.slice(1, -1).every((a) => a.state === "answering" && a.answer.length > 0)).toBe(true);
    expect(last).toMatchObject({
      state: "done",
      question: "How long do ravens live?",
      answer: "Ravens live 10-15 years [1] in the wild [2].",
      sources: [
        { title: "Result 1", url: "https://r1.example/" },
        { title: "Result 2", url: "https://r2.example/" },
      ],
      followUps: ["Do ravens mate for life?"],
      answeredBy: "Desk",
    });
    expect(pushed.at(-1)).toEqual(last);
  });

  it("reports the search's error", async () => {
    const { done } = relay([{ type: "error", message: "No AI provider is set up.", recoverable: false }]);
    expect(await done).toMatchObject({ state: "error", error: "No AI provider is set up." });
  });

  it("says so when no answer came", async () => {
    const { done } = relay([{ type: "results", results: [], retriever: "searxng", cached: false }]);
    expect(await done).toMatchObject({ state: "error", error: "The search found no answer." });
  });

  it("stops when the phone took the question back", async () => {
    const { pushed, done } = relay(
      [
        { type: "answer-delta", text: "a" },
        { type: "answer-delta", text: "b" },
        { type: "answer-done", text: "ab", citations: [] },
      ],
      { gone: (_ask, n) => n === 1 },
    );
    await done;
    expect(pushed).toHaveLength(1);
  });
});

describe("a question the phone takes back or stops", () => {
  const later = (ms: number) => new Promise((r) => setTimeout(r, ms));
  async function* slow(list: SearchEvent[]): AsyncIterable<SearchEvent> {
    for (const e of list) {
      await later(5);
      yield e;
    }
  }

  it("writes nothing more once a write finds it gone, not even the error or the whole answer", async () => {
    for (const end of [
      { type: "error", message: "The provider failed.", recoverable: false },
      { type: "answer-done", text: "abcd", citations: [] },
    ] as SearchEvent[]) {
      const pushed: Ask[] = [];
      let clock = 0;
      await answerAsk(question, {
        // The question is deleted while the first piece of the answer is on its way: that write
        // learns it slowly, after the search has already ended.
        stream: () => slow([{ type: "answer-delta", text: "ab" }, end]),
        push: async (ask) => {
          pushed.push(ask);
          if (pushed.length === 1) return true;
          await later(40);
          return false;
        },
        deviceName: "Desk",
        now: () => (clock += 1000),
      });
      expect(pushed.map((a) => a.state)).toEqual(["answering", "answering"]);
    }
  });

  it("answers only questions that wait for this computer, never a stopped one", () => {
    const now = 10 * ASK_STALE_MS;
    const waiting = newAsk("Why?", DESK, PHONE, "Pixel", now - 1000);
    expect(toAnswer(waiting, DESK, now)).toBe(true);
    expect(toAnswer(waiting, "desk-0000-0002", now)).toBe(false);
    expect(toAnswer({ ...waiting, askedAt: now - ASK_MAX_AGE_MS }, DESK, now)).toBe(false);
    expect(toAnswer({ ...waiting, state: "answering", updatedAt: now - 1000 }, DESK, now)).toBe(false);
    expect(toAnswer({ ...waiting, state: "answering", updatedAt: now - ASK_STALE_MS - 1 }, DESK, now)).toBe(true);
    expect(toAnswer({ ...waiting, state: "done" }, DESK, now)).toBe(false);
    const stopped = parseAsk(JSON.parse(JSON.stringify(stoppedAsk({ id: "11111111-1111-4111-8111-111111111111", ...waiting, state: "answering", answer: "Because" }, now))))!;
    expect(stopped).toMatchObject({ state: "done", stopped: true, answer: "Because" });
    expect(toAnswer(stopped, DESK, now)).toBe(false);
    // Even one that says it waits.
    expect(toAnswer({ ...stopped, state: "waiting" }, DESK, now)).toBe(false);
  });
});

describe("follow-up questions from the phone", () => {
  const context = [{ question: "How long do ravens live?", answer: "10 to 15 years in the wild [1]." }];

  it("answers a follow-up with the earlier turns, and says it did", async () => {
    const seen: unknown[] = [];
    const followUp = newAsk("And in captivity?", DESK, PHONE, "Pixel", 1000, { thread: "11111111-1111-4111-8111-111111111111", context });
    let clock = 2000;
    const last = await answerAsk(followUp, {
      stream: (_q, _signal, ctx) => {
        seen.push(ctx);
        return events([{ type: "answer-done", text: "Up to 40 years.", citations: [] }]);
      },
      push: async () => true,
      deviceName: "Desk",
      now: () => (clock += 500),
    });
    expect(seen).toEqual([context]);
    expect(last).toMatchObject({ state: "done", answer: "Up to 40 years.", withContext: true, thread: "11111111-1111-4111-8111-111111111111", context });
  });

  it("answers a first question with no context and no withContext flag", async () => {
    const seen: unknown[] = [];
    const last = await answerAsk(question, {
      stream: (_q, _signal, ctx) => {
        seen.push(ctx);
        return events([{ type: "answer-done", text: "ok", citations: [] }]);
      },
      push: async () => true,
      deviceName: "Desk",
      now: () => 5000,
    });
    expect(seen).toEqual([[]]);
    expect(last.withContext).toBeUndefined();
  });

  it("reads conversation fields from the chain, and records from older phones as before", () => {
    const raw = {
      ...newAsk("And in captivity?", DESK, PHONE, "Pixel", 1000),
      thread: "11111111-1111-4111-8111-111111111111",
      context: [...Array.from({ length: 6 }, (_, i) => ({ question: `q${i}`, answer: "a".repeat(5000) })), { question: "  ", answer: "x" }, "junk"],
      origin: { conversation: "demo-assist-lisbon", title: "Lisbon", url: "javascript:alert(1)" },
      withContext: "yes",
    };
    const ask = parseAsk(raw)!;
    expect(ask.context!.map((t) => t.question)).toEqual(["q2", "q3", "q4", "q5"]);
    expect(ask.context![0]!.answer).toHaveLength(MAX_CONTEXT_ANSWER);
    expect(ask.origin).toEqual({ conversation: "demo-assist-lisbon", title: "Lisbon", url: "" });
    expect(ask.withContext).toBeUndefined();
    expect(parseAsk({ ...raw, thread: "not an id" })!.thread).toBeUndefined();
    const old = parseAsk(newAsk("Alone?", DESK, PHONE, "Pixel", 1))!;
    expect(Object.keys(old)).not.toContain("thread");
    expect(Object.keys(old)).not.toContain("context");
  });
});

describe("when the answer so far is written", () => {
  it("writes the first words at once", () => {
    expect(progressDue({ at: 1000, length: 0 }, 1001, 3)).toBe(true);
    expect(progressDue({ at: 1000, length: 0 }, 1001, 0)).toBe(false);
  });

  it("then about every PROGRESS_MS, or sooner after many characters", () => {
    const written = { at: 1000, length: 50 };
    expect(progressDue(written, 1000 + PROGRESS_MS - 1, 60)).toBe(false);
    expect(progressDue(written, 1000 + PROGRESS_MS, 60)).toBe(true);
    expect(progressDue(written, 1300, 50 + PROGRESS_CHARS)).toBe(true);
    // Never several times in a burst.
    expect(progressDue(written, 1050, 50 + PROGRESS_CHARS * 3)).toBe(false);
  });

  it("does not write the same text again", () => {
    expect(progressDue({ at: 0, length: 50 }, 10_000, 50)).toBe(false);
  });

  it("streams a long answer in several growing writes, the last one done", async () => {
    const words = Array.from({ length: 40 }, (_, i) => ({ type: "answer-delta" as const, text: `word${i} ` }));
    const { pushed, done } = relay([...words, { type: "answer-done", text: words.map((w) => w.text).join(""), citations: [] }]);
    await done;
    const partial = pushed.filter((a) => a.state === "answering" && a.answer);
    expect(partial.length).toBeGreaterThan(3);
    expect(partial[0]!.answer).toBe("word0 ");
    for (let i = 1; i < partial.length; i++) expect(partial[i]!.answer.length).toBeGreaterThan(partial[i - 1]!.answer.length);
    expect(pushed.at(-1)!.state).toBe("done");
  });
});
