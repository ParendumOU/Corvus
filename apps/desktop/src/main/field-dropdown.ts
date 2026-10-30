import { WebContentsView, type Rectangle, type WebContents } from "electron";
import { splitAccounts, type CredentialMatch } from "../shared/credentials";
import { AUTOFILL_DROPDOWN_CHANNEL, FIELD_MENU_EVENT, type AutofillFieldKind, type DropdownAction, type FieldDropdownState } from "../shared/credentials-ipc";
import { DROPDOWN_WIDTH, dropdownBounds, dropdownEntries, dropdownStays, moveHighlight } from "../shared/field-dropdown";
import { uiLanguage } from "./menu-i18n";
import { paths } from "./paths";
import type { BrowserWindowCtl, TabRuntime } from "./window";

/** How long after a click on the dropdown the page's "the field lost the keyboard" is put down to that click. */
const PRESS_GRACE_MS = 400;

/** A tab's page, or null once the tab closed (Electron then drops it from the view: `webContents` is undefined). */
export function pageOf(tab: TabRuntime): WebContents | null {
  const wc = tab.view.webContents as WebContents | undefined;
  return wc && !wc.isDestroyed() ? wc : null;
}

/** What the person chose in the dropdown: an account (for the field's kind), or the Passwords page. */
export interface DropdownPicks {
  account(kind: AutofillFieldKind, id: string): void;
  manage(): void;
}

/** Where the field is, in the page's CSS pixels (the box the tab preload reported). */
export interface FieldBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The account dropdown of one window, under the login or code field the person clicked. Unlike a
 * native menu, it never takes the keyboard: the page and its field keep it, so typing, pasting and
 * the arrows in the text work as usual. The arrow keys move its highlight and Enter picks only while
 * it is open (read before the page gets them); typing or pasting in the field, Escape, Tab, a click
 * elsewhere, the keyboard leaving the page, a scroll or a navigation close it, and so does anything
 * that hides or moves the page (another tab, a split view, the sidebar or the Assist panel, a resize)
 * or the window going to the background, even when the keyboard stays where it was. A click on it
 * gives the keyboard straight back to the page. Its view loads ahead, hidden, once a page of the
 * window can show it (see warm), so the first one shows at once.
 */
export class FieldDropdown {
  private view: WebContentsView | null = null;
  private ready = false;
  private current: FieldDropdownState | null = null;
  private tab: TabRuntime | null = null;
  /** The field's box in the window's coordinates. */
  private anchor: Rectangle = { x: 0, y: 0, width: 0, height: 0 };
  /** Where the page's view was when the dropdown opened: it closes once the page moves (see onLayout). */
  private pageBounds: Rectangle = { x: 0, y: 0, width: 0, height: 0 };
  private token = 0;
  private detach: (() => void) | null = null;
  /** When a click last gave the dropdown's view the keyboard (it is handed straight back to the page). */
  private pressedAt = 0;

  constructor(
    private readonly win: BrowserWindowCtl,
    private readonly picks: DropdownPicks,
  ) {}

  /** The open dropdown's state (null when closed), for the smoke test. */
  state(): FieldDropdownState | null {
    return this.current;
  }

  get webContents(): WebContents | null {
    return this.view && !this.view.webContents.isDestroyed() ? this.view.webContents : null;
  }

  /** The tab the dropdown is open over, if it is open. */
  openOver(): TabRuntime | null {
    return this.current ? this.tab : null;
  }

  /**
   * Loads the dropdown's view ahead, hidden, so its first open shows at once instead of waiting for it
   * to load. Each costs a renderer process, so only once a page of the window can show the dropdown.
   */
  warm(): void {
    this.ensure();
  }

  /** The window closed: its dropdown's page goes too (Electron does not close a view's page with its window). */
  dispose(): void {
    this.current = null;
    this.detach?.();
    this.detach = null;
    const wc = this.webContents;
    this.view = null;
    wc?.close();
  }

  private ensure(): WebContentsView {
    if (this.view) return this.view;
    const view = new WebContentsView({ webPreferences: { preload: paths.assistPreload, contextIsolation: true, nodeIntegration: false, sandbox: true } });
    view.setBackgroundColor("#00000000");
    view.setVisible(false);
    const wc = view.webContents;
    wc.setWindowOpenHandler(() => ({ action: "deny" }));
    wc.on("will-navigate", (event) => event.preventDefault());
    wc.on("did-finish-load", () => {
      this.ready = true;
      this.post();
    });
    // A click on the dropdown gives its view the keyboard: hand it straight back to the page.
    wc.on("focus", () => {
      this.pressedAt = Date.now();
      setImmediate(() => {
        const page = this.tab && pageOf(this.tab);
        if (page && !wc.isDestroyed() && wc.isFocused()) page.focus();
      });
    });
    // Out of the window until it first shows (see place): its page takes the keyboard as it loads,
    // which must not leave the page or the address bar meanwhile.
    void wc.loadURL("corvus://field-menu/");
    this.view = view;
    return view;
  }

  private post(): void {
    if (this.ready) this.webContents?.send(FIELD_MENU_EVENT, this.current);
  }

