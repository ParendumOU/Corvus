/**
 * Lets an AI agent use a saved login or its 2FA code by reference: the agent names a field, Corvus
 * fills the secret itself, and the agent only ever learns that it was filled. Shared by the Command
 * Bar agent (approval card in the run panel) and Full-access MCP clients (native approval dialog).
 *
 * Gates, in order: the global setting (off by default), the per-login opt-in (off by default), an
 * unambiguous login for the page, then the person's approval for this one use. Without them the
 * result tells the agent to hand the step to the person, which is the behaviour without this feature.
 *
 * Nothing here logs, returns or stores a password, a code or a 2FA secret.
 */
import { dialog, type WebContents } from "electron";
import type { TabId } from "@corvus/shared";
import { isAgentAllowedUrl } from "../shared/internal-urls";
import { totpCode } from "../shared/totp";
import { approvalReason, pickAgentLogin, type CredentialUse } from "./agent-credential-policy";
import { AUTOFILL_WORLD_ID, fillLoginByRefScript, fillOtpByRefScript, type FillOutcome } from "./credential-scripts";
import type { AppContext } from "./context";
import type { LoginRecord } from "./login-sources";
import type { BrowserWindowCtl, TabRuntime } from "./window";

const REF_RE = /^e\d{1,7}$/;
const SCRIPT_TIMEOUT_MS = 8000;
/** A code this close to expiring is not worth filling: wait for the next one. */
const MIN_CODE_LIFETIME_MS = 3000;

export interface CredentialApprovalRequest {
  use: CredentialUse;
  host: string;
  username: string;
  /** Approval prompt text (what, for whom, where; never the secret). */
  reason: string;
  /** Agent client name, e.g. "Corvus" or an MCP client. */
  client: string;
}

/** Resolves true when the person approved this single use. */
export type CredentialApprover = (request: CredentialApprovalRequest) => Promise<boolean>;

export interface CredentialFillOutcome {
  status: "filled" | "handoff" | "declined" | "error";
  /** What the agent is told. Never contains a secret. */
  message: string;
}

export interface CredentialFillOptions {
  username?: string;
  approve: CredentialApprover;
  client: string;
  /** How this caller hands a step to the person (tool name differs between Corvus and MCP). */
  handoffHint: string;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function runInPage<T>(wc: WebContents, code: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("The page did not respond.")), SCRIPT_TIMEOUT_MS);
    (wc.executeJavaScriptInIsolatedWorld(AUTOFILL_WORLD_ID, [{ code }]) as Promise<T>).then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      () => {
        clearTimeout(timer);
        // Never surface the engine's error: it could quote the script, which holds the secret.
        reject(new Error("The page could not be filled."));
      },
    );
  });
}

function refProblem(outcome: FillOutcome, ref: string | null): string {
  if (outcome.reason === "missing") return `Element ${ref} was not found. Take a new page_snapshot and use a current ref.`;
  if (outcome.reason === "not-field") return `Element ${ref} is not a field Corvus can fill. Point at the code or login field.`;
  return "No login form was found on this page. Take a page_snapshot and pass the ref of the username or password field.";
}

export class AgentCredentialService {
  private testApprover: CredentialApprover | null = null;

  constructor(private readonly ctx: AppContext) {}

  /** The global gate: Settings, Passwords, "Let AI agents use logins you opt in". */
  get enabled(): boolean {
    return this.ctx.settings.get().passwords.agentAccess;
  }

  /** Smoke tests answer the MCP approval dialog without a person; null restores the dialog. */
  setTestApprover(approver: CredentialApprover | null): void {
    this.testApprover = approver;
  }

