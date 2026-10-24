import type http from "node:http";
import type { WebContents } from "electron";
import type { AppContext } from "./context";
import type { BrowserWindowCtl } from "./window";

interface MediaSmokeHelpers {
  url: string;
  win: BrowserWindowCtl;
  check: (name: string, ok: boolean, detail?: unknown) => void;
  capture: (name: string, wc: WebContents) => Promise<void>;
}

/** A video playing with sound: frames from a canvas, sound from an oscillator, no media files. */
const VIDEO_PAGE = `<!doctype html><html><head><title>Video</title></head><body>
<video id="v" width="320" height="180" playsinline></video>
<script>
  const canvas = document.createElement("canvas");
  canvas.width = 320; canvas.height = 180;
  const g = canvas.getContext("2d");
  let hue = 0;
  setInterval(() => { g.fillStyle = "hsl(" + (hue++ % 360) + " 80% 50%)"; g.fillRect(0, 0, 320, 180); }, 50);
  const stream = canvas.captureStream(20);
  const audio = new AudioContext();
  const tone = audio.createOscillator();
  const out = audio.createMediaStreamDestination();
  tone.connect(out);
  tone.start();
  stream.addTrack(out.stream.getAudioTracks()[0]);
  const video = document.getElementById("v");
  video.srcObject = stream;
  video.play();
</script></body></html>`;

export function serveMediaSmokeRoute(req: http.IncomingMessage, res: http.ServerResponse): boolean {
  if ((req.url ?? "/").split("?")[0] !== "/media-video") return false;
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(VIDEO_PAGE);
  return true;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function loaded(wc: WebContents): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, 10_000);
    wc.once("did-stop-loading", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function until(fn: () => Promise<boolean>, tries = 40): Promise<boolean> {
  for (let i = 0; i < tries; i += 1) {
    if (await fn()) return true;
    await sleep(150);
  }
  return false;
}

/**
 * Automatic picture-in-picture: leaving a tab whose video plays with sound floats the video,
 * coming back returns it to the page, and nothing floats with the setting off.
 */
export async function runMediaSmoke(ctx: AppContext, h: MediaSmokeHelpers): Promise<void> {
  const { win, check } = h;
  const before = ctx.settings.get().media;
  const video = win.createTab(`${h.url}media-video`, { activate: true });
  const vwc = video.view.webContents;
  const other = win.createTab(`${h.url}ux-plain`, { activate: false });
  try {
    await loaded(vwc);
    const playing = await until(async () => (await vwc.executeJavaScript("(() => { const v = document.getElementById('v'); return !v.paused && v.readyState >= 2 && v.videoWidth > 0; })()")) === true);
    // Chromium reports the tab as playing sound when it hears it; a machine without audio output
    // may never do so, and then the tab's flag stands in for it.
    const heard = await until(async () => video.audible, 30);
    if (!heard) video.audible = true;
    const floating = (): Promise<string | null> => vwc.executeJavaScript("document.pictureInPictureElement ? document.pictureInPictureElement.id : null") as Promise<string | null>;

    win.activate(other.id);
    const floated = await until(async () => (await floating()) === "v");
    check("auto picture-in-picture floats the video of a tab left playing", playing && floated && video.autoPip === true, {
      playing,
      audible: heard ? "reported by Chromium" : "set by the smoke test",
      floating: await floating(),
    });

    win.activate(video.id);
    const returned = await until(async () => (await floating()) === null);
    check("auto picture-in-picture: coming back returns the video to its page", returned && video.autoPip !== true, { floating: await floating() });

    ctx.settings.update({ media: { autoPictureInPicture: false } });
    win.activate(other.id);
    await sleep(1200);
    const off = await floating();
    check("auto picture-in-picture stays off when the setting is off", off === null, { floating: off });
  } finally {
    ctx.settings.update({ media: before });
    win.closeTabs([video.id, other.id]);
  }
}
