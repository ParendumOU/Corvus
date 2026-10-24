import { deriveKeys, generateRecoveryPhrase } from "@corvus/sync-core";
import { describe, expect, it } from "vitest";
import { chainIdForPhrase } from "../src/lib/sync";

describe("sync on the phone", () => {
  it("opens the same chain as the desktop from the same recovery phrase", () => {
    const phrase = generateRecoveryPhrase();
    expect(chainIdForPhrase(phrase)).toBe(deriveKeys(phrase).chainId);
    // Typed on a phone: extra spaces and capitals do not change the chain.
    expect(chainIdForPhrase(`  ${phrase.toUpperCase().split(" ").join("   ")} `)).toBe(deriveKeys(phrase).chainId);
  });

  it("refuses a phrase that is not a valid recovery phrase", () => {
    expect(chainIdForPhrase("raven raven raven")).toBeNull();
    expect(chainIdForPhrase("")).toBeNull();
  });
});
