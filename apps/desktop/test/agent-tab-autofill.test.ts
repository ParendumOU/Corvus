import { describe, expect, it } from "vitest";
import { AGENT_INPUT_GRACE_MS, PERSON_AUTOFILL_MS, PERSON_OPEN_MS, agentKeysLikely, personAutofillAllowed, personOpensDropdown } from "../src/shared/agent-tab-autofill";

const NOW = 1_000_000;

describe("personAutofillAllowed", () => {
  it("always allows a person-driven tab", () => {
    expect(personAutofillAllowed({ agentControlled: false }, NOW)).toBe(true);
  });

  it("refuses an agent's tab the person never touched", () => {
    expect(personAutofillAllowed({ agentControlled: true }, NOW)).toBe(false);
  });

  it("allows an agent's tab right after the person's own input", () => {
    expect(personAutofillAllowed({ agentControlled: true, ownInputAt: NOW - 100 }, NOW)).toBe(true);
  });

  it("refuses when the person's input is too old", () => {
    expect(personAutofillAllowed({ agentControlled: true, ownInputAt: NOW - PERSON_AUTOFILL_MS - 1 }, NOW)).toBe(false);
  });

  it("refuses once an agent sent input after the person's", () => {
    expect(personAutofillAllowed({ agentControlled: true, ownInputAt: NOW - 500, agentInputAt: NOW - 100 }, NOW)).toBe(false);
  });
});

describe("personOpensDropdown", () => {
  it("opens in a person-driven tab", () => {
    expect(personOpensDropdown({ agentControlled: false }, NOW)).toBe(true);
  });

  it("opens in an agent's tab only on the person's own input of just now", () => {
    expect(personOpensDropdown({ agentControlled: true, ownInputAt: NOW - 200 }, NOW)).toBe(true);
    // The person's click a while ago does not open it for a later click (the agent's).
    expect(personOpensDropdown({ agentControlled: true, ownInputAt: NOW - PERSON_OPEN_MS - 1 }, NOW)).toBe(false);
    expect(personOpensDropdown({ agentControlled: true, ownInputAt: NOW - 200, agentInputAt: NOW - 100 }, NOW)).toBe(false);
    expect(personOpensDropdown({ agentControlled: true }, NOW)).toBe(false);
  });
});

describe("agentKeysLikely", () => {
  it("takes keys right after an agent's input as the agent's", () => {
    expect(agentKeysLikely({ agentControlled: true, agentInputAt: NOW - 100 }, NOW)).toBe(true);
    expect(agentKeysLikely({ agentControlled: true, agentInputAt: NOW - AGENT_INPUT_GRACE_MS - 1 }, NOW)).toBe(false);
    expect(agentKeysLikely({ agentControlled: false }, NOW)).toBe(false);
  });
});
