import { app, shell, type WebContents } from "electron";
import { canRememberApp, escapeForHandler, externalScheme, isActivationInput, mayLaunch, openedByGesture, type LaunchGate } from "../shared/external-apps";
import { originOf } from "../shared/permissions";
import type { AppContext } from "./context";
import { tr } from "./menu-i18n";
import { pageOf } from "./tab-page";
import type { BrowserWindowCtl, TabRuntime } from "./window";

/** The app that opens a kind of link on this computer: its name ("" when unknown) and icon (a data: URL). */
export interface ExternalApp {
  name: string;
  icon?: string;
}

/** What Corvus asks of the system; the smoke test puts a stand-in in its place. */
export interface ExternalAppSystem {
  appFor(url: string): Promise<ExternalApp>;
  open(url: string): Promise<void>;
}

/** The system's own answers: the registered handler's display name and icon, and opening the link with it. */
export const systemApps: ExternalAppSystem = {
  async appFor(url) {
    if (process.platform === "win32" || process.platform === "darwin") {
      try {
        const info = await app.getApplicationInfoForProtocol(url);
        if (info.name) return { name: info.name, ...(info.icon.isEmpty() ? {} : { icon: info.icon.resize({ width: 64, height: 64 }).toDataURL() }) };
      } catch {
        // No app registered for it, or the system could not say which.
      }
    }
    // Linux: the display name of the default handler GIO finds (older Electrons gave its .desktop file).
    return { name: app.getApplicationNameForProtocol(url).replace(/\.(exe|desktop)$/i, "") };
  },
  open: (url) => shell.openExternal(url),
};

interface TabGate extends LaunchGate {
  createdAt: number;
  inputAt: number;
}

/** The site a request comes from: the requesting page's origin, else the tab's (a frame without one). */
function webOrigin(...urls: string[]): string {
  for (const url of urls) {
    const origin = /^https?:/i.test(url) ? originOf(url) : "";
    if (origin) return origin;
  }
  return "";
}

/**
 * Links that open another app on this computer (afirma: for Autofirma, zoommtg:, msteams:, mailto:...):
 * Chromium hands them to Electron's "openExternal" permission, and window.open to the tab's open
 * handler; Corvus asks "Open <app>?" as Chrome does, with "Always allow <site>..." remembered per site
 * and scheme in the profile's site settings (Settings > Site permissions lists them). A page may ask
 * once per thing the person does in it (Chrome's flood rule, per tab); more is blocked with a quiet
 * bar that can still open the app. Never without asking in a private window or a tab an AI agent
 * drives, and never for schemes the browser loads itself or that ran code from a link.
 */
export class ExternalAppService {
  system: ExternalAppSystem = systemApps;
  private readonly gates = new WeakMap<WebContents, TabGate>();
  private counter = 0;
  /** Tabs with an open "Open <app>?" question: the app it is about. */
  private readonly asking = new WeakMap<WebContents, string>();
  /** Tabs showing the "blocked" bar. */
  private readonly blocked = new WeakSet<WebContents>();

  constructor(private readonly ctx: AppContext) {}

  install(): void {
    app.on("web-contents-created", (_e, wc) => this.watch(wc));
  }

  private watch(wc: WebContents): void {
    const gate: TabGate = { createdAt: Date.now(), inputAt: 0, input: 0, launch: 0 };
    this.gates.set(wc, gate);
    wc.on("input-event", (_e, input) => {
      if (!isActivationInput(input.type)) return;
      gate.input = ++this.counter;
      gate.inputAt = Date.now();
    });
    // A page the person opened from Corvus (address bar, bookmark, back, a link from another app)
    // counts as something they did in the tab: it may open an app once, as in Chrome.
    wc.on("did-start-navigation", (details) => {
      if (details.isMainFrame && !details.isSameDocument && !details.initiator) gate.input = ++this.counter;
    });
  }

  /** Whether a tab was opened by a click (or key) in another tab just before. */
  private openedByGesture(win: BrowserWindowCtl, tab: TabRuntime | undefined, gate: TabGate): boolean {
    const openerId = tab ? win.openerOf(tab.id) : undefined;
    const opener = openerId ? this.ctx.windows.findTab(openerId) : undefined;
    const openerWc = opener ? pageOf(opener.tab.view) : null;
    return openerWc ? openedByGesture(this.gates.get(openerWc)?.inputAt ?? 0, gate.createdAt) : false;
  }

  /**
   * For agents: the "Open <app>?" question open over this tab, which only the person answers, as the
   * message an agent's call gets (null when there is none).
   */
  personStep(wc: WebContents): string | null {
    const app = this.asking.get(wc);
    if (!app || this.ctx.windows.byTabWebContents(wc)?.tab.agentControlled !== true) return null;
    return `The page asks to open ${app}, an app on this computer. Agents cannot open apps: Corvus asked the person in a dialog. Hand this step to the person, then continue.`;
  }

