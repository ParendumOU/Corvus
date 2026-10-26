import { useCallback, useEffect, useRef, useState } from "react";
import { MAX_DICTATION_SECONDS } from "../../shared/dictation";
import { errorMessage } from "./api";
import { t } from "./i18n";

export type DictationPhase = "idle" | "listening" | "transcribing";

export interface Dictation {
  phase: DictationPhase;
  error: string | null;
  /** Start listening; `tag` comes back with the text (who asked: a button, a shortcut). */
  start(tag?: string): void;
  /** Stop listening and transcribe what was said. */
  stop(): void;
  /** Stop listening and drop the recording. */
  cancel(): void;
  clearError(): void;
}

const PREFERRED_TYPE = "audio/webm;codecs=opus";

/**
 * Dictation in Corvus's own UI: records from the microphone while listening, then hands the
 * recording to `transcribe` (the main process sends it to the speech-to-text service set up in
 * Settings) and the text to `onText`. Stops by itself after MAX_DICTATION_SECONDS.
 */
export function useDictation(
  transcribe: (audio: Uint8Array, mimeType: string) => Promise<string>,
  onText: (text: string, tag: string) => void,
): Dictation {
  const [phase, setPhase] = useState<DictationPhase>("idle");
  const [error, setError] = useState<string | null>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  /** Listening was asked for and not yet stopped (also while the microphone is opening). */
  const wanted = useRef(false);
  const dropped = useRef(false);
  const latest = useRef({ transcribe, onText });
  latest.current = { transcribe, onText };

  const stop = useCallback(() => {
    wanted.current = false;
    if (recorder.current?.state === "recording") recorder.current.stop();
  }, []);

  const cancel = useCallback(() => {
    dropped.current = true;
    stop();
  }, [stop]);

  const start = useCallback((tag = "") => {
    if (wanted.current || recorder.current) return;
    wanted.current = true;
    dropped.current = false;
    setError(null);
    setPhase("listening");
    void (async () => {
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch {
        wanted.current = false;
        setPhase("idle");
        setError(t("Corvus could not use the microphone."));
        return;
      }
      if (!wanted.current) {
        // Stopped while the microphone was opening: nothing was said.
        for (const track of stream.getTracks()) track.stop();
        setPhase("idle");
        return;
      }
      const rec = new MediaRecorder(stream, MediaRecorder.isTypeSupported(PREFERRED_TYPE) ? { mimeType: PREFERRED_TYPE } : undefined);
      const chunks: Blob[] = [];
      rec.ondataavailable = (e) => {
        if (e.data.size > 0) chunks.push(e.data);
      };
      const limit = setTimeout(stop, MAX_DICTATION_SECONDS * 1000);
      rec.onstop = () => {
        clearTimeout(limit);
        for (const track of stream.getTracks()) track.stop();
        recorder.current = null;
        if (dropped.current || chunks.length === 0) {
          setPhase("idle");
          return;
        }
        setPhase("transcribing");
        const blob = new Blob(chunks, { type: rec.mimeType || "audio/webm" });
        void blob
          .arrayBuffer()
          .then((buffer) => latest.current.transcribe(new Uint8Array(buffer), blob.type))
          .then((text) => {
            if (text.trim()) latest.current.onText(text.trim(), tag);
            else setError(t("Nothing was heard. Try again a little closer to the microphone."));
          })
          .catch((err: unknown) => setError(errorMessage(err)))
          .finally(() => setPhase("idle"));
      };
      recorder.current = rec;
      rec.start();
    })();
  }, [stop]);

  // Closing the Command Bar or the panel drops a recording under way.
  useEffect(() => cancel, [cancel]);

  return { phase, error, start, stop, cancel, clearError: useCallback(() => setError(null), []) };
}
