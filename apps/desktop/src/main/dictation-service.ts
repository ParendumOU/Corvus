import {
  DICTATION_TIMEOUT_MS,
  MAX_DICTATION_BYTES,
  dictationReady,
  errorDetail,
  recordingFileName,
  transcriptText,
  transcriptionEndpoint,
} from "../shared/dictation";
import { tr } from "./menu-i18n";
import type { SettingsStore } from "./settings-store";

export type DictationFetch = (url: string, init: RequestInit) => Promise<Response>;

/** A recording handed over IPC: bytes, within the upload cap. */
export function recordingBytes(value: unknown): Uint8Array {
  if (!(value instanceof Uint8Array)) throw new Error("Invalid recording");
  if (value.byteLength > MAX_DICTATION_BYTES) throw new Error(tr("The recording is too long to transcribe."));
  return value;
}

/**
 * Sends a recording made in Corvus's UI to the speech-to-text service set up in Settings and
 * returns the text. The recording is only held in memory for the request.
 */
export class DictationService {
  constructor(
    private readonly settings: SettingsStore,
    private readonly fetcher: DictationFetch = (url, init) => fetch(url, init),
  ) {}

  ready(): boolean {
    return dictationReady(this.settings.get().dictation);
  }

  async transcribe(audio: Uint8Array, mimeType: string): Promise<string> {
    const d = this.settings.get().dictation;
    const endpoint = transcriptionEndpoint(d.baseUrl);
    if (!endpoint || !dictationReady(d)) throw new Error(tr("Dictation is not set up. Choose a transcription service in Settings."));
    if (audio.byteLength === 0) return "";
    if (audio.byteLength > MAX_DICTATION_BYTES) throw new Error(tr("The recording is too long to transcribe."));

    const form = new FormData();
    form.append("file", new Blob([audio], { type: mimeType || "audio/webm" }), recordingFileName(mimeType));
    form.append("model", d.model.trim());
    form.append("response_format", "json");
    if (d.language) form.append("language", d.language);
    const key = this.settings.getSecret("transcriptionApiKey");

    let res: Response;
    try {
      res = await this.fetcher(endpoint, {
        method: "POST",
        body: form,
        headers: key ? { Authorization: `Bearer ${key}` } : {},
        signal: AbortSignal.timeout(DICTATION_TIMEOUT_MS),
      });
    } catch (err) {
      const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
      throw new Error(timedOut ? tr("The transcription service did not answer in time.") : tr("The transcription service could not be reached."));
    }
    const body = await res.text();
    if (!res.ok) throw new Error(transcriptionError(res.status, body));
    try {
      return transcriptText(JSON.parse(body));
    } catch {
      // A server that ignores response_format and answers in plain text.
      return transcriptText({ text: body });
    }
  }
}

/** What to tell the person when the service answers with an error, in Corvus's language. */
export function transcriptionError(status: number, body: string): string {
  if (status === 401 || status === 403) return tr("The transcription service refused the API key.");
  if (status === 404) return tr("The transcription service has no /audio/transcriptions endpoint at this address.");
  if (status === 429) return tr("The transcription service is busy (too many requests). Try again in a moment.");
  const detail = errorDetail(body);
  return detail ? tr("The transcription service failed (HTTP {status}): {detail}", { status, detail }) : tr("The transcription service failed (HTTP {status}).", { status });
}
