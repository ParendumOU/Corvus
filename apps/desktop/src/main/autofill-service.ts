import type { MenuItemConstructorOptions } from "electron";
import type { TabId } from "@corvus/shared";
import type { CredentialMatch } from "../shared/credentials";
import { originKeyOf } from "../shared/credentials";
import { type AutofillBarState, type CapturedSubmit, EMPTY_AUTOFILL, type LoginFieldBox, type PendingSaveView, type SaveEdit } from "../shared/credentials-ipc";
import { totpCode } from "../shared/totp";
import { AUTOFILL_WORLD_ID, detectLoginScript, fillLoginScript, fillOtpScript, type LoginDetection } from "./credential-scripts";
import type { AppContext } from "./context";
import { loginFieldMenuItems, showMenuAt } from "./menus";
import type { BrowserWindowCtl, TabRuntime } from "./window";
import { tr } from "./menu-i18n";

const SCRIPT_TIMEOUT_MS = 4000;
/** Single-page apps render the next step after the URL changes; probe again a little later. */
const REPROBE_DELAY_MS = 700;
/** Auto sign-in asks at most once per tab and site in this window (a failed sign-in must not loop). */
const AUTO_SIGN_IN_QUIET_MS = 5 * 60_000;

/** What the auto sign-in prompt shows. Resolves true to sign in, false to skip. */
export interface AutoSignInRequest {
  host: string;
  username: string;
}
export type AutoSignInApprover = (win: BrowserWindowCtl, request: AutoSignInRequest) => Promise<{ approved: boolean; stopOffering: boolean }>;

interface PendingSave {
  id: number;
  origin: string;
  username: string;
  password: string;
  /** The save prompt was shown once: it no longer opens by itself (the key button still reaches it). */
  shown: boolean;
}

interface Detected {
  login: boolean;
  otp: boolean;
}

