/**
 * Voice dictation: what the person says in Corvus's own UI (the Command Bar and the Assist panel)
 * is recorded there and sent to a speech-to-text service they set up in Settings: any server with
 * the OpenAI-compatible `POST /audio/transcriptions` endpoint (OpenAI, Groq, a self-hosted Whisper
 * server). Corvus ships no speech model of its own and needs nothing else installed.
 */
import type { Settings } from "./settings";

export type DictationSettings = Settings["dictation"];

export interface DictationPreset {
  id: "openai" | "groq" | "self-hosted";
  baseUrl: string;
  model: string;
  /** The service wants an API key (a self-hosted server usually does not). */
  needsKey: boolean;
}

/** Starting points for Settings; any other OpenAI-compatible server works too. */
export const DICTATION_PRESETS: readonly DictationPreset[] = [
  { id: "openai", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini-transcribe", needsKey: true },
  { id: "groq", baseUrl: "https://api.groq.com/openai/v1", model: "whisper-large-v3-turbo", needsKey: true },
  { id: "self-hosted", baseUrl: "http://localhost:8000/v1", model: "Systran/faster-whisper-small", needsKey: false },
];

/** Longest recording sent in one go: a spoken command or a few sentences. */
export const MAX_DICTATION_SECONDS = 120;
/** Upload cap (two minutes of Opus is about 1 MB; OpenAI takes up to 25 MB). */
export const MAX_DICTATION_BYTES = 10 * 1024 * 1024;
/** How long a transcription may take before Corvus gives up on it. */
export const DICTATION_TIMEOUT_MS = 60_000;

/** The transcription endpoint for a base URL such as https://api.openai.com/v1, or null when it is not http(s). */
export function transcriptionEndpoint(baseUrl: string): string | null {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  } catch {
    return null;
  }
  return /\/audio\/transcriptions$/.test(trimmed) ? trimmed : `${trimmed}/audio/transcriptions`;
}

/** Dictation is on and has a service to send recordings to. */
export function dictationReady(d: DictationSettings): boolean {
  return d.enabled && transcriptionEndpoint(d.baseUrl) !== null && d.model.trim() !== "";
}

/** The Corvus UI pages that may record for dictation. Web pages ask through site permissions instead. */
const DICTATION_PAGES = new Set(["corvus://chrome", "corvus://assist"]);

/**
 * Whether the default session (Corvus's own UI) may open the microphone: audio only, only for the
 * Command Bar and Assist pages, and only while dictation is set up. Everything else stays denied.
 */
export function internalMicrophoneAllowed(permission: string, mediaTypes: readonly string[] | undefined, requestingUrl: string, ready: boolean): boolean {
  if (!ready || permission !== "media") return false;
  if (!mediaTypes || mediaTypes.length === 0 || mediaTypes.some((type) => type !== "audio")) return false;
  try {
    const url = new URL(requestingUrl);
    // Custom schemes have an opaque origin in WHATWG URL, so compare scheme and host.
    return DICTATION_PAGES.has(`${url.protocol}//${url.host}`);
  } catch {
    return false;
  }
}

/** File name the service sees for a recording, from its MIME type (some servers go by the extension). */
export function recordingFileName(mimeType: string): string {
  const type = mimeType.split(";")[0]!.trim().toLowerCase();
  if (type === "audio/ogg") return "dictation.ogg";
  if (type === "audio/mp4" || type === "audio/m4a") return "dictation.m4a";
  if (type === "audio/wav" || type === "audio/x-wav") return "dictation.wav";
  if (type === "audio/mpeg") return "dictation.mp3";
  return "dictation.webm";
}

/** The text of a transcription answer (`{"text": "..."}`), on one line. */
export function transcriptText(body: unknown): string {
  const text = typeof body === "object" && body !== null && typeof (body as { text?: unknown }).text === "string" ? (body as { text: string }).text : "";
  return text.replace(/\s+/g, " ").trim();
}

/** The message in a service's error answer (OpenAI's `{"error": {"message"}}` and the usual variants), on one line. */
export function errorDetail(body: string): string {
  let detail = "";
  try {
    const parsed = JSON.parse(body) as { error?: { message?: unknown } | string; detail?: unknown; message?: unknown };
    const error = parsed.error;
    const raw = typeof error === "object" && error !== null ? error.message : (error ?? parsed.detail ?? parsed.message);
    detail = typeof raw === "string" ? raw : "";
  } catch {
    detail = body;
  }
  return detail.replace(/\s+/g, " ").trim().slice(0, 200);
}

/** Puts dictated text into what is already typed: after it, with one space between. */
export function insertDictation(current: string, dictated: string): string {
  const text = dictated.trim();
  if (!text) return current;
  if (!current.trim()) return text;
  return /\s$/.test(current) ? `${current}${text}` : `${current} ${text}`;
}
