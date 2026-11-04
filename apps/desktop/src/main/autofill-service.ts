import { clipboard, webFrameMain, type WebContents, type WebFrameMain } from "electron";
import type { TabId } from "@corvus/shared";
import { addressLine, addressSaveDecision, capturedAddress, cleanAddressFields, type AddressFields } from "../shared/addresses";
import { type AccountPick, planAccountFill } from "../shared/autofill-plan";
import { capturedCard, cardLine, cardSaveDecision, cardTitle, cleanCardFields, type AutofillCard, type CardFields } from "../shared/cards";
import { autofillSiteOf, neverSaveHostOf, sendIdentifier, sentIdentifierFor, type SentIdentifier } from "../shared/autofill-sites";
import { loginDomainOf, originKeyOf, type CredentialMatch, type PasswordOptions } from "../shared/credentials";
import { type AutofillBarState, type AutofillCode, type CapturedAddress, type CapturedCard, type CapturedIdentifier, type CapturedSubmit, type DropdownAction, EMPTY_AUTOFILL, type FieldClick, type PendingSaveView, type SaveEdit } from "../shared/credentials-ipc";
import { dropdownAccounts, dropdownMayOpen } from "../shared/field-dropdown";
import { AUTOFILL_FRAME_FILL_CHANNEL, cardFillAllowed, frameIsTarget, secureCardContext, validCvv, type FrameBox, type FrameTarget } from "../shared/frame-fill";
import { offersGenerator } from "../shared/password-rules";
import type { Settings } from "../shared/settings";
import { codeToFill, totpCode } from "../shared/totp";
import { AUTOFILL_WORLD_ID, detectLoginScript, fillGeneratedScript, fillAddressScript, fillIdentifierScript, fillLoginScript, fillOtpScript, readPasswordFieldScript, type GeneratedFill, type LoginDetection } from "./credential-scripts";
import type { AppContext } from "./context";
import { FieldDropdown, pageOf, type FieldBox, type PasswordOffer } from "./field-dropdown";
import { toMatch, type LoginAccount } from "./login-sources";
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

/** What the prompt for a similar site's login (see similarFit) shows. Resolves true to use it. */
export interface SimilarLoginRequest {
  /** The page's host. */
  host: string;
  /** The host the login is saved for. */
  site: string;
  username: string;
  /** Its 2FA is used: the login is also saved for the page's site. */
  saveCopy: boolean;
}
export type SimilarApprover = (win: BrowserWindowCtl, request: SimilarLoginRequest) => Promise<boolean>;

interface PendingSave {
  id: number;
  origin: string;
  username: string;
  password: string;
  /** The save prompt was shown once: it no longer opens by itself (the key button still reaches it). */
  shown: boolean;
}

/** A sent address form waiting for the choice to save it (as new, or over the saved address it updates). */
interface PendingAddress {
  id: number;
  kind: "new" | "update";
  /** The saved address it updates. */
  targetId: string;
  fields: AddressFields;
  line: string;
  /** The prompt was shown once: it no longer opens by itself. */
  shown: boolean;
}

/** A sent card form waiting for the choice to save it (as new, or over the saved card with its number). Never a CVV. */
interface PendingCard {
  id: number;
  kind: "new" | "update";
  targetId: string;
  fields: CardFields;
  line: string;
  shown: boolean;
}

/** The frame a field click came from: its ids and origin, and whether it is the tab's top frame. */
export interface ClickFrame {
  processId: number;
  routingId: number;
  origin: string;
  top: boolean;
}

/**
 * Asks the person for a card's CVV (Corvus's own prompt); null when they cancel. `site` is the site of
 * the payment frame it fills into when that is not the page's site, else "". Smoke tests answer it themselves.
 */
export type CvvAsker = (win: BrowserWindowCtl, request: { title: string; site: string }) => Promise<string | null>;

