import { app, type WebContents } from "electron";
import { httpAuthPrompt, mayAskSignIn, signInChoices } from "../shared/http-auth";
import { originOf } from "../shared/permissions";
import { approvalReason, pickAgentLogin } from "./agent-credential-policy";
import type { AppContext } from "./context";
import type { LoginRecord } from "./login-sources";
import { tr } from "./menu-i18n";
import type { BrowserWindowCtl, TabRuntime } from "./window";

type SignInCallback = (username?: string, password?: string) => void;

/** One sign-in dialog, answered for every request of the same tab, site and realm that waits on it. */
interface Question {
  wc: WebContents;
  origin: string;
  agent: boolean;
  callbacks: SignInCallback[];
}

/** How long Corvus waits for the page a typed sign-in opens, to offer saving the login. */
const OUTCOME_MS = 60_000;

/**
 * Sites that ask for a username and password (HTTP Basic, Digest or NTLM: a router's or a device's
 * panel, an intranet): Corvus's own Sign in dialog, as in Chrome. Electron cancels the sign-in when
 * nobody handles the app's "login" event, and the page then stays on the site's 401 error. Proxies
 * sign in through installConnectionHooks; a request that is not a tab's is left to Electron, which
 * cancels it. The dialog offers the site's saved logins (Corvus and KeePass) and, after a sign-in
 * typed by hand works, the save-password prompt. A tab in the background asks with a bar instead
 * of switching to it. AI agents never answer the dialog: a login the person opted in for agents is
 * used after the person approves it, else the person signs in and the agent is told so.
 *
 * Based on Noel's fix/basic-auth-login (dialog wording, realm line and plain-http warning).
 */
export class HttpAuthService {
  private readonly open = new Map<string, Question>();
  private readonly askedListeners = new Map<WebContents, Set<() => void>>();
  /** Per tab, by site, the username its last sign-in sent (filled in again when the site refuses it). */
  private readonly lastSent = new WeakMap<WebContents, Map<string, string>>();
  /** Per tab and site, the watcher of a typed sign-in's outcome (stopped when the site asks again). */
  private readonly outcomes = new Map<string, () => void>();

  constructor(private readonly ctx: AppContext) {}

  install(): void {
    app.on("login", (event, wc, details, authInfo, callback) => {
      if (authInfo.isProxy || !wc) return;
      const found = this.ctx.windows.byTabWebContents(wc);
      if (!found || found.window.win.isDestroyed()) return;
      event.preventDefault();
      void this.challenge(found.window, found.tab, wc, details, authInfo, callback).catch(() => callback());
    });
  }

  /**
   * For agents: the sign-in dialog open over this tab, which only the person answers, as the message
   * an agent's call gets (null when there is none).
   */
  personStep(wc: WebContents): string | null {
    const question = [...this.open.values()].find((q) => q.wc === wc && q.agent);
    if (!question) return null;
    return `${question.origin} asks for a username and password in a browser sign-in dialog. Agents cannot answer it: hand this step to the person (they sign in in the dialog Corvus shows), then continue.`;
  }

