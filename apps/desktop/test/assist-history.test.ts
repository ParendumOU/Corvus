import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AssistMessage } from "../src/shared/assist-ipc";
import { MAX_CONVERSATIONS, keptMessages, matchesConversation, reviveConversation, summarizeConversation, type AssistConversation } from "../src/shared/assist-history";
import { AssistHistoryStore } from "../src/main/assist-history-store";

const msg = (id: string, patch: Partial<AssistMessage> = {}): AssistMessage => ({ id, kind: "ask", prompt: "", text: "", status: "done", at: 1, ...patch });

const conversation = (id: string, updatedAt: number, messages: AssistMessage[] = [msg("m1", { prompt: "cheapest flight to Lisbon", text: "Vueling, 111 €" })]): AssistConversation => ({
  id,
  url: "https://www.google.com/travel/flights",
  pageTitle: "Google Flights",
  createdAt: 1,
  updatedAt,
  messages,
});

describe("keptMessages", () => {
  it("keeps finished conversation turns without screenshots or pending prompts", () => {
    const kept = keptMessages([
      msg("a", { kind: "summarize" }),
      msg("b", { kind: "translate-page" }),
      msg("c", { kind: "write" }),
      msg("d", {
        prompt: "find a flight",
        agent: {
          runId: "r",
          status: "done",
          steps: [{ id: "s1", kind: "screenshot", label: "Took a screenshot", status: "ok", thumb: "data:image/jpeg;base64,AAAA" }],
          approval: { id: "x", tool: "click", summary: "", reason: "", handoff: false },
          stepCount: 1,
          maxSteps: 40,
          limit: null,
          takenOver: true,
          leftTabs: [{ id: "t5", title: "Flights", url: "https://www.google.com/travel/flights" }],
        },
      }),
      msg("e", { status: "streaming" }),
    ]);
    expect(kept.map((m) => m.id)).toEqual(["a", "d"]);
    expect(kept[1]!.agent!.steps[0]).not.toHaveProperty("thumb");
    expect(kept[1]!.agent!.approval).toBeNull();
    expect(kept[1]!.agent).not.toHaveProperty("takenOver");
    expect(kept[1]!.agent!.leftTabs?.[0]?.url).toBe("https://www.google.com/travel/flights");
  });
});

describe("conversation summaries", () => {
  it("are named by the first question and found by words of it, the page or its address", () => {
    const s = summarizeConversation(conversation("c1", 5, [msg("m0", { kind: "summarize" }), msg("m1", { prompt: "  cheapest   flight to Lisbon " })]));
    expect(s).toMatchObject({ id: "c1", title: "cheapest flight to Lisbon", kind: "summarize", count: 2, updatedAt: 5 });
    expect(matchesConversation(s, "lisbon google")).toBe(true);
    expect(matchesConversation(s, "travel/flights")).toBe(true);
    expect(matchesConversation(s, "madrid")).toBe(false);
    expect(summarizeConversation(conversation("c2", 5, [msg("m0", { kind: "summarize" })])).title).toBe("");
  });

  it("are read back only when they are conversations; an unfinished turn reads as cancelled", () => {
    expect(reviveConversation({ id: "x", url: "https://a.example/", messages: [] })).toBeNull();
    expect(reviveConversation({ id: "x", messages: [msg("m")] })).toBeNull();
    const back = reviveConversation({ id: "x", url: "https://a.example/", messages: [msg("m", { status: "streaming" }), { id: 3 }] });
    expect(back?.messages).toHaveLength(1);
    expect(back?.messages[0]?.status).toBe("cancelled");
  });
});

describe("AssistHistoryStore", () => {
  it("keeps the newest first, replaces by id, forgets and survives a restart", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "corvus-assist-history-"));
    try {
      const store = new AssistHistoryStore(dir);
      store.save(conversation("a", 1));
      store.save(conversation("b", 2));
      store.save(conversation("a", 3));
      expect(store.summaries().map((s) => s.id)).toEqual(["a", "b"]);
      for (let i = 0; i < MAX_CONVERSATIONS + 5; i++) store.save(conversation(`n${i}`, 10 + i));
      expect(store.summaries()).toHaveLength(MAX_CONVERSATIONS);
      store.remove(`n${MAX_CONVERSATIONS + 4}`);
      expect(store.get(`n${MAX_CONVERSATIONS + 4}`)).toBeUndefined();
      store.flush();
      const again = new AssistHistoryStore(dir);
      expect(again.summaries()).toHaveLength(MAX_CONVERSATIONS - 1);
      again.clear();
      expect(again.summaries()).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
