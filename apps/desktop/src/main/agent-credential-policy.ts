/**
 * Who may an AI agent sign in as, or whose 2FA code may it fill, on this page? Pure so the gates can
 * be unit-tested: the global setting, then the per-login opt-in, then an unambiguous choice. The
 * approval prompt comes after this, in AgentCredentialService. Messages go to the model, so they name
 * usernames and hosts (not secret) but never a password, a code or a 2FA secret.
 */
import type { LoginRecord } from "./login-sources";

export type CredentialUse = "totp" | "signIn";

export type PolicyResult =
  | { ok: true; record: LoginRecord }
  | { ok: false; status: "handoff" | "error"; message: string };

export interface PolicyOptions {
  /** Settings, Passwords: "Let AI agents use logins you opt in". */
  globalOn: boolean;
  host: string;
  username?: string;
  /** How this caller hands a step to the person, e.g. "Call ask_user so the person can enter it." */
  handoffHint: string;
}

const what = (use: CredentialUse): string => (use === "totp" ? "2FA code" : "saved login");

function optedIn(r: LoginRecord, use: CredentialUse): boolean {
  return use === "totp" ? Boolean(r.totp) && r.agentTotp : r.agentSignIn;
}

function exists(r: LoginRecord, use: CredentialUse): boolean {
  return use === "totp" ? Boolean(r.totp) : true;
}

export function pickAgentLogin(records: LoginRecord[], use: CredentialUse, opts: PolicyOptions): PolicyResult {
  const hint = opts.handoffHint;
  if (!opts.globalOn) {
    return { ok: false, status: "handoff", message: `AI agents are not allowed to use saved logins or 2FA codes in this browser. ${hint}` };
  }
  const usable = records.filter((r) => optedIn(r, use));
  const wanted = opts.username ? usable.filter((r) => r.username === opts.username) : usable;
  if (wanted.length === 0) {
    if (opts.username && usable.length > 0) {
      const names = [...new Set(usable.map((r) => r.username || "(no username)"))];
      return { ok: false, status: "error", message: `No ${what(use)} for "${opts.username}" on ${opts.host} is available to agents. Available: ${names.join(", ")}.` };
    }
    if (records.some((r) => exists(r, use))) {
      return { ok: false, status: "handoff", message: `The person has not allowed AI agents to use the ${what(use)} for ${opts.host}. ${hint}` };
    }
    return { ok: false, status: "handoff", message: `Corvus has no ${what(use)} for ${opts.host}. ${hint}` };
  }
  const names = [...new Set(wanted.map((r) => r.username))];
  if (names.length > 1) {
    return {
      ok: false,
      status: "error",
      message: `Several logins on ${opts.host} allow this: ${names.map((n) => n || "(no username)").join(", ")}. Call the tool again with the username to use.`,
    };
  }
  return { ok: true, record: wanted[0]! };
}

/** The approval prompt text: what will be filled, for whom and where, and that the agent will not see it. */
export function approvalReason(use: CredentialUse, record: LoginRecord, host: string): string {
  const who = record.username ? ` for ${record.username}` : "";
  const from = record.source === "keepass" ? ` from KeePass${record.sourceName ? ` (${record.sourceName})` : ""}` : "";
  return use === "totp"
    ? `Fill the current 2FA code${who} on ${host}${from}. The agent will not see the code.`
    : `Sign in${who} on ${host} with the saved password${from}. The agent will not see the password.`;
}
