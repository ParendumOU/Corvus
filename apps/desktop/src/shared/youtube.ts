/**
 * Videos for Corvus Assist: on a YouTube watch page, Summarize and Ask read the video's captions
 * instead of the page around it, as stretches of speech headed by their timestamp; a cited stretch
 * jumps the video to that moment. Pure rules here; the page work is in main/youtube-transcript.ts.
 */

export interface TranscriptSegment {
  /** Seconds from the start of the video. */
  start: number;
  text: string;
}

export interface TranscriptChunk {
  start: number;
  heading: string;
  text: string;
}

/** The video id of a YouTube watch address (www, m, music; /watch?v=, /shorts/, /live/), or null. */
export function youTubeVideoId(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (!/^(www\.|m\.|music\.)?youtube\.com$/i.test(u.hostname)) return null;
  const id = u.pathname === "/watch" ? u.searchParams.get("v") : /^\/(?:shorts|live)\/([^/?#]+)/.exec(u.pathname)?.[1];
  return id && /^[\w-]{6,20}$/.test(id) ? id : null;
}

/** "75" → "1:15", "3725" → "1:02:05". */
export function formatTimestamp(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

/** "1:02:05" or "12:30" (a transcript panel's timestamp) → seconds, or null. */
export function parseTimestamp(text: string): number | null {
  const parts = text.trim().split(":");
  if (parts.length < 2 || parts.length > 3 || !parts.every((p) => /^\d{1,2}$/.test(p))) return null;
  return parts.reduce((total, p) => total * 60 + Number(p), 0);
}

/** Segments of YouTube's json3 caption format (events with tStartMs and text segs). */
export function parseJson3(raw: string): TranscriptSegment[] {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return [];
  }
  const events = (data as { events?: unknown }).events;
  if (!Array.isArray(events)) return [];
  const out: TranscriptSegment[] = [];
  for (const e of events as Array<{ tStartMs?: unknown; segs?: Array<{ utf8?: unknown }> }>) {
    if (typeof e?.tStartMs !== "number" || !Array.isArray(e.segs)) continue;
    const text = e.segs
      .map((s) => (typeof s?.utf8 === "string" ? s.utf8 : ""))
      .join("")
      .replace(/\s+/g, " ")
      .trim();
    if (text) out.push({ start: e.tStartMs / 1000, text });
  }
  return out;
}

/**
 * The transcript in stretches of at least `minSeconds`, at most `maxChunks` of them (longer
 * videos get longer stretches), each headed by the timestamp it starts at.
 */
export function chunkTranscript(segments: readonly TranscriptSegment[], maxChunks = 60, minSeconds = 60): TranscriptChunk[] {
  if (segments.length === 0) return [];
  const end = segments[segments.length - 1]!.start;
  const span = Math.max(minSeconds, Math.ceil(end / maxChunks));
  const chunks: TranscriptChunk[] = [];
  for (const seg of segments) {
    const last = chunks[chunks.length - 1];
    if (last && seg.start < last.start + span) last.text += ` ${seg.text}`;
    else chunks.push({ start: seg.start, heading: formatTimestamp(seg.start), text: seg.text });
  }
  return chunks;
}