interface Detected {
  login: boolean;
  /** No login form, but a two-step sign-in's first step (only the username shows). */
  identifier: boolean;
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

/** The password generator's choices as Settings > passwords keeps them. */
function generatorOptions(p: Settings["passwords"]): PasswordOptions {
  return { length: p.generatorLength, lowercase: p.generatorLowercase, uppercase: p.generatorUppercase, digits: p.generatorDigits, symbols: p.generatorSymbols };
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
  private readonly pendingAddresses = new Map<TabId, PendingAddress>();
  /** Per tab, in memory only: the username sent from a two-step sign-in's first step (see sentIdentifierFor). */
  private readonly identifiers = new Map<TabId, SentIdentifier>();
  private lastSaveId = 0;
  private readonly reprobes = new Map<TabId, NodeJS.Timeout>();
  /** Per tab: origin -> when auto sign-in last asked. */
  private readonly autoAsked = new Map<TabId, Map<string, number>>();
  private autoApprover: AutoSignInApprover | null = null;
  private similarApprover: SimilarApprover | null = null;
  /** Per tab: the similar sites' accounts the person approved on a site (origin -> login ids), so a two-step sign-in asks once. */
  private readonly similarApproved = new Map<TabId, { origin: string; ids: Set<string> }>();
  /** Per window: the account dropdown under a field, made once a page of the window can show it. */
  private readonly dropdowns = new Map<BrowserWindowCtl, FieldDropdown>();
  /** A private window's password generator choices: they last as long as the window, never saved. */
  private readonly privateGenerator = new WeakMap<BrowserWindowCtl, PasswordOptions>();
  /** The page an address dropdown opened over: a pick fills only there. */
  private readonly addressPages = new WeakMap<BrowserWindowCtl, { tabId: TabId; origin: string; target: FrameTarget | null }>();
  /** The page and frame a card dropdown opened over: a pick fills only that frame, while its origin is the same. */
  private readonly cardPages = new WeakMap<BrowserWindowCtl, { tabId: TabId; target: FrameTarget }>();
  private readonly pendingCards = new Map<TabId, PendingCard>();
  /** Card and address fills sent to a frame, waiting for its answer. */
  private readonly frameFills = new Map<number, { processId: number; routingId: number; resolve: (filled: number) => void }>();
  private lastFrameFill = 0;
  private cvvAsker: CvvAsker | null = null;

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

  /** Probes the page for a login form, a two-step sign-in's username step and a 2FA field, and tells the window when that changed. */
  private async probe(win: BrowserWindowCtl, tab: TabRuntime): Promise<Detected> {
    const result = await this.run<LoginDetection>(tab, detectLoginScript());
    const next: Detected = { login: result?.hasPassword === true, identifier: result?.hasIdentifier === true, otp: result?.hasOtp === true };
    // The tab closed meanwhile: nothing to remember for it.
    if (!pageOf(tab)) return next;
    const before = this.detected.get(tab.id) ?? { login: false, identifier: false, otp: false };
    this.detected.set(tab.id, next);
    if ((next.login !== before.login || next.identifier !== before.identifier || next.otp !== before.otp) && win.activeTab()?.id === tab.id) win.pushState();
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
    // The password step of a two-step sign-in often has no username field: the one sent from its first step.
    const username = data.username || sentIdentifierFor(this.identifiers.get(tab.id), origin, Date.now())?.username || "";
    const existing = win.profile.credentials.findByLogin(origin, username);
    if (existing && existing.password === data.password) return; // already saved, unchanged
    this.pending.set(tab.id, { id: ++this.lastSaveId, origin, username, password: data.password, shown: false });
    if (win.activeTab()?.id === tab.id) win.pushState();
  }

  /**
   * The tab preload reported the username sent from a two-step sign-in's first step (typed, then sent or
   * left changed): kept in memory for a few minutes for the tab and site, so the next step offers its
   * account first and the save prompt names it. Only from the page the tab shows.
   */
  onIdentifierSent(win: BrowserWindowCtl, tab: TabRuntime, data: CapturedIdentifier): void {
    const url = this.pageUrl(tab);
    const site = autofillSiteOf(url);
    if (!site || originKeyOf(data.origin) !== originKeyOf(url)) return;
    this.identifiers.set(tab.id, sendIdentifier(this.identifiers.get(tab.id), { site, username: data.username, at: Date.now() }));
  }

  /** A tab committed a navigation: its login probe is stale (a pending save survives to the new page). */
  onNavigated(win: BrowserWindowCtl, tab: TabRuntime): void {
    if (this.detected.delete(tab.id) && win.activeTab()?.id === tab.id) win.pushState();
  }

  forgetTab(id: TabId): void {
    this.detected.delete(id);
    this.similarApproved.delete(id);
    this.pending.delete(id);
    this.pendingAddresses.delete(id);
    this.pendingCards.delete(id);
    this.identifiers.delete(id);
    this.autoAsked.delete(id);
    clearTimeout(this.reprobes.get(id));
    this.reprobes.delete(id);
    for (const dropdown of this.dropdowns.values()) if (dropdown.openOver()?.id === id) dropdown.close();
  }

  stateFor(win: BrowserWindowCtl): AutofillBarState {
    const tab = win.activeTab();
    if (!tab) return EMPTY_AUTOFILL;
    const detected = this.detected.get(tab.id);
    const matches = detected && (detected.login || detected.identifier || detected.otp) ? win.profile.logins.matchesFor(this.pageUrl(tab)) : [];
    const matchCount = detected?.login || detected?.identifier ? matches.length : 0;
    const otpAvailable = Boolean(detected?.otp && matches.some((m) => m.hasTotp));
    const save = this.pending.get(tab.id);
    const address = this.pendingAddresses.get(tab.id);
    const card = this.pendingCards.get(tab.id);
    return {
      available: matchCount > 0 || otpAvailable,
      matchCount,
      otpAvailable,
      canSave: Boolean(save),
      saveId: save?.id ?? 0,
      // Never over an agent at work: its tab keeps the key button only.
      savePrompt: Boolean(save && !save.shown && !tab.agentControlled),
      addressSave: address ? { id: address.id, kind: address.kind, line: address.line } : null,
      addressPrompt: Boolean(address && !address.shown && !tab.agentControlled),
      cardSave: card ? { id: card.id, kind: card.kind, line: card.line } : null,
      cardPrompt: Boolean(card && !card.shown && !tab.agentControlled),
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

  /**
   * The page's accounts: first the one whose username the tab sent from a two-step sign-in's first step
   * (its password step then offers it straight away), else the one filled last on its site.
   */
  suggestions(win: BrowserWindowCtl): CredentialMatch[] {
    const tab = win.activeTab();
    if (!tab) return [];
    const url = this.pageUrl(tab);
    const sent = sentIdentifierFor(this.identifiers.get(tab.id), url, Date.now());
    const sentAccount = sent && (sent.accountId ?? win.profile.logins.accounts(url).find((a) => a.username.trim().toLowerCase() === sent.username.trim().toLowerCase())?.id);
    return win.profile.logins.matchesFor(url, sentAccount || win.profile.siteSettings.lastLogin(autofillSiteOf(url)));
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
      address: (id, field) => void this.fillAddress(win, id, field),
      card: (id) => void this.fillCard(win, id),
      manage: (kind) => win.openSingleton(kind === "address" ? "corvus://passwords/#addresses" : kind === "card" ? "corvus://passwords/#cards" : "corvus://passwords/"),
      usePassword: (password, field) => void this.fillGenerated(win, password, field),
      copyField: (field) => this.copyField(win, field),
      copyText: (text) => clipboard.writeText(text),
      rememberOptions: (options) => this.rememberGenerator(win, options),
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
   * A page found a password field (or a code field the person has a 2FA for): the window's dropdown
   * loads ahead (hidden), so it shows at once on the first click. Never for an agent's tab.
   */
  private warmDropdown(win: BrowserWindowCtl, tab: TabRuntime, fields: Detected): void {
    if ((!fields.login && !fields.identifier && !fields.otp) || tab.agentControlled || win.isDisposed() || this.dropdowns.get(win)?.webContents) return;
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
   * Under a password field, also "Copy password" when it holds something, and a suggested strong
   * password for a new password (or a lone password field with no account to offer, see
   * offersGenerator). The page keeps the keyboard. Only in the active, person-driven tab (never an
   * agent's), and only where the page has such a field: probed again when it was not seen yet, since a
   * two-step sign-in shows its code field after the page loaded. Nothing is filled until the person picks.
   */
  async onFieldClicked(win: BrowserWindowCtl, tab: TabRuntime, click: FieldClick, frame?: ClickFrame): Promise<void> {
    if (click.kind === "card") return this.onCardField(win, tab, click, frame);
    if (click.kind === "address") return this.onAddressField(win, tab, click, frame);
    if (frame && !frame.top) return;
    const active = (): boolean => !tab.agentControlled && win.activeTab()?.id === tab.id;
    const has = (d: Detected | undefined): boolean => Boolean(click.kind === "otp" ? d?.otp : d?.login || d?.identifier);
    if (!active()) return;
    if (!has(this.detected.get(tab.id)) && !has(await this.probe(win, tab))) return;
    const url = this.pageUrl(tab);
    const matches = dropdownAccounts(click.kind, this.suggestions(win));
    const field = click.kind === "login" ? click.password : undefined;
    const offer: PasswordOffer = {
      copy: field?.filled === true,
      generator: field && offersGenerator(field, matches.length > 0) ? { prefs: this.generatorPrefs(win), rules: field.rules } : null,
    };
    const similar = this.similarMatches(win, url, click.kind, matches);
    const page = pageOf(tab);
    if (!page || !active() || (matches.length === 0 && similar.length === 0 && !offer.copy && !offer.generator)) return;
    this.dropdownOf(win).show(tab, page, click, click.kind, loginDomainOf(hostOf(url)), matches, offer, similar);
  }

  /**
   * The person clicked a field of an address form: the saved addresses in the dropdown under it, most
   * recently used first. Only in the active, person-driven tab (never an agent's). Nothing is filled
   * until the person picks.
   */
  private async onAddressField(win: BrowserWindowCtl, tab: TabRuntime, click: FieldClick, frame?: ClickFrame): Promise<void> {
    if (!this.addressesOn() || tab.agentControlled || win.activeTab()?.id !== tab.id) return;
    const addresses = win.profile.addresses.all();
    const page = pageOf(tab);
    if (!page || addresses.length === 0) return;
    const sub = frame && !frame.top ? await this.subframeTarget(page, frame, click) : null;
    if (frame && !frame.top && !sub) return;
    const origin = sub ? sub.target.origin : originOf(this.pageUrl(tab));
    if (!origin || win.activeTab()?.id !== tab.id) return;
    this.addressPages.set(win, { tabId: tab.id, origin, target: sub?.target ?? null });
    const options = addresses.map((a) => ({ id: a.id, title: a.label || a.name || a.company || a.email || a.phone, detail: [a.street.split("\n")[0] ?? "", a.city].filter(Boolean).join(", ") }));
    this.dropdownOf(win).show(tab, page, sub?.shown ?? click, "address", "", [], undefined, [], options);
  }

  /**
   * A saved address picked in the dropdown: filled into the form of the field under it, on the page (or
   * in the frame) the dropdown opened over. Its use is remembered (it is listed first next time), never
   * from a private window.
   */
  async fillAddress(win: BrowserWindowCtl, id: string, field: FieldBox): Promise<void> {
    const tab = win.activeTab();
    const opened = this.addressPages.get(win);
    const address = win.profile.addresses.get(id);
    if (!tab || tab.agentControlled || !opened || opened.tabId !== tab.id || !address) return;
    const filled = opened.target ? await this.fillInFrame(tab, opened.target, { kind: "address", address }) : await this.run<number>(tab, fillAddressScript(address, field, opened.origin));
    if (filled && filled > 0 && !win.isPrivate) win.profile.addresses.noteUsed(id);
  }

  /**
   * The person clicked a field of a card form (in the page or in a payment provider's frame): the saved
   * cards in the dropdown under it, most recently used first. Only in the active, person-driven tab, and
   * only when the page and that frame are secure contexts (see cardFillAllowed). Nothing is filled
   * until the person picks a card and types its CVV.
   */
  private async onCardField(win: BrowserWindowCtl, tab: TabRuntime, click: FieldClick, frame?: ClickFrame): Promise<void> {
    if (!this.cardsOn() || tab.agentControlled || win.activeTab()?.id !== tab.id) return;
    const cards = win.profile.cards.all();
    const page = pageOf(tab);
    if (!page || cards.length === 0 || !secureCardContext(page.getURL())) return;
    let target: FrameTarget;
    let shown: FieldBox = click;
    if (frame && !frame.top) {
      const sub = await this.subframeTarget(page, frame, click);
      if (!sub) return;
      target = sub.target;
      shown = sub.shown;
    } else {
      const main = page.mainFrame;
      const origin = originOf(page.getURL());
      if (!origin) return;
      target = { processId: main.processId, routingId: main.routingId, origin, box: { x: click.x, y: click.y, width: click.width, height: click.height } };
    }
    if (win.activeTab()?.id !== tab.id || !cardFillAllowed(page.getURL(), target.origin)) return;
    this.cardPages.set(win, { tabId: tab.id, target });
    const options = cards.map((c) => ({ id: c.id, title: cardLine(c), detail: c.label || c.nameOnCard }));
    this.dropdownOf(win).show(tab, page, shown, "card", "", [], undefined, [], options);
  }

  /** Smoke tests answer the CVV prompt; null restores Corvus's prompt. */
  setCvvAsker(asker: CvvAsker | null): void {
    this.cvvAsker = asker;
  }

  /**
   * Corvus's CVV prompt (a modal in the window's own UI, not page content): masked, 3 or 4 digits. A
   * payment frame of another site than the page's is named, so the person sees where the card goes. The
   * answer is returned to the one fill that asked and kept nowhere.
   */
  private async askCvv(win: BrowserWindowCtl, card: AutofillCard, site: string): Promise<string | null> {
    const title = cardTitle(card);
    if (this.cvvAsker) return this.cvvAsker(win, { title, site });
    const where = site ? `${tr("Fills into {site}", { site })}\n\n` : "";
    let detail = tr("Corvus fills it into this page once and does not keep it.");
    for (let tries = 0; tries < 3; tries++) {
      const answer = await this.ctx.dialogs.ask(
        {
          tone: "question",
          title: tr("Pay with a saved card"),
          message: tr("Enter the CVV of {card}", { card: title }),
          detail: where + detail,
          buttons: [tr("Cancel"), tr("Fill")],
          defaultId: 1,
          cancelId: 0,
          fields: [{ label: tr("CVV"), value: "", secret: true, required: tr("Type the 3 or 4 digit code on the card.") }],
        },
        win,
      );
      if (answer.button !== 1) return null;
      const cvv = (answer.values?.[0] ?? "").trim();
      if (validCvv(cvv)) return cvv;
      detail = tr("Type the 3 or 4 digit code on the card.");
    }
    return null;
  }

  /**
   * A saved card picked in the dropdown: asks for its CVV, then fills number, name, expiry and that CVV
   * into the form of the field the dropdown opened under, in that frame only, only while its origin is
   * the same and only while the page and the frame are secure contexts. Cancel fills nothing. The CVV
   * is never stored or logged: it lives in this call only.
   */
  async fillCard(win: BrowserWindowCtl, id: string): Promise<void> {
    const tab = win.activeTab();
    const opened = this.cardPages.get(win);
    const card = win.profile.cards.get(id);
    if (!tab || tab.agentControlled || !opened || opened.tabId !== tab.id || !card || !cardFillAllowed(this.pageUrl(tab), opened.target.origin)) return;
    const site = autofillSiteOf(opened.target.origin);
    const cvv = await this.askCvv(win, card, site === autofillSiteOf(this.pageUrl(tab)) ? "" : site);
    if (cvv === null || win.activeTab()?.id !== tab.id || tab.agentControlled || !cardFillAllowed(this.pageUrl(tab), opened.target.origin)) return;
    const fields = cleanCardFields(card);
    // The card in the page: agents may not script it or read it raw until it navigates (see secret-fill-guard.ts).
    this.ctx.secretFills.mark(tab.id, [fields.number, cvv]);
    const filled = await this.fillInFrame(tab, opened.target, { kind: "card", card: fields, cvv });
    if (filled > 0 && !win.isPrivate) win.profile.cards.noteUsed(id);
  }

  /**
   * Where a field clicked in a subframe is: the frame to fill (its ids, its origin now, the field's box in
   * it) and the field's box in the page, for the dropdown. Null when the frame is gone, not the tab's, or
   * not a web page, or its place in the page cannot be found.
   */
  private async subframeTarget(page: WebContents, frame: ClickFrame, click: FieldClick): Promise<{ target: FrameTarget; shown: FieldBox } | null> {
    const found = webFrameMain.fromId(frame.processId, frame.routingId);
    if (!found || !frameIsTarget(frame, found) || !this.frameOfPage(page, found) || !originOf(found.origin)) return null;
    const offset = await frameOffset(found);
    if (!offset) return null;
    const box: FrameBox = { x: click.x, y: click.y, width: click.width, height: click.height };
    return { target: { processId: frame.processId, routingId: frame.routingId, origin: frame.origin, box }, shown: { ...box, x: box.x + offset.x, y: box.y + offset.y } };
  }

  /** The frame belongs to this tab's page. */
  private frameOfPage(page: WebContents, frame: WebFrameMain): boolean {
    const top = frame.top;
    const main = page.mainFrame;
    return Boolean(top) && top!.processId === main.processId && top!.routingId === main.routingId;
  }

  /**
   * Sends a card or address fill to the frame it is for, only while that frame is still the tab's and has
   * the origin it had on the click; resolves with the fields its preload wrote (0 on refusal or timeout).
   */
  private fillInFrame(tab: TabRuntime, target: FrameTarget, body: { kind: "card"; card: CardFields; cvv: string } | { kind: "address"; address: AddressFields }): Promise<number> {
    const page = pageOf(tab);
    const frame = webFrameMain.fromId(target.processId, target.routingId);
    if (!page || !frame || !frameIsTarget(target, frame) || !this.frameOfPage(page, frame)) return Promise.resolve(0);
    const token = ++this.lastFrameFill;
    return new Promise<number>((resolve) => {
      const timer = setTimeout(() => {
        this.frameFills.delete(token);
        resolve(0);
      }, SCRIPT_TIMEOUT_MS);
      this.frameFills.set(token, {
        processId: target.processId,
        routingId: target.routingId,
        resolve: (filled) => {
          clearTimeout(timer);
          resolve(filled);
        },
      });
      try {
        frame.send(AUTOFILL_FRAME_FILL_CHANNEL, { token, origin: target.origin, box: target.box, ...body });
      } catch {
        this.frameFills.delete(token);
        clearTimeout(timer);
        resolve(0);
      }
    });
  }

  /** A frame answered a fill sent to it (only the frame it was sent to counts). */
  onFrameFilled(processId: number, routingId: number, data: { token: number; filled: number }): void {
    const pending = this.frameFills.get(data.token);
    if (!pending || pending.processId !== processId || pending.routingId !== routingId) return;
    this.frameFills.delete(data.token);
    pending.resolve(data.filled);
  }

  /**
   * The accounts of similar sites (see similarFit) the dropdown offers apart under a field: under a code
   * field those with a 2FA, under a login field all, less a username the page's own accounts already
   * offer for that field.
   */
  private similarMatches(win: BrowserWindowCtl, url: string, kind: FieldClick["kind"], matches: CredentialMatch[]): CredentialMatch[] {
    const user = (m: CredentialMatch): string => m.username.trim().toLowerCase();
    const offered = new Set(matches.filter((m) => (kind === "otp" ? m.hasTotp : m.hasPassword)).map(user));
    return dropdownAccounts(kind, win.profile.logins.similarAccounts(url).map(toMatch)).filter((m) => !offered.has(user(m)));
  }

  /** The password generator's choices: the person's last ones (a private window's own while it is open). */
  private generatorPrefs(win: BrowserWindowCtl): PasswordOptions {
    return this.privateGenerator.get(win) ?? generatorOptions(this.ctx.settings.get().passwords);
  }

  /** Remembers the generator's choices for next time; a private window keeps them only while it is open. */
  private rememberGenerator(win: BrowserWindowCtl, o: PasswordOptions): void {
    if (win.isPrivate) this.privateGenerator.set(win, o);
    else this.ctx.settings.update({ passwords: { generatorLength: o.length, generatorLowercase: o.lowercase, generatorUppercase: o.uppercase, generatorDigits: o.digits, generatorSymbols: o.symbols } });
  }

  /**
   * Use in the generator: fills the generated password into the active tab's form under the dropdown
   * (its new password and confirmation, never its current one), then keeps it ready to save until the
   * form is submitted: the key button offers it at once (the page may fail, or sign up without a form
   * submit), and the submit's own save prompt replaces it.
   */
  async fillGenerated(win: BrowserWindowCtl, password: string, field: FieldBox): Promise<void> {
    const tab = win.activeTab();
    if (!tab || tab.agentControlled) return;
    this.ctx.secretFills.mark(tab.id, [password]);
    const result = await this.run<GeneratedFill>(tab, fillGeneratedScript(password, field));
    const origin = originKeyOf(this.pageUrl(tab));
    if (!result?.filled || !origin || win.profile.siteSettings.isNeverSave(neverSaveHostOf(origin))) return;
    this.pending.set(tab.id, { id: ++this.lastSaveId, origin, username: result.username, password, shown: true });
    if (win.activeTab()?.id === tab.id) win.pushState();
  }

  /** "Copy password": what the active tab's password field under the dropdown holds goes to the clipboard; false when nothing. */
  async copyField(win: BrowserWindowCtl, field: FieldBox): Promise<boolean> {
    const tab = win.activeTab();
    if (!tab || tab.agentControlled) return false;
    const value = await this.run<string>(tab, readPasswordFieldScript(field));
    if (!value) return false;
    clipboard.writeText(value);
    return true;
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
    if (account) await this.fillAccount(win, tab, url, account, pick);
    else await this.fillSimilar(win, tab, url, id, pick);
  }

  /**
   * An account of a similar site (see similarFit), picked in the dropdown's own section for it: only
   * once the person confirms, since a site of the same name can belong to someone else, and only while
   * the page is still where it was. Picked for the 2FA code, the login is also saved for the page's
   * site with the same 2FA (see copyLogin); picked for the login, the save prompt that follows the
   * sign-in offers to keep it for this site.
   */
  private async fillSimilar(win: BrowserWindowCtl, tab: TabRuntime, url: string, id: string, pick: AccountPick): Promise<void> {
    const account = win.profile.logins.similarAccountFor(id, url);
    const origin = originKeyOf(url);
    if (!account || !origin || tab.agentControlled) return;
    const saveCopy = pick === "code" && Boolean(account.totp) && !win.isPrivate;
    const approved = this.similarApproved.get(tab.id);
    const known = approved?.origin === origin && account.entries.some((e) => approved.ids.has(e.record.id));
    // Once approved in the tab, the login is not asked again; saving it here with its 2FA always is.
    if ((!known || saveCopy) && !(await this.askSimilar(win, { host: hostOf(origin), site: account.primary.host, username: account.username, saveCopy }))) return;
    if (win.activeTab()?.id !== tab.id || this.pageUrl(tab) !== url) return;
    this.similarApproved.set(tab.id, { origin, ids: new Set([...(approved?.origin === origin ? approved.ids : []), ...account.entries.map((e) => e.record.id)]) });
    if (saveCopy) this.copyLogin(win, tab, origin, account);
    await this.fillAccount(win, tab, url, account, pick, { note: false });
  }

  private async askSimilar(win: BrowserWindowCtl, req: SimilarLoginRequest): Promise<boolean> {
    if (this.similarApprover) return this.similarApprover(win, req);
    const { response } = await this.ctx.dialogs.messageBox({
      type: "warning",
      buttons: [tr("Cancel"), tr("Use this login")],
      defaultId: 0,
      cancelId: 0,
      title: tr("A login from another site"),
      message: tr("Use the login saved for {site} on {host}?", { site: req.site, host: req.host }),
      detail: [
        tr("{host} has the same name as {site} but is another site. Use this login only if you know both belong to the same company: a fake site with a similar name could steal it.", { host: req.host, site: req.site }),
        ...(req.saveCopy ? [tr("Corvus also saves a copy of this login, with its 2FA, for {host}.", { host: req.host })] : []),
      ].join("\n\n"),
    }, win);
    return response === 1;
  }

  /** Smoke tests answer the similar site prompt; null restores the dialog. */
  setSimilarApprover(approver: SimilarApprover | null): void {
    this.similarApprover = approver;
  }

  /**
   * The person used a similar site's 2FA here: its login is saved for this site too, with the same 2FA,
   * so the next sign-in here offers it as this site's own. A login of the same username already saved
   * here gets the 2FA when it has none; one with its own 2FA is left as it is. A save waiting in the tab
   * for that same login is then done.
   */
  private copyLogin(win: BrowserWindowCtl, tab: TabRuntime, origin: string, account: LoginAccount): void {
    const totp = account.totp?.record.totp;
    if (!totp) return;
    const password = account.password?.record.password ?? "";
    const existing = win.profile.credentials.findByLogin(origin, account.username);
    if (existing) {
      if (!existing.totp) win.profile.credentials.update(existing.id, { totp });
    } else {
      win.profile.credentials.add({ origin, username: account.username, password, totp });
    }
    const save = this.pending.get(tab.id);
    if (save && save.origin === origin && save.username === account.username && save.password === (existing?.password ?? password)) {
      this.pending.delete(tab.id);
      win.pushState();
    }
  }

  /** Fills an account of the page as fill() says; `note: false` leaves the site's last used account as it was. */
  private async fillAccount(win: BrowserWindowCtl, tab: TabRuntime, url: string, account: LoginAccount, pick: AccountPick, opts: { note?: boolean } = {}): Promise<void> {
    const page = await this.run<LoginDetection>(tab, detectLoginScript());
    const plan = planAccountFill(pick, { hasTotp: Boolean(account.totp) }, { login: page?.hasPassword === true, identifier: page?.hasIdentifier === true, otp: page?.hasOtp === true });
    const totp = plan.code ? account.totp?.record.totp : undefined;
    const code = totp ? await codeToFill(totp) : null;
    if (plan.login === "none" && !code) return;
    if (opts.note !== false) this.noteUsed(win, url, account.id);
    // A two-step sign-in's first step gets the username alone; its next step offers the account first.
    if (plan.usernameOnly) {
      this.identifiers.set(tab.id, { site: autofillSiteOf(url), username: account.username, accountId: account.id, at: Date.now() });
      await this.run<boolean>(tab, fillIdentifierScript(account.username, { keepTyped: plan.login === "empty" }));
    }
    const password = plan.usernameOnly ? "" : (account.password?.record.password ?? "");
    const secrets = [password, code?.code ?? ""].filter(Boolean);
    // Secrets in the page: agents may not script it until it navigates (see secret-fill-guard.ts).
    if (secrets.length > 0 || !plan.usernameOnly) this.ctx.secretFills.mark(tab.id, secrets);
    if (plan.login !== "none" && !plan.usernameOnly) await this.run<boolean>(tab, fillLoginScript(account.username, password, { keepTyped: plan.login === "empty" }));
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

  /**
   * The tab preload reported a sent address form: offer to save it as a new address, or to update the
   * saved one it matches with what changed. Never from a private window, a tab the agent works in, or
   * with addresses turned off in Settings; only from the page the tab shows.
   */
  onAddressCaptured(win: BrowserWindowCtl, tab: TabRuntime, data: CapturedAddress): void {
    if (originKeyOf(data.origin) !== originKeyOf(this.pageUrl(tab))) return;
    const fields = cleanAddressFields(capturedAddress(data.fields));
    const saved = win.profile.addresses.all();
    const decision = addressSaveDecision(fields, saved, { private: win.isPrivate, agent: tab.agentControlled, enabled: this.addressesOn() });
    if (decision.kind === "none") return;
    const targetId = decision.kind === "update" ? decision.id : "";
    const shown = saved.find((a) => a.id === targetId);
    const line = addressLine(shown ? { ...shown, ...nonEmpty(fields) } : fields);
    this.pendingAddresses.set(tab.id, { id: ++this.lastSaveId, kind: decision.kind, targetId, fields, line, shown: false });
    if (win.activeTab()?.id === tab.id) win.pushState();
  }

  /** The active tab's pending address, if it is still the one with this id. */
  private pendingAddressFor(win: BrowserWindowCtl, id: number): { tab: TabRuntime; address: PendingAddress } | null {
    const tab = win.activeTab();
    const address = tab ? this.pendingAddresses.get(tab.id) : undefined;
    return tab && address?.id === id ? { tab, address } : null;
  }

  addressSaveShown(win: BrowserWindowCtl, id: number): void {
    const found = this.pendingAddressFor(win, id);
    if (found && !found.address.shown) {
      found.address.shown = true;
      win.pushState();
    }
  }

  /** Saves the pending address: a new one, or only the fields the form filled over the saved one it updates. */
  acceptAddressSave(win: BrowserWindowCtl, id: number): void {
    const found = this.pendingAddressFor(win, id);
    if (!found) return;
    const { address } = found;
    if (address.kind === "update") win.profile.addresses.update(address.targetId, nonEmpty(address.fields));
    else win.profile.addresses.add(address.fields);
    this.pendingAddresses.delete(found.tab.id);
    win.pushState();
  }

  dismissAddressSave(win: BrowserWindowCtl, id: number): void {
    const found = this.pendingAddressFor(win, id);
    if (found && this.pendingAddresses.delete(found.tab.id)) win.pushState();
  }

  /** Settings > Passwords > Save and fill addresses. */
  private addressesOn(): boolean {
    return this.ctx.settings.get().passwords.addresses;
  }

  /**
   * The tab preload reported a sent card form (its number, name and expiry; it never reads the CVV):
   * offer to save it as a new card, or to update the saved card with that number. Only a Luhn-valid
   * number, never from a private window, a tab the agent works in, or with payment methods turned off.
   */
  onCardCaptured(win: BrowserWindowCtl, tab: TabRuntime, data: CapturedCard): void {
    if (originKeyOf(data.origin) !== originKeyOf(this.pageUrl(tab))) return;
    const fields = cleanCardFields(capturedCard(data.fields));
    const saved = win.profile.cards.all();
    const decision = cardSaveDecision(fields, saved, { private: win.isPrivate, agent: tab.agentControlled, enabled: this.cardsOn() });
    if (decision.kind === "none") return;
    const targetId = decision.kind === "update" ? decision.id : "";
    const shown = saved.find((c) => c.id === targetId);
    const line = cardLine(shown ? { ...shown, ...nonEmptyCard(fields) } : fields);
    this.pendingCards.set(tab.id, { id: ++this.lastSaveId, kind: decision.kind, targetId, fields, line, shown: false });
    if (win.activeTab()?.id === tab.id) win.pushState();
  }

  private pendingCardFor(win: BrowserWindowCtl, id: number): { tab: TabRuntime; card: PendingCard } | null {
    const tab = win.activeTab();
    const card = tab ? this.pendingCards.get(tab.id) : undefined;
    return tab && card?.id === id ? { tab, card } : null;
  }

  cardSaveShown(win: BrowserWindowCtl, id: number): void {
    const found = this.pendingCardFor(win, id);
    if (found && !found.card.shown) {
      found.card.shown = true;
      win.pushState();
    }
  }

  /** Saves the pending card: a new one, or the new name and expiry over the saved card with its number. */
  acceptCardSave(win: BrowserWindowCtl, id: number): void {
    const found = this.pendingCardFor(win, id);
    if (!found) return;
    const { card } = found;
    if (card.kind === "update") win.profile.cards.update(card.targetId, nonEmptyCard(card.fields));
    else win.profile.cards.add(card.fields);
    this.pendingCards.delete(found.tab.id);
    win.pushState();
  }

  dismissCardSave(win: BrowserWindowCtl, id: number): void {
    const found = this.pendingCardFor(win, id);
    if (found && this.pendingCards.delete(found.tab.id)) win.pushState();
  }

  /** Settings > Passwords > Save and fill payment methods. */
  private cardsOn(): boolean {
    return this.ctx.settings.get().passwords.cards;
  }
}

function nonEmptyCard(f: CardFields): Partial<CardFields> {
  return Object.fromEntries(Object.entries(f).filter(([, v]) => v !== "")) as Partial<CardFields>;
}

/**
 * Where a subframe's viewport is in the tab's page: the offset of each frame element up the chain,
 * read in each parent's main world (only the dropdown's position depends on it). Null when a frame
 * element cannot be found.
 */
async function frameOffset(frame: WebFrameMain): Promise<{ x: number; y: number } | null> {
  let x = 0;
  let y = 0;
  let child: WebFrameMain = frame;
  for (let depth = 0; depth < 10; depth++) {
    const parent = child.parent;
    if (!parent) return { x, y };
    const index = parent.frames.findIndex((f) => f.frameTreeNodeId === child.frameTreeNodeId);
    if (index < 0) return null;
    let box: { x: number; y: number } | null = null;
    try {
      box = (await withTimeout(
        parent.executeJavaScript(
          `(() => { const w = window.frames[${index}]; for (const el of document.querySelectorAll("iframe, frame")) { if (el.contentWindow === w) { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return { x: r.left + el.clientLeft + parseFloat(s.paddingLeft || "0"), y: r.top + el.clientTop + parseFloat(s.paddingTop || "0") }; } } return null; })()`,
        ) as Promise<{ x: number; y: number } | null>,
        SCRIPT_TIMEOUT_MS,
      )) ?? null;
    } catch {
      return null;
    }
    if (!box || !Number.isFinite(box.x) || !Number.isFinite(box.y)) return null;
    x += box.x;
    y += box.y;
    child = parent;
  }
  return null;
}

/** A web page's origin ("https://shop.example"), or null for anything else. */
function originOf(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:" ? u.origin : null;
  } catch {
    return null;
  }
}

/** The fields that hold something: an update never clears what the form left empty. */
function nonEmpty(f: AddressFields): Partial<AddressFields> {
  return Object.fromEntries(Object.entries(f).filter(([, v]) => v !== "")) as Partial<AddressFields>;
}
