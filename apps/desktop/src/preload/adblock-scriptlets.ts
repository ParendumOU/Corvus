// Preload for every web frame of a profile session: runs the ad blocker's scriptlets in the page's
// own world before any of the page's scripts. Sites like YouTube put their ads in data their first
// inline script reads; a scriptlet that arrives after an async round trip is too late to remove them.
// On YouTube it also watches the player for the loop YouTube puts it in when it insists on its ads,
// and then asks Corvus to skip the ads instead of removing them. Exposes nothing to the page.
import { ipcRenderer, webFrame } from "electron";
import { ADBLOCK_SCRIPTLETS_CHANNEL, ADBLOCK_YOUTUBE_LOOP_CHANNEL, PlaybackLoopDetector, type ScriptletsAnswer } from "../shared/adblock";

// Type-checked with the Node project (no DOM lib); declare the globals it reads.
declare const location: { href: string; protocol: string; pathname: string; search: string; reload(): void };
declare const document: { querySelector(selector: string): { src: string; currentTime: number } | null; visibilityState: string };

function watchYouTubePlayer(): void {
  const detector = new PlaybackLoopDetector();
  const timer = setInterval(() => {
    if (document.visibilityState !== "visible") return;
    // Only the watch page's own player: previews on other pages can borrow #movie_player.
    const videoId = location.pathname === "/watch" ? (new URLSearchParams(location.search).get("v") ?? "") : "";
    const video = videoId ? document.querySelector("ytd-watch-flexy #movie_player video.html5-main-video") : null;
    if (!detector.sample(video ? videoId : "", video?.src ?? "", video?.currentTime ?? 0, Date.now())) return;
    clearInterval(timer);
    void ipcRenderer.invoke(ADBLOCK_YOUTUBE_LOOP_CHANNEL).then(
      (switched: unknown) => switched === true && location.reload(),
      () => undefined,
    );
  }, 1000);
}

if (location.protocol === "http:" || location.protocol === "https:") {
  let answer: Partial<ScriptletsAnswer> | null = null;
  try {
    answer = ipcRenderer.sendSync(ADBLOCK_SCRIPTLETS_CHANNEL, location.href) as Partial<ScriptletsAnswer> | null;
  } catch {
    // No blocker answer: the page loads unfiltered rather than not at all.
  }
  for (const script of Array.isArray(answer?.scripts) ? answer.scripts : []) {
    if (typeof script === "string") void webFrame.executeJavaScript(script).catch(() => undefined);
  }
  if (answer?.watchYouTube === true) watchYouTubePlayer();
}
