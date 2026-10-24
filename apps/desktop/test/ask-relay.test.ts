import { newAsk, type Ask, type SearchEvent } from "@corvus/shared";
import { describe, expect, it } from "vitest";
import { answerAsk } from "../src/main/ask-relay";

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
