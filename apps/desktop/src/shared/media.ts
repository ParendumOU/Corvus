/**
 * Automatic picture-in-picture: when you switch away from a tab playing a video with sound, the
 * video keeps playing in a small floating window; when you come back, it returns to the page.
 * The scripts run in an isolated world of the page, with the user gesture of the tab switch.
 */

/** Isolated world the picture-in-picture scripts run in (the element picker uses 1998). */
export const PIP_WORLD_ID = 1997;

export type PipEnterResult = "entered" | "already" | "none" | "unsupported" | "failed";

/** Whether leaving a tab should float its video: the setting is on and the tab is playing sound. */
export function shouldAutoPip(t: { audible: boolean; url: string; enabled: boolean }): boolean {
  return t.enabled && t.audible && /^https?:/i.test(t.url);
}

/**
 * Floats the largest video that is playing with sound (not muted, has frames, allows
 * picture-in-picture). Resolves to what happened.
 */
export const PIP_ENTER_SCRIPT = `(async () => {
  if (document.pictureInPictureElement) return "already";
  if (!document.pictureInPictureEnabled) return "unsupported";
  const playing = Array.from(document.querySelectorAll("video")).filter(
    (v) => !v.paused && !v.ended && !v.muted && v.volume > 0 && v.readyState >= 2 && v.videoWidth > 0 && !v.disablePictureInPicture,
  );
  if (playing.length === 0) return "none";
  const area = (v) => { const r = v.getBoundingClientRect(); return r.width * r.height; };
  const video = playing.sort((a, b) => area(b) - area(a))[0];
  try {
    await video.requestPictureInPicture();
    return "entered";
  } catch (e) {
    return "failed";
  }
})()`;

/** Brings a floating video back into its page. */
export const PIP_EXIT_SCRIPT = `(async () => {
  if (!document.pictureInPictureElement) return "none";
  try {
    await document.exitPictureInPicture();
    return "exited";
  } catch (e) {
    return "failed";
  }
})()`;
