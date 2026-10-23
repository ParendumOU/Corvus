import type { WebContents } from "electron";

/** The two user agents a profile shows sites (see ProfileRuntime). */
export interface UserAgents {
  /** A regular Chrome UA, for every site but the sign-in hosts. */
  chrome: string;
  /** Electron's own UA without the app name, for the sign-in hosts. */
  electron: string;
}

/** Strip the Electron and app tokens so sites (and the Chrome Web Store) see a regular Chrome UA. */
export function chromeUserAgent(ua: string): string {
  return ua.replace(/\s(?:Electron|Corvus|corvus|@corvus\/desktop)\/\S+/g, "");
}

/** Electron's default UA minus the app token, which would identify Corvus and its version. */
export function electronUserAgent(ua: string): string {
  return ua.replace(/\s(?:Corvus|corvus|@corvus\/desktop)\/\S+/g, "");
}

/**
 * Hosts that get Electron's own UA. Google's sign-in runs its full desktop Chrome checks on a
 * browser that says it is Chrome, which an Electron browser fails ("This browser or app may not be
 * secure"); told the truth, it serves its sign-in flow for embedded browsers, which works.
 */
export const SIGN_IN_HOSTS = new Set(["accounts.google.com"]);

export function userAgentFor(url: string, agents: UserAgents): string {
  try {
    return SIGN_IN_HOSTS.has(new URL(url).hostname) ? agents.electron : agents.chrome;
  } catch {
    return agents.chrome;
  }
}

/** The UA a page gets now: its own override, or the profile's Chrome UA (the session default). */
export function currentUserAgent(wc: WebContents, agents: UserAgents): string {
  return wc.getUserAgent() || agents.chrome;
}

/**
 * Keeps a page's UA in step with where its main frame goes. A UA set once a navigation has started
 * only reaches the requests after it, so a navigation that needs another UA starts again with it:
 * when it enters a sign-in host, after a redirect, and when Corvus started it (typed URL, bookmark).
 * A page leaving a sign-in host by itself is not restarted, since that can be a form POST (OAuth
 * form_post back to the site) that a restart would turn into a GET; it switches for what follows.
 */
export function followSignInUserAgent(wc: WebContents, agents: UserAgents): void {
  let scheduled: string | null = null;
  // True while Corvus itself restarts a navigation: the navigations that starts are not the page's.
  let switching = false;
  const restart = (url: string, ua: string): void => {
    if (scheduled === url) return;
    scheduled = url;
    setImmediate(() => {
      scheduled = null;
      if (wc.isDestroyed()) return;
      switching = true;
      try {
        // Stop first: changing the UA while a page still loads makes Chromium reload that page.
        wc.stop();
        wc.loadURL(url, { userAgent: ua }).catch(() => undefined);
      } finally {
        switching = false;
      }
    });
  };
  wc.on("did-start-navigation", (details) => {
    if (switching || !details.isMainFrame || details.isSameDocument) return;
    const ua = userAgentFor(details.url, agents);
    if (currentUserAgent(wc, agents) === ua) return;
    if (ua === agents.electron || !details.initiator) restart(details.url, ua);
    else wc.setUserAgent(ua);
  });
  wc.on("did-redirect-navigation", (details) => {
    if (switching || !details.isMainFrame) return;
    const ua = userAgentFor(details.url, agents);
    if (currentUserAgent(wc, agents) !== ua) restart(details.url, ua);
  });
}
