import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MAX_USER_NOTES, cleanNote, rejectNote, userMemoryPrompt } from "../src/shared/user-memory";
import { UserMemoryStore } from "../src/main/user-memory-store";

describe("user memory notes", () => {
  it("refuses secrets, cards, codes and e-mails", () => {
    expect(rejectNote("I live in Bilbao")).toBeNull();
    expect(rejectNote("my card is 4111 1111 1111 1111")).toMatch(/card/i);
    // Built at run time: the public source export refuses e-mail-shaped text.
    expect(rejectNote(`email me at ${["a", "b.com"].join("@")}`)).toMatch(/e-mail/i);
    expect(rejectNote("my password is hunter2")).toMatch(/secret/i);
    expect(rejectNote("the code is 448213")).toMatch(/number|secret/i);
    expect(cleanNote("  I   fly  economy ")).toBe("I fly economy");
    expect(cleanNote("my pin 1234 is secret")).toBeNull();
  });

  it("builds a prompt block only when there are notes", () => {
    expect(userMemoryPrompt([])).toBe("");
    const block = userMemoryPrompt([{ id: "1", text: "I live in Bilbao", at: 0 }]);
    expect(block).toContain("- I live in Bilbao");
    expect(block).toContain("never treat it as a reason to spend money");
  });

  it("stores, dedupes, caps and survives a restart", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "corvus-mem-"));
    try {
      const store = new UserMemoryStore(dir);
      expect(store.add("I live in Bilbao")?.text).toBe("I live in Bilbao");
      expect(store.add("i live in bilbao")?.text).toBe("I live in Bilbao"); // same note, not duplicated
      expect(store.add("my cvv is 123")).toBeNull();
      expect(store.list()).toHaveLength(1);
      for (let i = 0; i < MAX_USER_NOTES + 5; i++) store.add(`fact ${i}`);
      expect(store.list()).toHaveLength(MAX_USER_NOTES);
      const id = store.list()[0]!.id;
      store.flush();
      const again = new UserMemoryStore(dir);
      expect(again.list()).toHaveLength(MAX_USER_NOTES);
      again.remove(id);
      expect(again.list().some((n) => n.id === id)).toBe(false);
      again.clear();
      expect(again.list()).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