  /**
   * A page asks to open `url` in another app (a link, a navigation, a frame or window.open), from the
   * page at `requestingUrl`. Opens it, asks first, or blocks it, as the class comment says.
   */
  async request(wc: WebContents, url: string, requestingUrl: string): Promise<void> {
    const scheme = externalScheme(url);
    const gate = this.gates.get(wc);
    if (!scheme || !gate || wc.isDestroyed()) return;
    const found = this.ctx.windows.byTabWebContents(wc);
    const win = found?.window ?? this.ctx.windows.focused();
    if (!win || win.win.isDestroyed()) return;
    const allowed = mayLaunch(gate, this.openedByGesture(win, found?.tab, gate));
    gate.launch = ++this.counter;
    if (this.asking.has(wc)) return;
    this.asking.set(wc, `a ${scheme}: link`);
    try {
      await this.decide(win, found?.tab, wc, url, requestingUrl, scheme, allowed);
    } finally {
      this.asking.delete(wc);
    }
  }

  private async decide(win: BrowserWindowCtl, tab: TabRuntime | undefined, wc: WebContents, url: string, requestingUrl: string, scheme: string, allowed: boolean): Promise<void> {
    const origin = webOrigin(requestingUrl, wc.getURL());
    const agent = tab?.agentControlled === true;
    const remember = Boolean(origin) && canRememberApp(origin, { privateWindow: win.isPrivate, agent });
    const target = await this.system.appFor(url).catch((): ExternalApp => ({ name: "" }));
    if (wc.isDestroyed()) return;
    if (!allowed) return this.showBlocked(win, tab, wc, url, requestingUrl, origin, target);
    if (remember && win.profile.siteSettings.externalAppAllowed(origin, scheme)) return this.open(url);

    const site = origin || tr("This page");
    const name = target.name;
    if (name) this.asking.set(wc, name);
    // The tab closed or left for another page while the question was open: nothing to open.
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    wc.once("destroyed", abort);
    wc.once("did-navigate", abort);
    const spec = {
      tone: "question" as const,
      title: name ? tr("Open {app}?", { app: name }) : tr("Open this {scheme}: link?", { scheme }),
      message: tr("{site} wants to open this application.", { site }),
      ...(agent ? { detail: tr("An AI agent is driving this tab. Corvus opens apps only when you say so.") } : {}),
      ...(remember ? { checkbox: { label: tr("Always allow {site} to open links of this type in the associated app", { site }), checked: false } } : {}),
      ...(target.icon ? { icon: target.icon } : {}),
      buttons: [tr("Cancel"), name ? tr("Open {app}", { app: name }) : tr("Open link")],
      defaultId: 1,
      cancelId: 0,
    };
    let answer;
    try {
      answer = tab
        ? await this.ctx.dialogs.askAboutTab(win, tab.id, { message: spec.message, action: spec.buttons[1]! }, spec, controller.signal)
        : await this.ctx.dialogs.ask(spec, win, controller.signal);
    } finally {
      wc.removeListener("destroyed", abort);
      wc.removeListener("did-navigate", abort);
    }
    if (controller.signal.aborted || answer.button !== 1) return;
    if (remember && answer.checked) win.profile.siteSettings.setExternalAppAllowed(origin, scheme, true);
    await this.open(url);
  }

  /**
   * A page asked to open an app again without the person doing anything in it: a quiet bar says so
   * (one at a time per tab), and its button opens the app after all, as the person's own action.
   */
  private showBlocked(win: BrowserWindowCtl, tab: TabRuntime | undefined, wc: WebContents, url: string, requestingUrl: string, origin: string, target: ExternalApp): void {
    if (this.blocked.has(wc)) return;
    this.blocked.add(wc);
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    wc.once("destroyed", abort);
    wc.once("did-navigate", abort);
    void this.ctx.dialogs
      .ask(
        {
          tone: "info",
          title: tr("App blocked"),
          message: tr("Corvus stopped {site} from opening an app by itself", { site: origin || tr("this page") }),
          detail: tr("Pages can open an app only right after you click or type in them. Open it now if you expected it."),
          buttons: [tr("Dismiss"), target.name ? tr("Open {app}", { app: target.name }) : tr("Open link")],
          defaultId: 1,
          cancelId: 0,
          bar: true,
          ...(tab ? { tabId: tab.id } : {}),
        },
        win,
        controller.signal,
      )
      .then((answer) => {
        wc.removeListener("destroyed", abort);
        wc.removeListener("did-navigate", abort);
        this.blocked.delete(wc);
        const gate = this.gates.get(wc);
        if (controller.signal.aborted || answer.button !== 1 || !gate) return;
        gate.input = ++this.counter;
        return this.request(wc, url, requestingUrl);
      });
  }

  private async open(url: string): Promise<void> {
    await this.system.open(escapeForHandler(url)).catch(() => undefined);
  }
}
