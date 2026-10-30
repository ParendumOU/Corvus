import { clipboard, type WebContents } from "electron";
import type { TabId } from "@corvus/shared";
import { type AccountPick, planAccountFill } from "../shared/autofill-plan";
import { autofillSiteOf, neverSaveHostOf } from "../shared/autofill-sites";
import { loginDomainOf, originKeyOf, type CredentialMatch } from "../shared/credentials";
import { type AutofillBarState, type AutofillCode, type CapturedSubmit, type DropdownAction, EMPTY_AUTOFILL, type FieldClick, type PendingSaveView, type SaveEdit } from "../shared/credentials-ipc";
import { dropdownAccounts, dropdownMayOpen } from "../shared/field-dropdown";
import { codeToFill, totpCode } from "../shared/totp";
import { AUTOFILL_WORLD_ID, detectLoginScript, fillLoginScript, fillOtpScript, type LoginDetection } from "./credential-scripts";
import type { AppContext } from "./context";
import { FieldDropdown, pageOf } from "./field-dropdown";
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

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

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
  /** Per window: the account dropdown under a field, made once a page of the window can show it. */
  private readonly dropdowns = new Map<BrowserWindowCtl, FieldDropdown>();

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
    await this.run<boolean>(tab, fillLoginScript(current.username, current.password, { submit: true }));
  }

  private async run<T>(tab: TabRuntime, code: string): Promise<T | null> {
    const wc = pageOf(tab);
    if (!wc || !isWebPage(wc.getURL())) return null;
    try {
      return (await withTimeout(wc.executeJavaScriptInIsolatedWorld(AUTOFILL_WORLD_ID, [{ code }]) as Promise<T>, SCRIPT_TIMEOUT_MS)) ?? null;
    } catch {
      return null;
    }
  }

  private pageUrl(tab: TabRuntime): string {
    return pageOf(tab)?.getURL() ?? tab.url;
  }

  /** Probes the page for a login form and a 2FA field, and tells the window when that changed. */
  private async probe(win: BrowserWindowCtl, tab: TabRuntime): Promise<Detected> {
    const result = await this.run<LoginDetection>(tab, detectLoginScript());
    const next: Detected = { login: result?.hasPassword === true, otp: result?.hasOtp === true };
    // The tab closed meanwhile: nothing to remember for it.
    if (!pageOf(tab)) return next;
    const before = this.detected.get(tab.id) ?? { login: false, otp: false };
    this.detected.set(tab.id, next);
    if ((next.login !== before.login || next.otp !== before.otp) && win.activeTab()?.id === tab.id) win.pushState();
    this.warmDropdown(win, tab, next);
    return next;
  }

  /** A page finished loading: probe it for a login form or 2FA field so the omnibox can offer autofill. */
  async onPageLoad(win: BrowserWindowCtl, tab: TabRuntime): Promise<void> {
    if ((await this.probe(win, tab)).login) await this.maybeAutoSignIn(win, tab);
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
    if (!origin || !data.password || win.profile.siteSettings.isNeverSave(neverSaveHostOf(origin))) return;
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
    for (const dropdown of this.dropdowns.values()) if (dropdown.openOver()?.id === id) dropdown.close();
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

  /** The page's accounts, the one filled last on its site first. */
  suggestions(win: BrowserWindowCtl): CredentialMatch[] {
    const tab = win.activeTab();
    if (!tab) return [];
    const url = this.pageUrl(tab);
    return win.profile.logins.matchesFor(url, win.profile.siteSettings.lastLogin(autofillSiteOf(url)));
  }

  /** Remembers the account used on the page's site, so it is offered first there next time (never from a private window). */
  private noteUsed(win: BrowserWindowCtl, url: string, accountId: string): void {
    if (!win.isPrivate) win.profile.siteSettings.noteLastLogin(autofillSiteOf(url), accountId);
  }

  private dropdownOf(win: BrowserWindowCtl): FieldDropdown {
    const existing = this.dropdowns.get(win);
    if (existing) return existing;
    const dropdown = new FieldDropdown(win, {
      account: (kind, id) => void (kind === "otp" ? this.fillTotp(win, id) : this.fill(win, id)),
      manage: () => win.openSingleton("corvus://passwords/"),
    });
    this.dropdowns.set(win, dropdown);
    win.win.once("closed", () => {
      this.dropdowns.delete(win);
      dropdown.dispose();
    });
    return dropdown;
  }

  /** The account dropdown of a window, once a page of it could show one (for the smoke test). */
  fieldDropdown(win: BrowserWindowCtl): FieldDropdown | undefined {
    return this.dropdowns.get(win);
  }

  /** The window laid out its views again: its dropdown closes when its page was hidden or moved. */
  onWindowLayout(win: BrowserWindowCtl): void {
    this.dropdowns.get(win)?.onLayout();
  }

  /**
   * A page found a login or code field: when the person has accounts for it, the window's dropdown
   * loads ahead (hidden), so it shows at once on the first click. Never for an agent's tab.
   */
  private warmDropdown(win: BrowserWindowCtl, tab: TabRuntime, fields: Detected): void {
    if ((!fields.login && !fields.otp) || tab.agentControlled || win.isDisposed() || this.dropdowns.get(win)?.webContents) return;
    if (dropdownMayOpen(fields, win.profile.logins.matchesFor(this.pageUrl(tab)))) this.dropdownOf(win).warm();
  }

  /** The dropdown view `sender` reported its size, or the entry the mouse is over or pressed. */
  onDropdownAction(sender: WebContents, action: DropdownAction): void {
    for (const dropdown of this.dropdowns.values()) if (dropdown.webContents === sender) dropdown.onAction(action);
  }

  /** The tab preload says the person typed or pasted in the field, moved the keyboard elsewhere in the page, or scrolled it. */
  onDropdownDone(win: BrowserWindowCtl, tab: TabRuntime): void {
    this.dropdowns.get(win)?.onPageDone(tab);
  }

  /**
   * The person clicked a login field or a one-time-code field, or pressed the down arrow in it (reported
   * by the tab preload): list the page's saved accounts in the dropdown right under it (see
   * field-dropdown.ts), as the omnibox key button does; under a code field, the accounts with a 2FA.
   * The page keeps the keyboard. Only in the active, person-driven tab, and only where the page has
   * such a field: probed again when it was not seen yet, since a two-step sign-in shows its code field
   * after the page loaded. Nothing is filled until the person picks.
   */
  async onFieldClicked(win: BrowserWindowCtl, tab: TabRuntime, click: FieldClick): Promise<void> {
    const active = (): boolean => !tab.agentControlled && win.activeTab()?.id === tab.id;
    const has = (d: Detected | undefined): boolean => Boolean(click.kind === "otp" ? d?.otp : d?.login);
    if (!active()) return;
    if (!has(this.detected.get(tab.id)) && !has(await this.probe(win, tab))) return;
    const url = this.pageUrl(tab);
    const matches = dropdownAccounts(click.kind, this.suggestions(win));
    const page = pageOf(tab);
    if (!page || !active() || matches.length === 0) return;
    this.dropdownOf(win).show(tab, page, click, click.kind, loginDomainOf(hostOf(url)), matches);
  }

  /**
   * Fills an account of the page (by the id of any of its logins) as planAccountFill says: picked for
   * the login, its username and password (a 2FA-only account leaves the password field alone) and,
   * when the page asks for one, its current 2FA code, in one action; picked for the code, the code and
   * whatever login fields are still empty. A code about to expire is replaced by the next one, filled
   * the moment it takes over (the login fields do not wait for it).
   */
  async fill(win: BrowserWindowCtl, id: string, pick: AccountPick = "account"): Promise<void> {
    const tab = win.activeTab();
    if (!tab) return;
    const url = this.pageUrl(tab);
    const account = win.profile.logins.accountFor(id, url);
    if (!account) return;
    const page = await this.run<LoginDetection>(tab, detectLoginScript());
    const plan = planAccountFill(pick, { hasTotp: Boolean(account.totp) }, { login: page?.hasPassword === true, otp: page?.hasOtp === true });
    const totp = plan.code ? account.totp?.record.totp : undefined;
    const code = totp ? await codeToFill(totp) : null;
    if (plan.login === "none" && !code) return;
    this.noteUsed(win, url, account.id);
    const password = account.password?.record.password ?? "";
    // Secrets in the page: agents may not script it until it navigates (see secret-fill-guard.ts).
    this.ctx.secretFills.mark(tab.id, [password, code?.code ?? ""].filter(Boolean));
    if (plan.login !== "none") await this.run<boolean>(tab, fillLoginScript(account.username, password, { keepTyped: plan.login === "empty" }));
    if (!code) return;
    if (code.waitMs > 0) await delay(code.waitMs);
    if (this.pageUrl(tab) === url) await this.run<number>(tab, fillOtpScript(code.code));
  }

  /** Fills the current 2FA code of a page's account, and its login where those fields are empty. */
  fillTotp(win: BrowserWindowCtl, id: string): Promise<void> {
    return this.fill(win, id, "code");
  }

  /** The current codes of the active page's accounts with a 2FA, only while the page has a code field. */
  async codes(win: BrowserWindowCtl): Promise<AutofillCode[]> {
    const tab = win.activeTab();
    if (!tab || !this.detected.get(tab.id)?.otp) return [];
    const accounts = win.profile.logins.accounts(this.pageUrl(tab)).flatMap((a) => (a.totp?.record.totp ? [{ id: a.id, totp: a.totp.record.totp }] : []));
    return Promise.all(
      accounts.map(async ({ id, totp }) => {
        const { code, expiresAt } = await totpCode(totp);
        return { id, code, expiresAt };
      }),
    );
  }

  /**
   * Copies the current 2FA code of a page's account to the clipboard (for a page without a code field
   * yet); false when there was nothing to copy. Corvus leaves the clipboard as it is afterwards, as
   * for every other copy.
   */
  async copyTotp(win: BrowserWindowCtl, id: string): Promise<boolean> {
    const tab = win.activeTab();
    if (!tab) return false;
    const url = this.pageUrl(tab);
    const account = win.profile.logins.accountFor(id, url);
    const totp = account?.totp?.record.totp;
    if (!account || !totp) return false;
    clipboard.writeText((await totpCode(totp)).code);
    this.noteUsed(win, url, account.id);
    return true;
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

  /**
   * "Never for this site": drops the pending save and stops offering to save logins on its exact host
   * (another host of the same domain still asks). Settings > Passwords lists the host to take it off.
   */
  neverSave(win: BrowserWindowCtl, id: number): void {
    const found = this.pendingFor(win, id);
    if (!found) return;
    win.profile.siteSettings.setNeverSave(neverSaveHostOf(found.save.origin), true);
    this.pending.delete(found.tab.id);
    win.pushState();
  }
}