  /** Calls `listener` when a sign-in dialog opens for the tab of `wc`; returns the unsubscribe. */
  onAsked(wc: WebContents, listener: () => void): () => void {
    const set = this.askedListeners.get(wc) ?? new Set();
    set.add(listener);
    this.askedListeners.set(wc, set);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.askedListeners.delete(wc);
    };
  }

  private async challenge(
    win: BrowserWindowCtl,
    tab: TabRuntime,
    wc: WebContents,
    details: Electron.AuthenticationResponseDetails,
    authInfo: Electron.AuthInfo,
    callback: SignInCallback,
  ): Promise<void> {
    const url = details.url;
    const origin = originOf(url);
    if (!mayAskSignIn({ navigation: details.isRequestForNavigation, origin, topOrigin: originOf(wc.getURL()) })) return callback();
    const site = `${wc.id}|${origin}`;
    // The site refused the last sign-in (or asks again): that one is not offered for saving.
    this.outcomes.get(site)?.();
    const key = `${site}|${authInfo.scheme}|${authInfo.realm}`;
    const waiting = this.open.get(key);
    if (waiting) {
      waiting.callbacks.push(callback);
      return;
    }
    const agent = tab.agentControlled;
    if (agent && details.firstAuthAttempt) {
      const login = await this.agentLogin(win, url);
      if (login) return callback(login.username, login.password);
    }
    const question: Question = { wc, origin, agent, callbacks: [callback] };
    this.open.set(key, question);
    for (const listener of this.askedListeners.get(wc) ?? []) listener();
    const answer = (username?: string, password?: string): void => {
      this.open.delete(key);
      for (const cb of question.callbacks) cb(username, password);
    };
    try {
      await this.ask(win, tab, wc, url, authInfo, question, site, answer);
    } finally {
      if (this.open.get(key) === question) answer();
    }
  }

  /** An opted-in login of the site an agent may sign in with, once the person approved this use. */
  private async agentLogin(win: BrowserWindowCtl, url: string): Promise<LoginRecord | null> {
    const host = httpAuthPrompt(url, "").site;
    const picked = pickAgentLogin(win.profile.logins.records(url), "signIn", { globalOn: this.ctx.agentCredentials.enabled, host, handoffHint: "" });
    if (!picked.ok || !picked.record.password) return null;
    const approved = await this.ctx.agentCredentials.dialogApprover()({
      use: "signIn",
      host,
      username: picked.record.username,
      reason: approvalReason("signIn", picked.record, host),
      client: this.ctx.agents.currentClient,
    });
    return approved ? (win.profile.logins.forPage(picked.record.id, url) ?? null) : null;
  }

  private async ask(
    win: BrowserWindowCtl,
    tab: TabRuntime,
    wc: WebContents,
    url: string,
    authInfo: Electron.AuthInfo,
    question: Question,
    site: string,
    answer: (username?: string, password?: string) => void,
  ): Promise<void> {
    const prompt = httpAuthPrompt(url, authInfo.realm);
    const saved = signInChoices(win.profile.logins.records(url));
    const detail = [
      prompt.realm ? tr("The site says: {realm}", { realm: prompt.realm }) : "",
      prompt.private ? "" : tr("Your connection to this site is not private: the username and password are sent unencrypted."),
      question.agent ? tr("An AI agent is driving this tab. Agents cannot sign in here: you do.") : "",
    ].filter(Boolean);
    const message = prompt.site ? tr("{host} asks for a username and password", { host: prompt.site }) : tr("This site asks for a username and password");
    // The tab closed or left for another page while the dialog was open: nothing to answer.
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    wc.once("destroyed", abort);
    wc.once("did-navigate", abort);
    let reply;
    try {
      reply = await this.ctx.dialogs.askAboutTab(
        win,
        tab.id,
        { message, action: tr("Sign in…") },
        {
          tone: prompt.private ? "question" : "warning",
          title: tr("Sign in"),
          message,
          ...(detail.length ? { detail: detail.join("\n") } : {}),
          fields: [
            { label: tr("Username"), value: this.lastSent.get(wc)?.get(question.origin) ?? "" },
            { label: tr("Password"), value: "", secret: true },
          ],
          ...(saved.length
            ? {
                choices: saved.map((r) => ({
                  label: r.username || tr("(no username)"),
                  detail: r.source === "keepass" ? (r.sourceName ? `KeePass · ${r.sourceName}` : "KeePass") : tr("Saved in Corvus"),
                })),
              }
            : {}),
          buttons: [tr("Cancel"), tr("Sign in")],
          defaultId: 1,
          cancelId: 0,
          ...(prompt.site ? { origin: prompt.site } : {}),
        },
        controller.signal,
      );
    } finally {
      wc.removeListener("destroyed", abort);
      wc.removeListener("did-navigate", abort);
    }
    if (controller.signal.aborted || wc.isDestroyed()) return answer();
    const picked = reply.choice !== undefined ? saved[reply.choice] : undefined;
    if (picked) {
      // Read again: the login may have changed or gone while the dialog was open.
      const login = win.profile.logins.forPage(picked.id, url);
      if (!login) return answer();
      this.noteSent(wc, question.origin, login.username);
      return answer(login.username, login.password);
    }
    if (reply.button !== 1) return answer();
    const [username = "", password = ""] = reply.values ?? [];
    this.noteSent(wc, question.origin, username);
    answer(username, password);
    if (!win.isPrivate && !question.agent && password) this.offerSave(win, tab, wc, question.origin, site, username, password);
  }

  private noteSent(wc: WebContents, origin: string, username: string): void {
    const sites = this.lastSent.get(wc) ?? new Map<string, string>();
    sites.set(origin, username);
    this.lastSent.set(wc, sites);
  }

  /**
   * After a sign-in typed by hand: once the site's page opens with it (not refused), the
   * save-password prompt offers to keep the login, as after a sign-in form.
   */
  private offerSave(win: BrowserWindowCtl, tab: TabRuntime, wc: WebContents, origin: string, site: string, username: string, password: string): void {
    const stop = (): void => {
      clearTimeout(timer);
      wc.removeListener("did-frame-navigate", onNavigate);
      wc.removeListener("destroyed", stop);
      if (this.outcomes.get(site) === stop) this.outcomes.delete(site);
    };
    const onNavigate = (_e: Electron.Event, navigated: string, code: number): void => {
      if (originOf(navigated) !== origin) return;
      stop();
      if (code > 0 && code < 400) this.ctx.autofill.onSubmitCaptured(win, tab, { origin, username, password });
    };
    const timer = setTimeout(stop, OUTCOME_MS);
    this.outcomes.get(site)?.();
    this.outcomes.set(site, stop);
    wc.on("did-frame-navigate", onNavigate);
    wc.once("destroyed", stop);
  }
}