  /** Approval for MCP clients: a native dialog over the focused window (one use, no "always"). */
  dialogApprover(): CredentialApprover {
    return async (req) => {
      if (this.testApprover) return this.testApprover(req);
      const parent = this.ctx.windows.focused()?.win;
      const options: Electron.MessageBoxOptions = {
        type: "warning",
        buttons: [req.use === "totp" ? "Fill code" : "Sign in", "Deny"],
        defaultId: 1,
        cancelId: 1,
        title: "AI agent wants to use a saved login",
        message: req.use === "totp" ? `Let “${req.client}” fill your 2FA code for ${req.host}?` : `Let “${req.client}” sign in to ${req.host}?`,
        detail: `${req.reason}\n\nOnly this one use is approved.`,
      };
      const { response } = parent ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options);
      return response === 0;
    };
  }

  private locate(tabId: TabId): { window: BrowserWindowCtl; tab: TabRuntime; wc: WebContents; url: string } | null {
    const found = this.ctx.windows.findTab(tabId);
    if (!found) return null;
    const wc = found.tab.view.webContents;
    if (wc.isDestroyed()) return null;
    const url = wc.getURL() || found.tab.url;
    if (!/^https?:\/\//i.test(url) || !isAgentAllowedUrl(url)) return null;
    return { ...found, wc, url };
  }

  /**
   * Shared gate sequence. Returns the approved login and live page, or the outcome to report. The
   * login is re-resolved against the page after approval, so a navigation while the person decides
   * can never send a secret to another site.
   */
  private async gate(
    tabId: TabId,
    use: CredentialUse,
    opts: CredentialFillOptions,
  ): Promise<{ ok: true; record: LoginRecord; window: BrowserWindowCtl; wc: WebContents; url: string } | { ok: false; outcome: CredentialFillOutcome }> {
    const page = this.locate(tabId);
    if (!page) return { ok: false, outcome: { status: "error", message: "That tab is not an http(s) page the agent can use." } };
    const host = hostOf(page.url);
    const picked = pickAgentLogin(page.window.profile.logins.records(page.url), use, {
      globalOn: this.enabled,
      host,
      handoffHint: opts.handoffHint,
      ...(opts.username ? { username: opts.username } : {}),
    });
    if (!picked.ok) return { ok: false, outcome: { status: picked.status, message: picked.message } };

    const approved = await opts.approve({ use, host, username: picked.record.username, reason: approvalReason(use, picked.record, host), client: opts.client });
    if (!approved) {
      return { ok: false, outcome: { status: "declined", message: `The person declined. Do not try again; ${opts.handoffHint.charAt(0).toLowerCase()}${opts.handoffHint.slice(1)}` } };
    }

    const after = this.locate(tabId);
    const record = after ? after.window.profile.logins.forPage(picked.record.id, after.url) : undefined;
    if (!after || !record) return { ok: false, outcome: { status: "error", message: "The page changed while waiting for approval. Take a new page_snapshot." } };
    if (use === "totp" ? !(record.totp && record.agentTotp) : !record.agentSignIn) {
      return { ok: false, outcome: { status: "handoff", message: `The person no longer allows agents to use this login. ${opts.handoffHint}` } };
    }
    return { ok: true, record, window: after.window, wc: after.wc, url: after.url };
  }

  /** Fills the current 2FA code of an opted-in login into the field `ref` points at. */
  async fillTotp(tabId: TabId, ref: string, opts: CredentialFillOptions): Promise<CredentialFillOutcome> {
    if (!REF_RE.test(ref)) return { status: "error", message: `Invalid element ref "${ref}"; use a ref from page_snapshot.` };
    const gated = await this.gate(tabId, "totp", opts);
    if (!gated.ok) return gated.outcome;
    const { record, window, wc } = gated;

    let current = await totpCode(record.totp!);
    if (current.expiresAt - Date.now() < MIN_CODE_LIFETIME_MS) {
      await sleep(Math.max(0, current.expiresAt - Date.now()) + 50);
      current = await totpCode(record.totp!);
    }
    window.markAgent(tabId);
    await this.ctx.agents.beforeAction(window, tabId, wc, { kind: "type", ref, text: "••••••" }).catch(() => undefined);
    // Lock script access before the code lands in the page; lifted on the next new document.
    this.ctx.secretFills.mark(tabId, [current.code]);
    let outcome: FillOutcome;
    try {
      outcome = await runInPage<FillOutcome>(wc, fillOtpByRefScript(ref, current.code));
    } catch (err) {
      return { status: "error", message: (err as Error).message };
    }
    if (!outcome?.ok) {
      this.ctx.secretFills.clear(tabId);
      return { status: "error", message: refProblem(outcome ?? { ok: false }, ref) };
    }
    const who = record.username ? ` for ${record.username}` : "";
    return { status: "filled", message: `Filled the current 2FA code${who} into ${ref}. You cannot read it; continue by submitting the form.` };
  }

  /** Fills an opted-in saved login (username and/or password) around `ref`, or the page's login form. */
  async fillLogin(tabId: TabId, ref: string | null, opts: CredentialFillOptions): Promise<CredentialFillOutcome> {
    if (ref !== null && !REF_RE.test(ref)) return { status: "error", message: `Invalid element ref "${ref}"; use a ref from page_snapshot.` };
    const gated = await this.gate(tabId, "signIn", opts);
    if (!gated.ok) return gated.outcome;
    const { record, window, wc } = gated;

    window.markAgent(tabId);
    if (ref) await this.ctx.agents.beforeAction(window, tabId, wc, { kind: "type", ref, text: "••••••" }).catch(() => undefined);
    this.ctx.secretFills.mark(tabId, [record.password]);
    let outcome: FillOutcome;
    try {
      outcome = await runInPage<FillOutcome>(wc, fillLoginByRefScript(ref, record.username, record.password));
    } catch (err) {
      return { status: "error", message: (err as Error).message };
    }
    if (!outcome?.ok) {
      this.ctx.secretFills.clear(tabId);
      return { status: "error", message: refProblem(outcome ?? { ok: false }, ref) };
    }
    const who = record.username ? ` for ${record.username}` : "";
    const filled = outcome.user && outcome.pass ? "the username and password" : outcome.pass ? "the password" : "the username";
    const next = outcome.pass ? "Submit the form to sign in." : "This step has no password field; continue, then call fill_login again on the password step.";
    return { status: "filled", message: `Filled ${filled}${who}. You cannot read the password. ${next}` };
  }
}
