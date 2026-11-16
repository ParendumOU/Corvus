/**
 * The login dropdown in a tab an AI agent has worked in. Such a tab stays agent-driven (an MCP agent
 * never hands it back), so the dropdown would never open there again. It opens on the person's own
 * click or key press in the field, also while the agent waits for them (asking them to sign in, say),
 * and what they pick fills for a minute after their own input. Input an agent sends the tab never
 * counts as theirs: it is marked first (markAgentInput in window.ts), wipes the person's last input,
 * closes the dropdown and never moves or picks in it (field-dropdown.ts). The dropdown is a view of
 * its own that agents cannot click. Auto sign-in and card fills stay off there.
 */

/** How long after the person's own input in an agent's tab what they pick in the dropdown may fill. */
export const PERSON_AUTOFILL_MS = 60_000;
/** The field click that opens the dropdown in an agent's tab must be the person's input of just now. */
export const PERSON_OPEN_MS = 1_000;
/** Input events this soon after an agent said it would send input are the agent's. */
export const AGENT_INPUT_GRACE_MS = 2_000;

export interface AutofillTabState {
  agentControlled: boolean;
  /** The last click or key press in the tab that no agent sent (epoch ms), cleared by agent input and navigation. */
  ownInputAt?: number;
  /** When an agent last said it would send the tab input (epoch ms). */
  agentInputAt?: number;
}

/** Whether what the person picks in the dropdown may fill this tab now. */
export function personAutofillAllowed(tab: AutofillTabState, now: number): boolean {
  if (!tab.agentControlled) return true;
  const input = tab.ownInputAt;
  return input !== undefined && now - input <= PERSON_AUTOFILL_MS && input > (tab.agentInputAt ?? 0);
}

/** Whether a field click may open the dropdown in this tab: in an agent's, only the person's own click of just now. */
export function personOpensDropdown(tab: AutofillTabState, now: number): boolean {
  if (!tab.agentControlled) return true;
  const input = tab.ownInputAt;
  return input !== undefined && now - input <= PERSON_OPEN_MS && input > (tab.agentInputAt ?? 0);
}

/** Whether keys reaching the tab now may be an agent's (it sent input a moment ago). */
export function agentKeysLikely(tab: AutofillTabState, now: number): boolean {
  return tab.agentInputAt !== undefined && now - tab.agentInputAt <= AGENT_INPUT_GRACE_MS;
}
