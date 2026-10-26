import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DICTATION_PRESETS,
  MAX_DICTATION_BYTES,
  dictationReady,
  errorDetail,
  insertDictation,
  internalMicrophoneAllowed,
  recordingFileName,
  transcriptText,
  transcriptionEndpoint,
} from "../src/shared/dictation";
import { DictationService, recordingBytes, transcriptionError, type DictationFetch } from "../src/main/dictation-service";
import { SettingsStore, type SecretCipher } from "../src/main/settings-store";
import { defaultSettings, mergeSettings } from "../src/shared/settings";
import { commandForInput } from "../src/shared/shortcuts";

const cipher: SecretCipher = {
  isEncryptionAvailable: () => true,
  encryptString: (plain) => Buffer.from(`enc:${plain}`),
  decryptString: (enc) => enc.toString().slice(4),
};

describe("dictation settings", () => {
  it("builds the transcription endpoint from a base URL", () => {
    expect(transcriptionEndpoint("https://api.openai.com/v1")).toBe("https://api.openai.com/v1/audio/transcriptions");
    expect(transcriptionEndpoint(" https://api.groq.com/openai/v1/ ")).toBe("https://api.groq.com/openai/v1/audio/transcriptions");
    expect(transcriptionEndpoint("http://localhost:8000/v1/audio/transcriptions")).toBe("http://localhost:8000/v1/audio/transcriptions");
    expect(transcriptionEndpoint("")).toBeNull();
    expect(transcriptionEndpoint("file:///etc/passwd")).toBeNull();
    expect(transcriptionEndpoint("not a url")).toBeNull();
  });

  it("is ready only when on, with an address and a model", () => {
    const off = defaultSettings().dictation;
    expect(off.enabled).toBe(false);
    expect(dictationReady(off)).toBe(false);
    const preset = DICTATION_PRESETS[0]!;
    expect(dictationReady({ ...off, enabled: true, baseUrl: preset.baseUrl, model: preset.model })).toBe(true);
    expect(dictationReady({ ...off, enabled: false, baseUrl: preset.baseUrl, model: preset.model })).toBe(false);
    expect(dictationReady({ ...off, enabled: true, baseUrl: preset.baseUrl, model: " " })).toBe(false);
  });

  it("validates what is saved", () => {
    const base = defaultSettings();
    const merged = mergeSettings(base, { dictation: { enabled: true, baseUrl: "  https://x.test/v1  ", model: " whisper-1 ", language: "es" } });
    expect(merged.dictation).toEqual({ enabled: true, baseUrl: "https://x.test/v1", model: "whisper-1", language: "es" });
    expect(mergeSettings(base, { dictation: { language: "Spanish!" } }).dictation.language).toBe("");
    expect(mergeSettings(base, { dictation: { enabled: "yes" } }).dictation.enabled).toBe(false);
  });

  it("speaks a task with Ctrl+Shift+K (Cmd+Shift+K on macOS)", () => {
    const key = (k: string, mods: { control?: boolean; meta?: boolean }) => ({ type: "keyDown", key: k, control: false, meta: false, shift: true, alt: false, ...mods });
    expect(commandForInput(key("K", { control: true }), "win32")).toEqual({ type: "voice-command" });
    expect(commandForInput(key("K", { meta: true }), "darwin")).toEqual({ type: "voice-command" });
  });
});

describe("microphone for Corvus's own UI", () => {
  const ready = true;
  it("opens only for audio, on the Command Bar and Assist, while dictation is set up", () => {
    expect(internalMicrophoneAllowed("media", ["audio"], "corvus://chrome/", ready)).toBe(true);
    expect(internalMicrophoneAllowed("media", ["audio"], "corvus://assist/", ready)).toBe(true);
    expect(internalMicrophoneAllowed("media", ["audio"], "corvus://assist/", false)).toBe(false);
    expect(internalMicrophoneAllowed("media", ["audio", "video"], "corvus://chrome/", ready)).toBe(false);
    expect(internalMicrophoneAllowed("media", ["video"], "corvus://chrome/", ready)).toBe(false);
    expect(internalMicrophoneAllowed("media", [], "corvus://chrome/", ready)).toBe(false);
    expect(internalMicrophoneAllowed("media", undefined, "corvus://chrome/", ready)).toBe(false);
    expect(internalMicrophoneAllowed("media", ["audio"], "corvus://settings/", ready)).toBe(false);
    expect(internalMicrophoneAllowed("media", ["audio"], "https://example.com/", ready)).toBe(false);
    expect(internalMicrophoneAllowed("geolocation", undefined, "corvus://chrome/", ready)).toBe(false);
    expect(internalMicrophoneAllowed("notifications", undefined, "corvus://assist/", ready)).toBe(false);
  });
});

