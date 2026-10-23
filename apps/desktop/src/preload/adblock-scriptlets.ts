// Preload for every web frame of a profile session: runs the ad blocker's scriptlets in the page's
// own world before any of the page's scripts. Sites like YouTube put their ads in data their first
// inline script reads; a scriptlet that arrives after an async round trip is too late to remove them.
// Exposes nothing to the page.
import { ipcRenderer, webFrame } from "electron";
import { ADBLOCK_SCRIPTLETS_CHANNEL } from "../shared/adblock";

// Type-checked with the Node project (no DOM lib); declare the one global it reads.
declare const location: { href: string; protocol: string };

if (location.protocol === "http:" || location.protocol === "https:") {
  let scripts: unknown = [];
  try {
    scripts = ipcRenderer.sendSync(ADBLOCK_SCRIPTLETS_CHANNEL, location.href);
  } catch {
    // No blocker answer: the page loads unfiltered rather than not at all.
  }
  if (Array.isArray(scripts)) {
    for (const script of scripts) {
      if (typeof script === "string") void webFrame.executeJavaScript(script).catch(() => undefined);
    }
  }
}
