import type { WebContents } from "electron";
import { chunkTranscript, parseJson3, parseTimestamp, type TranscriptChunk, type TranscriptSegment } from "../shared/youtube";

/** Isolated world for reading YouTube's transcript panel. */
const TRANSCRIPT_WORLD_ID = 2001;
const TIMEOUT_MS = 12_000;

/**
 * Runs in the page's own world (the player object lives there): the caption track of the video
 * on screen, preferring `lang` and human captions over automatic ones, fetched as json3.
 */
function captionsScript(lang: string): string {
  return `(async () => {
  const player = document.getElementById("movie_player");
  const response = (player && typeof player.getPlayerResponse === "function" && player.getPlayerResponse()) || window.ytInitialPlayerResponse;
  const id = new URL(location.href).searchParams.get("v") || location.pathname.split("/")[2] || "";
  if (!response || (response.videoDetails && id && response.videoDetails.videoId !== id)) return null;
  const title = (response.videoDetails && response.videoDetails.title) || document.title;
  const tracks = (response.captions && response.captions.playerCaptionsTracklistRenderer && response.captions.playerCaptionsTracklistRenderer.captionTracks) || [];
  if (!tracks.length) return { title, json: "" };
  const want = ${JSON.stringify(lang)};
  const pick = tracks.find((t) => t.languageCode === want && t.kind !== "asr") || tracks.find((t) => t.languageCode === want) || tracks.find((t) => t.kind !== "asr") || tracks[0];
  try {
    const res = await fetch(pick.baseUrl + "&fmt=json3", { credentials: "include" });
    return { title, json: res.ok ? (await res.text()).slice(0, 3000000) : "" };
  } catch (e) {
    return { title, json: "" };
  }
})()`;
}

/** YouTube's own "Show transcript" panel, opened when needed and read row by row. */
const TRANSCRIPT_PANEL_SCRIPT = `(async () => {
  const read = () => [...document.querySelectorAll("ytd-transcript-segment-renderer")].map((row) => ({
    t: (row.querySelector(".segment-timestamp") || {}).textContent || "",
    text: (row.querySelector(".segment-text") || {}).textContent || "",
  }));
  let rows = read();
  if (rows.length === 0) {
    const open = document.querySelector("ytd-video-description-transcript-section-renderer button, button[aria-label*='transcript' i], button[aria-label*='transcripci' i]");
    if (!open) return [];
    open.click();
    for (let i = 0; i < 40 && rows.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 150));
      rows = read();
    }
  }
  return rows.slice(0, 6000);
})()`;

function withTimeout<T>(p: Promise<T>, fallback: T): Promise<T> {
  return Promise.race([p.catch(() => fallback), new Promise<T>((resolve) => setTimeout(() => resolve(fallback), TIMEOUT_MS))]);
}

export interface VideoTranscript {
  title: string;
  chunks: TranscriptChunk[];
}

/** The video's transcript in timestamped stretches, or null when it has none Corvus can read. */
export async function readVideoTranscript(wc: WebContents, lang: string): Promise<VideoTranscript | null> {
  const captions = (await withTimeout(wc.executeJavaScript(captionsScript(lang), true) as Promise<unknown>, null)) as { title?: unknown; json?: unknown } | null;
  const title = typeof captions?.title === "string" ? captions.title : wc.getTitle();
  let segments: TranscriptSegment[] = typeof captions?.json === "string" ? parseJson3(captions.json) : [];
  if (segments.length === 0) {
    const rows = (await withTimeout(wc.executeJavaScriptInIsolatedWorld(TRANSCRIPT_WORLD_ID, [{ code: TRANSCRIPT_PANEL_SCRIPT }], true) as Promise<unknown>, [])) as unknown;
    segments = (Array.isArray(rows) ? rows : [])
      .map((r) => r as { t?: unknown; text?: unknown })
      .map((r) => ({ start: parseTimestamp(String(r.t ?? "")), text: String(r.text ?? "").replace(/\s+/g, " ").trim() }))
      .filter((r): r is TranscriptSegment => r.start !== null && r.text !== "");
  }
  return segments.length > 0 ? { title, chunks: chunkTranscript(segments) } : null;
}

/** Jumps the video on screen to `seconds` and plays it. */
export async function seekVideo(wc: WebContents, seconds: number): Promise<boolean> {
  const t = Math.max(0, Math.floor(seconds));
  const code = `(() => {
  const player = document.getElementById("movie_player");
  if (player && typeof player.seekTo === "function") { player.seekTo(${t}, true); if (typeof player.playVideo === "function") player.playVideo(); return true; }
  const video = document.querySelector("video");
  if (!video) return false;
  video.currentTime = ${t};
  video.play && video.play().catch(() => {});
  return true;
})()`;
  return (await withTimeout(wc.executeJavaScript(code, true) as Promise<unknown>, false)) === true;
}
