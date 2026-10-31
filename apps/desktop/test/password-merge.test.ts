import { describe, expect, it } from "vitest";
import { historyEntry, historyMatches, mergeHistory, retire } from "../src/main/password-history";
import type { MergeContext, MergeLogin } from "../src/shared/password-merge";
import { planImport } from "../src/shared/password-merge";
import type { PasswordHistoryEntry } from "../src/shared/credentials";

const ctx = (logins: MergeLogin[], deletions: { origin: string; username: string; hashes: PasswordHistoryEntry[] }[] = []): MergeContext => ({
  loginsForOrigin: logins,
  deletionsForOrigin: deletions,
  hashMatches: historyMatches,
});

const login = (over: Partial<MergeLogin> = {}): MergeLogin => ({ id: "id1", origin: "https://example.com", username: "ana", password: "current-pw", changedAt: 1000, ...over });

describe("keyed-hash history", () => {
  it("recognises a retired password without keeping it in the clear", () => {
    const entry = historyEntry("old-secret", 5);
    expect(entry.hash).not.toContain("old-secret");
    expect(historyMatches([entry], "old-secret")).toBe(true);
    expect(historyMatches([entry], "other")).toBe(false);
  });

  it("retire adds a password once and caps oldest-first", () => {
    let hist: PasswordHistoryEntry[] = [];
    for (let i = 0; i < 25; i++) hist = retire(hist, `pw-${i}`, i);
    expect(hist).toHaveLength(20);
    expect(historyMatches(hist, "pw-24")).toBe(true);
    expect(historyMatches(hist, "pw-0")).toBe(false); // dropped past the cap
    // Filing the same password again changes nothing.
    const again = retire(hist, "pw-24", 99);
    expect(again).toHaveLength(20);
  });

  it("merges two histories by union, each entry verifiable with its own salt", () => {
    const a = [historyEntry("pw-a", 1)];
    const b = [historyEntry("pw-b", 2)];
    const merged = mergeHistory(a, b);
    expect(merged).toHaveLength(2);
    expect(historyMatches(merged, "pw-a")).toBe(true);
    expect(historyMatches(merged, "pw-b")).toBe(true);
    // Union is idempotent (same entries do not pile up).
    expect(mergeHistory(merged, a)).toHaveLength(2);
  });
});

describe("one merge path for browser import and CSV", () => {
  it("identical password: already saved", () => {
    expect(planImport({ origin: "https://example.com", username: "ana", password: "current-pw" }, ctx([login()])).outcome).toBe("alreadySaved");
  });

  it("matches the login's history: left alone, no new entry", () => {
    const hist = [historyEntry("old-pw", 10)];
    expect(planImport({ origin: "https://example.com", username: "ana", password: "old-pw", changedAt: 50 }, ctx([login({ passwordHistory: hist })])).outcome).toBe("history");
  });

  it("dated newer than the login: update it (old goes to history)", () => {
    const plan = planImport({ origin: "https://example.com", username: "ana", password: "newer-pw", changedAt: 2000 }, ctx([login({ changedAt: 1000 })]));
    expect(plan.outcome).toBe("updated");
    expect(plan.targetId).toBe("id1");
  });

  it("dated older than the login: file in history, leave the login", () => {
    expect(planImport({ origin: "https://example.com", username: "ana", password: "stale-pw", changedAt: 500 }, ctx([login({ changedAt: 1000 })])).outcome).toBe("older");
  });

  it("different with no date (CSV): review, never overwrite", () => {
    expect(planImport({ origin: "https://example.com", username: "ana", password: "mystery" }, ctx([login()])).outcome).toBe("review");
    expect(planImport({ origin: "https://example.com", username: "ana", password: "mystery", changedAt: 0 }, ctx([login()])).outcome).toBe("review");
  });

  it("no login for it: new", () => {
    expect(planImport({ origin: "https://example.com", username: "bob", password: "fresh" }, ctx([login()])).outcome).toBe("new");
  });

  it("deleted in Corvus, same password: left out; a different one comes in as new", () => {
    const hashes = [historyEntry("was-deleted", 1)];
    const deletions = [{ origin: "https://example.com", username: "gone", hashes }];
    expect(planImport({ origin: "https://example.com", username: "gone", password: "was-deleted" }, ctx([], deletions)).outcome).toBe("deletedLeftOut");
    expect(planImport({ origin: "https://example.com", username: "gone", password: "changed-since" }, ctx([], deletions)).outcome).toBe("new");
  });

  it("same origin, no username: never a second blank entry with the same password", () => {
    expect(planImport({ origin: "https://example.com", username: "", password: "current-pw" }, ctx([login({ username: "ana" })])).outcome).toBe("alreadySaved");
    // A blank row with a genuinely new password is still new.
    expect(planImport({ origin: "https://example.com", username: "", password: "brand-new" }, ctx([login({ username: "ana" })])).outcome).toBe("new");
  });

  it("re-importing the same thing twice adds nothing", () => {
    const c = ctx([login()]);
    const first = planImport({ origin: "https://example.com", username: "ana", password: "current-pw" }, c);
    const second = planImport({ origin: "https://example.com", username: "ana", password: "current-pw" }, c);
    expect(first.outcome).toBe("alreadySaved");
    expect(second.outcome).toBe("alreadySaved");
  });
});