describe("transcription answers", () => {
  it("reads the text and the service's error message", () => {
    expect(transcriptText({ text: "  open   the\nweather " })).toBe("open the weather");
    expect(transcriptText({})).toBe("");
    expect(transcriptText(null)).toBe("");
    expect(errorDetail(JSON.stringify({ error: { message: "Invalid file format." } }))).toBe("Invalid file format.");
    expect(errorDetail(JSON.stringify({ detail: "model not found" }))).toBe("model not found");
    expect(errorDetail("Bad Gateway")).toBe("Bad Gateway");
    expect(transcriptionError(401, "")).toMatch(/refused the API key/);
    expect(transcriptionError(500, JSON.stringify({ error: { message: "boom" } }))).toBe("The transcription service failed (HTTP 500): boom");
    expect(transcriptionError(502, "")).toBe("The transcription service failed (HTTP 502).");
  });

  it("names the recording after its type and adds dictated text after what is typed", () => {
    expect(recordingFileName("audio/webm;codecs=opus")).toBe("dictation.webm");
    expect(recordingFileName("audio/ogg")).toBe("dictation.ogg");
    expect(recordingFileName("audio/mp4")).toBe("dictation.m4a");
    expect(insertDictation("", " hello ")).toBe("hello");
    expect(insertDictation("> book", "a table for two")).toBe("> book a table for two");
    expect(insertDictation("ends with space ", "more")).toBe("ends with space more");
    expect(insertDictation("kept", "  ")).toBe("kept");
  });

  it("refuses what is not a recording or is too long", () => {
    expect(() => recordingBytes("audio")).toThrow();
    expect(() => recordingBytes(new Uint8Array(MAX_DICTATION_BYTES + 1))).toThrow(/too long/);
    expect(recordingBytes(new Uint8Array(3)).byteLength).toBe(3);
  });
});

describe("DictationService", () => {
  let dir: string;
  let settings: SettingsStore;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "corvus-dictation-"));
    settings = new SettingsStore(dir, cipher, {});
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const setUp = (): void => {
    settings.update({ dictation: { enabled: true, baseUrl: "https://stt.test/v1/", model: "whisper-large-v3-turbo", language: "es" } });
  };

  it("sends the recording, model, language and key to the service and returns the text", async () => {
    setUp();
    settings.setSecret("transcriptionApiKey", "sk-test");
    const calls: Array<{ url: string; auth: string | undefined; fields: Record<string, string>; file: { name: string; size: number; type: string } | null }> = [];
    const fetcher: DictationFetch = async (url, init) => {
      const form = init.body as FormData;
      const file = form.get("file") as File | null;
      calls.push({
        url,
        auth: (init.headers as Record<string, string>).Authorization,
        fields: { model: String(form.get("model")), language: String(form.get("language")), response_format: String(form.get("response_format")) },
        file: file ? { name: file.name, size: file.size, type: file.type } : null,
      });
      return new Response(JSON.stringify({ text: " Abre el tiempo en Lisboa " }), { status: 200 });
    };
    const service = new DictationService(settings, fetcher);
    expect(service.ready()).toBe(true);
    const text = await service.transcribe(new Uint8Array([1, 2, 3, 4]), "audio/webm;codecs=opus");
    expect(text).toBe("Abre el tiempo en Lisboa");
    expect(calls).toEqual([
      {
        url: "https://stt.test/v1/audio/transcriptions",
        auth: "Bearer sk-test",
        fields: { model: "whisper-large-v3-turbo", language: "es", response_format: "json" },
        file: { name: "dictation.webm", size: 4, type: "audio/webm;codecs=opus" },
      },
    ]);
  });

  it("sends no key when none is saved, and takes a plain-text answer", async () => {
    setUp();
    let auth: string | undefined = "unset";
    const service = new DictationService(settings, async (_url, init) => {
      auth = (init.headers as Record<string, string>).Authorization;
      return new Response("hola", { status: 200 });
    });
    expect(await service.transcribe(new Uint8Array([1]), "audio/webm")).toBe("hola");
    expect(auth).toBeUndefined();
  });

  it("explains failures and refuses to run when not set up", async () => {
    const off = new DictationService(settings, async () => new Response("{}"));
    await expect(off.transcribe(new Uint8Array([1]), "audio/webm")).rejects.toThrow(/not set up/);
    setUp();
    const refused = new DictationService(settings, async () => new Response(JSON.stringify({ error: { message: "bad key" } }), { status: 401 }));
    await expect(refused.transcribe(new Uint8Array([1]), "audio/webm")).rejects.toThrow(/refused the API key/);
    const down = new DictationService(settings, async () => {
      throw new TypeError("fetch failed");
    });
    await expect(down.transcribe(new Uint8Array([1]), "audio/webm")).rejects.toThrow(/could not be reached/);
    const silent = new DictationService(settings, async () => {
      throw new Error("must not be called");
    });
    expect(await silent.transcribe(new Uint8Array(0), "audio/webm")).toBe("");
  });

  it("keeps the API key out of settings and reports whether it is set", () => {
    settings.setSecret("transcriptionApiKey", "sk-test");
    expect(settings.view().secrets.transcriptionApiKey).toBe(true);
    expect(JSON.stringify(settings.get())).not.toContain("sk-test");
  });
});