  /** Opens the dropdown (or moves it) under a field of the active tab, listing `matches`. */
  show(tab: TabRuntime, page: WebContents, field: FieldBox, kind: AutofillFieldKind, domain: string, matches: CredentialMatch[]): void {
    if (this.tab !== tab) this.close();
    const reattach = this.tab !== tab || !this.current;
    const bounds = tab.view.getBounds();
    const zoom = page.getZoomFactor();
    this.pageBounds = bounds;
    this.anchor = { x: Math.round(bounds.x + field.x * zoom), y: Math.round(bounds.y + field.y * zoom), width: Math.round(field.width * zoom), height: Math.round(field.height * zoom) };
    const { first, others } = splitAccounts(matches);
    this.current = {
      token: ++this.token,
      kind,
      language: uiLanguage(),
      domain,
      first,
      others,
      othersOpen: false,
      maxWidth: Math.max(160, Math.min(DROPDOWN_WIDTH, bounds.width)),
      highlight: null,
    };
    if (reattach) this.attach(tab, page);
    this.tab = tab;
    page.send(AUTOFILL_DROPDOWN_CHANNEL, true);
    this.ensure();
    this.post();
  }

  close(): void {
    if (!this.current) return;
    this.current = null;
    this.view?.setVisible(false);
    this.post();
    this.detach?.();
    this.detach = null;
    const page = this.tab && pageOf(this.tab);
    page?.send(AUTOFILL_DROPDOWN_CHANNEL, false);
  }

  /** The view reported its size, the mouse moved over an entry or pressed one. */
  onAction(action: DropdownAction): void {
    const state = this.current;
    if (!state || action.token !== state.token) return;
    if (action.type === "size") this.place(action.width, action.height);
    else if (action.type === "hover") this.highlight(action.index);
    else this.activate(action.index);
  }

  /** The tab preload says the person typed or pasted in the field, moved the keyboard elsewhere in the page, or scrolled it. */
  onPageDone(tab: TabRuntime): void {
    // A click on the dropdown takes the keyboard from the field for a moment: that is not leaving it.
    if (this.tab === tab && Date.now() - this.pressedAt > PRESS_GRACE_MS) this.close();
  }

  /**
   * The window laid out its views (a tab switch, a split view, the sidebar or the Assist panel, a
   * resize): the dropdown closes unless its page is still the active tab's, shown, where it was.
   */
  onLayout(): void {
    const tab = this.openOver();
    if (tab && !dropdownStays({ active: this.win.activeTab() === tab, visible: tab.view.getVisible(), bounds: tab.view.getBounds() }, this.pageBounds)) this.close();
  }

  /** Where the dropdown is in the window while it shows (null when hidden), for the smoke test. */
  bounds(): Rectangle | null {
    return this.current && this.view?.getVisible() ? this.view.getBounds() : null;
  }

  private place(width: number, height: number): void {
    const view = this.view;
    const tab = this.tab;
    if (!view || !tab) return;
    view.setBounds(dropdownBounds(this.anchor, { width, height }, tab.view.getBounds()));
    // On top of the page and its panels (re-adding only reorders); the chrome UI's popovers come over it when they open.
    this.win.win.contentView.addChildView(view);
    view.setVisible(true);
  }

  private highlight(index: number | null): void {
    if (!this.current || this.current.highlight === index) return;
    this.current = { ...this.current, highlight: index };
    this.post();
  }

  private activate(index: number): void {
    const state = this.current;
    const entry = state ? dropdownEntries(state)[index] : undefined;
    if (!state || !entry) return;
    if (entry.type === "others") {
      this.current = { ...state, othersOpen: !state.othersOpen, highlight: index };
      this.post();
      return;
    }
    this.close();
    if (entry.type === "account") this.picks.account(state.kind, entry.account.id);
    else this.picks.manage();
  }

  /**
   * Keys reach the dropdown before the page: the arrows, Enter on a highlighted entry, Escape; Tab
   * closes it. Shortcuts (Ctrl+V, Ctrl+A, Shift+arrows that select text...) stay the field's.
   */
  private onKey(event: Electron.Event, input: Electron.Input): void {
    const state = this.current;
    if (!state || input.type !== "keyDown" || input.control || input.alt || input.meta) return;
    if (input.key === "Tab") return this.close();
    if (input.shift) return;
    const count = dropdownEntries(state).length;
    if (input.key === "ArrowDown" || input.key === "ArrowUp") {
      event.preventDefault();
      this.highlight(moveHighlight(state.highlight, input.key === "ArrowDown" ? 1 : -1, count));
    } else if (input.key === "Enter") {
      if (state.highlight === null) return this.close();
      event.preventDefault();
      this.activate(state.highlight);
    } else if (input.key === "Escape") {
      event.preventDefault();
      this.close();
    }
  }

  private attach(tab: TabRuntime, page: WebContents): void {
    this.detach?.();
    const onKey = (event: Electron.Event, input: Electron.Input): void => this.onKey(event, input);
    const onNavigate = (details: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>): void => {
      if (details.isMainFrame) this.close();
    };
    // The keyboard left the page: unless it went to the dropdown itself (a click on it), close.
    const onBlur = (): void => {
      setImmediate(() => {
        const menu = this.webContents;
        if (this.current && this.tab === tab && !page.isDestroyed() && !page.isFocused() && !menu?.isFocused()) this.close();
      });
    };
    page.on("before-input-event", onKey);
    page.on("did-start-navigation", onNavigate);
    page.on("blur", onBlur);
    const onGone = (): void => {
      if (this.tab === tab) this.close();
    };
    page.once("destroyed", onGone);
    // The window went to the background (another app took the keyboard), was minimized or hidden.
    const onAway = (): void => this.close();
    const win = this.win.win;
    win.on("blur", onAway);
    win.on("minimize", onAway);
    win.on("hide", onAway);
    this.detach = () => {
      if (!page.isDestroyed()) {
        page.off("before-input-event", onKey);
        page.off("did-start-navigation", onNavigate);
        page.off("blur", onBlur);
        page.off("destroyed", onGone);
      }
      win.off("blur", onAway);
      win.off("minimize", onAway);
      win.off("hide", onAway);
    };
  }
}