function isWebPage(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

function hostOf(origin: string): string {
  try {
    return new URL(origin).hostname;
  } catch {
    return origin;
  }
}

/**
 * Autofill: detects login forms and one-time-code fields on web pages (isolated-world script), offers
 * to fill a saved login or its current 2FA code through the omnibox key button, and captures
 * submitted credentials to offer saving. All page access is from the main process; nothing is written
 * to a page except on an explicit fill, and a fill only ever uses a login that matches the page.
 * Logins come from every source of the profile (see login-sources.ts).
 */
export class AutofillService {
  private readonly detected = new Map<TabId, Detected>();
  private readonly pending = new Map<TabId, PendingSave>();
  private lastSaveId = 0;
  private readonly reprobes = new Map<TabId, NodeJS.Timeout>();
  /** Per tab: origin -> when auto sign-in last asked. */
  private readonly autoAsked = new Map<TabId, Map<string, number>>();
  private autoApprover: AutoSignInApprover | null = null;
  private fieldMenuProbe: ((items: MenuItemConstructorOptions[]) => void) | null = null;

  constructor(private readonly ctx: AppContext) {}

  /** Smoke tests answer the auto sign-in prompt; null restores the dialog. */
  setAutoSignInApprover(approver: AutoSignInApprover | null): void {
    this.autoApprover = approver;
  }

  private async askAutoSignIn(win: BrowserWindowCtl, req: AutoSignInRequest): Promise<{ approved: boolean; stopOffering: boolean }> {
    if (this.autoApprover) return this.autoApprover(win, req);
    const { response, checkboxChecked } = await this.ctx.dialogs.messageBox({
      type: "question",
      buttons: [tr("Not now"), tr("Sign in")],
      defaultId: 1,
      cancelId: 0,
      title: tr("Sign in automatically"),
      message: tr("Sign in to {host}?", { host: req.host }),
      detail: req.username ? tr("Corvus will fill the saved login for {username} and submit the form.", { username: req.username }) : tr("Corvus will fill the saved login and submit the form."),
      checkboxLabel: tr("Stop signing in automatically with this login"),
      checkboxChecked: false,
    }, win);
    return { approved: response === 1, stopOffering: checkboxChecked };
  }

  /**
   * Auto sign-in: when a login form loads on a site whose login the person opted in, ask once and, if
   * they confirm, fill and submit it. Never in agent-driven tabs (agents have their own gates), never
   * in a background tab, and at most once per tab and site in a few minutes.
   */
  private async maybeAutoSignIn(win: BrowserWindowCtl, tab: TabRuntime): Promise<void> {
    if (tab.agentControlled || win.activeTab()?.id !== tab.id) return;
    const ids = win.profile.autoSignIn.ids();
    if (ids.size === 0) return;
    const url = this.pageUrl(tab);
    const origin = originKeyOf(url);
    const login = win.profile.logins.records(url).find((r) => ids.has(r.id));
    if (!origin || !login) return;
    const asked = this.autoAsked.get(tab.id) ?? new Map<string, number>();
    if (Date.now() - (asked.get(origin) ?? 0) < AUTO_SIGN_IN_QUIET_MS) return;
    asked.set(origin, Date.now());
    this.autoAsked.set(tab.id, asked);
    const answer = await this.askAutoSignIn(win, { host: hostOf(origin), username: login.username });
    if (answer.stopOffering) win.profile.autoSignIn.set(login.id, false);
    if (!answer.approved) return;
    const current = win.profile.logins.forPage(login.id, this.pageUrl(tab));
    if (!current) return;
    this.ctx.secretFills.mark(tab.id, [current.password]);
    await this.run<boolean>(tab, fillLoginScript(current.username, current.password, true));
  }

  private async run<T>(tab: TabRuntime, code: string): Promise<T | null> {
    const wc = tab.view.webContents;
    if (wc.isDestroyed() || !isWebPage(wc.getURL())) return null;
    try {
      return (await withTimeout(wc.executeJavaScriptInIsolatedWorld(AUTOFILL_WORLD_ID, [{ code }]) as Promise<T>, SCRIPT_TIMEOUT_MS)) ?? null;
    } catch {
      return null;
    }
  }

  private pageUrl(tab: TabRuntime): string {
    return tab.view.webContents.isDestroyed() ? tab.url : tab.view.webContents.getURL();
  }

  /** A page finished loading: probe it for a login form or 2FA field so the omnibox can offer autofill. */
  async onPageLoad(win: BrowserWindowCtl, tab: TabRuntime): Promise<void> {
    const result = await this.run<LoginDetection>(tab, detectLoginScript());
    const next: Detected = { login: result?.hasPassword === true, otp: result?.hasOtp === true };
    const before = this.detected.get(tab.id) ?? { login: false, otp: false };
    this.detected.set(tab.id, next);
    if ((next.login !== before.login || next.otp !== before.otp) && win.activeTab()?.id === tab.id) win.pushState();
    if (next.login) await this.maybeAutoSignIn(win, tab);
  }

  /** Same-document navigation (SPA route change): the next step's fields render shortly after. */
  onInPageNavigation(win: BrowserWindowCtl, tab: TabRuntime): void {
    clearTimeout(this.reprobes.get(tab.id));
    this.reprobes.set(
      tab.id,
      setTimeout(() => {
        this.reprobes.delete(tab.id);
        void this.onPageLoad(win, tab);
      }, REPROBE_DELAY_MS),
    );
  }

  /**
   * The tab preload reported a submitted login (captured synchronously in-page before navigation).
   * Offer to save it unless it already matches a stored login. Validated against the sending tab.
   */
  onSubmitCaptured(win: BrowserWindowCtl, tab: TabRuntime, data: CapturedSubmit): void {
    const origin = originKeyOf(data.origin);
    if (!origin || !data.password) return;
    const existing = win.profile.credentials.findByLogin(origin, data.username);
    if (existing && existing.password === data.password) return; // already saved, unchanged
    this.pending.set(tab.id, { id: ++this.lastSaveId, origin, username: data.username, password: data.password, shown: false });
    if (win.activeTab()?.id === tab.id) win.pushState();
  }

  /** A tab committed a navigation: its login probe is stale (a pending save survives to the new page). */
  onNavigated(win: BrowserWindowCtl, tab: TabRuntime): void {
    if (this.detected.delete(tab.id) && win.activeTab()?.id === tab.id) win.pushState();
  }

  forgetTab(id: TabId): void {
    this.detected.delete(id);
    this.pending.delete(id);
    this.autoAsked.delete(id);
    clearTimeout(this.reprobes.get(id));
    this.reprobes.delete(id);
  }

  stateFor(win: BrowserWindowCtl): AutofillBarState {
    const tab = win.activeTab();
    if (!tab) return EMPTY_AUTOFILL;
    const detected = this.detected.get(tab.id);
    const matches = detected && (detected.login || detected.otp) ? win.profile.logins.matchesFor(this.pageUrl(tab)) : [];
    const matchCount = detected?.login ? matches.length : 0;
    const otpAvailable = Boolean(detected?.otp && matches.some((m) => m.hasTotp));
    const save = this.pending.get(tab.id);
    return {
      available: matchCount > 0 || otpAvailable,
      matchCount,
      otpAvailable,
      canSave: Boolean(save),
      saveId: save?.id ?? 0,
      // Never over an agent at work: its tab keeps the key button only.
      savePrompt: Boolean(save && !save.shown && !tab.agentControlled),
    };
  }

  /**
   * The save prompt is opening in the active tab: what was submitted, to show (and edit) in it, and the
   * usernames already saved for the site. Only for the active tab of the asking window; the prompt now
   * counts as shown, so it does not open by itself again for this save.
   */
  pendingSave(win: BrowserWindowCtl): PendingSaveView | null {
    const tab = win.activeTab();
    const save = tab ? this.pending.get(tab.id) : undefined;
    if (!save) return null;
    if (!save.shown) {
      save.shown = true;
      win.pushState();
    }
    return { id: save.id, host: hostOf(save.origin), username: save.username, password: save.password, savedUsernames: win.profile.credentials.usernamesAt(save.origin) };
  }

  suggestions(win: BrowserWindowCtl): CredentialMatch[] {
    const tab = win.activeTab();
    if (!tab) return [];
    return win.profile.logins.matchesFor(this.pageUrl(tab));
  }

  /** Smoke tests read the login field menu instead of showing it; null shows it again. */
  setFieldMenuProbe(probe: ((items: MenuItemConstructorOptions[]) => void) | null): void {
    this.fieldMenuProbe = probe;
  }

  /**
   * The person clicked a login field (reported by the tab preload): list the page's saved accounts in
   * a menu right under the field, as the omnibox key button does. Only in the active, person-driven
   * tab of a page where a login form was detected.
   */
  onLoginFieldClicked(win: BrowserWindowCtl, tab: TabRuntime, box: LoginFieldBox): void {
    if (tab.agentControlled || win.activeTab()?.id !== tab.id || !this.detected.get(tab.id)?.login) return;
    const matches = this.suggestions(win);
    if (matches.length === 0) return;
    const items = loginFieldMenuItems(this.ctx, win, matches);
    if (this.fieldMenuProbe) {
      this.fieldMenuProbe(items);
      return;
    }
    const bounds = tab.view.getBounds();
    const zoom = tab.view.webContents.getZoomFactor();
    showMenuAt(win, items, bounds.x + box.x * zoom, bounds.y + (box.y + box.height) * zoom);
  }

  /**
   * Fills an account of the page (by the id of any of its logins): its username, and its password
   * when it has one (a 2FA-only account leaves the password field alone).
   */
  async fill(win: BrowserWindowCtl, id: string): Promise<void> {
    const tab = win.activeTab();
    if (!tab) return;
    const account = win.profile.logins.accountFor(id, this.pageUrl(tab));
    if (!account) return;
    const password = account.password?.record.password ?? "";
    // Secrets in the page: agents may not script it until it navigates (see secret-fill-guard.ts).
    this.ctx.secretFills.mark(tab.id, password ? [password] : []);
    await this.run<boolean>(tab, fillLoginScript(account.username, password));
  }

  /** Fills the current 2FA code of a page's account into the page's one-time-code field. */
  async fillTotp(win: BrowserWindowCtl, id: string): Promise<void> {
    const tab = win.activeTab();
    if (!tab) return;
    const totp = win.profile.logins.accountFor(id, this.pageUrl(tab))?.totp?.record.totp;
    if (!totp) return;
    const { code } = await totpCode(totp);
    this.ctx.secretFills.mark(tab.id, [code]);
    await this.run<number>(tab, fillOtpScript(code));
  }

  /** The active tab's pending save, if it is still the one with this id. */
  private pendingFor(win: BrowserWindowCtl, id: number): { tab: TabRuntime; save: PendingSave } | null {
    const tab = win.activeTab();
    const save = tab ? this.pending.get(tab.id) : undefined;
    return tab && save?.id === id ? { tab, save } : null;
  }

  /**
   * Saves the pending login with what the prompt holds, which the person may have edited: a username
   * already saved for the site updates that login's password, any other adds a new login.
   */
  acceptSave(win: BrowserWindowCtl, edit: SaveEdit): void {
    const found = this.pendingFor(win, edit.id);
    if (!found || !edit.password) return;
    win.profile.credentials.saveOnSubmit(found.save.origin, edit.username, edit.password);
    this.pending.delete(found.tab.id);
    win.pushState();
  }

  dismissSave(win: BrowserWindowCtl, id: number): void {
    const found = this.pendingFor(win, id);
    if (found && this.pending.delete(found.tab.id)) win.pushState();
  }
}
