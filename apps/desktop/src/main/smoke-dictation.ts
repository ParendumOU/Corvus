import http from "node:http";
import type { AddressInfo } from "node:net";
import type { WebContents } from "electron";
import type { AnswerProvider } from "@corvus/ai-engine";
import type { AppContext } from "./context";
import type { BrowserWindowCtl } from "./window";

interface DictationSmokeHelpers {
  url: string;
  win: BrowserWindowCtl;
  check: (name: string, ok: boolean, detail?: unknown) => void;
  capture: (name: string, wc: WebContents) => Promise<void>;
}

interface Received {
  path: string;
  auth: string;
  type: string;
  model: boolean;
  bytes: number;
}

const SPOKEN = "weather in Lisbon tomorrow";
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function poll(wc: WebContents, expr: string, timeoutMs = 8000): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if ((await wc.executeJavaScript(`Boolean(${expr})`).catch(() => false)) === true) return true;
    await sleep(100);
  }
  return false;
}

/**
 * Voice dictation: with no service set up there is no microphone button and the shortcut opens
 * Settings; with a speech-to-text stand-in set up, the voice command shortcut records from
 * Chromium's fake microphone and puts the transcript into the Command Bar as an agent task, and
 * the Assist composer's microphone button dictates into the question.
 */
export async function runDictationSmoke(ctx: AppContext, h: DictationSmokeHelpers): Promise<void> {
  const { url, win, check, capture } = h;
  const received: Received[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      received.push({
        path: req.url ?? "",
        auth: req.headers.authorization ?? "",
        type: req.headers["content-type"] ?? "",
        model: body.includes('name="model"\r\n\r\nsmoke-stt'),
        bytes: body.length,
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ text: SPOKEN }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  const chrome = win.chrome.webContents;
  const before = ctx.settings.get().dictation;
  const opened: string[] = [];

  try {
    // Not set up: no microphone, and the shortcut leads to Settings.
    win.sendCommand({ type: "open-command-palette" });
    await poll(chrome, "document.querySelector('.cmdbar .cmd-input')");
    check("dictation: no microphone button until a service is set up", (await chrome.executeJavaScript("!document.querySelector('.cmd-mic')")) === true);
    win.sendCommand({ type: "close-overlays" });
    const tabsBefore = new Set(win.tabIds());
    win.runCommand({ type: "voice-command" });
    // Settings opens in a new tab, or in the Settings tab already open (it is a singleton).
    const urlOf = (id: string): string => win.getTab(id)?.view.webContents.getURL() ?? "";
    let settingsTab: string | undefined;
    for (let i = 0; i < 30 && !settingsTab; i++) {
      await sleep(100);
      settingsTab = win.tabIds().find((id) => urlOf(id).startsWith("corvus://settings/#dictation"));
    }
    check("dictation: the voice command shortcut opens Settings → Voice dictation when not set up", Boolean(settingsTab), win.tabIds().map(urlOf));
    if (settingsTab && !tabsBefore.has(settingsTab)) opened.push(settingsTab);

    ctx.settings.update({ dictation: { enabled: true, baseUrl: base, model: "smoke-stt", language: "en" } });
    ctx.settings.setSecret("transcriptionApiKey", "smoke-stt-key");

    // Voice command: Ctrl+Shift+K opens the Command Bar listening; pressing it again transcribes.
    win.runCommand({ type: "voice-command" });
    const listening = await poll(chrome, "document.querySelector('.cmd-mic.listening') && document.querySelector('.cmd-hint.listening')");
    check("dictation: the voice command shortcut opens the Command Bar listening", listening);
    await sleep(1200);
    await capture("dictation-command-bar-listening", chrome);
    win.runCommand({ type: "voice-command" });
    const typed = await poll(chrome, `document.querySelector('.cmd-input')?.value === ${JSON.stringify(`> ${SPOKEN}`)}`, 15_000);
    const value = (await chrome.executeJavaScript("document.querySelector('.cmd-input')?.value ?? ''")) as string;
    check("dictation: what was said lands in the Command Bar as a task for the agent", typed, { value, error: await chrome.executeJavaScript("document.querySelector('.cmd-dictation-error')?.innerText ?? ''") });
    const first = received[0];
    check(
      "dictation: the recording goes to the service set up, with its model and API key",
      Boolean(first && first.path === "/v1/audio/transcriptions" && first.auth === "Bearer smoke-stt-key" && first.type.startsWith("multipart/form-data") && first.model && first.bytes > 1000),
      first,
    );
    await capture("dictation-command-bar", chrome);
    win.sendCommand({ type: "close-overlays" });

    // Assist: the composer's microphone button dictates into the question.
    ctx.assist.setTestProvider({ kind: "anthropic-api", model: "smoke", answer: async function* () {} } as AnswerProvider);
    const page = win.createTab(`${url}ux-plain?dictation`, { activate: true });
    opened.push(page.id);
    await poll(page.view.webContents, "document.readyState === 'complete'");
    ctx.assist.open(win, "assist");
    const panel = ctx.assist.panelWebContents(win);
    const micShown = panel ? await poll(panel, "document.querySelector('.composer .mic')") : false;
    check("dictation: the Assist composer has a microphone button", micShown);
    if (panel && micShown) {
      await panel.executeJavaScript("document.querySelector('.composer .mic').click()");
      const panelListening = await poll(panel, "document.querySelector('.composer .mic.listening')");
      await sleep(1000);
      await capture("dictation-assist-listening", panel);
      await panel.executeJavaScript("document.querySelector('.composer .mic')?.click()");
      const dictated = await poll(panel, `document.querySelector('.composer textarea')?.value === ${JSON.stringify(SPOKEN)}`, 15_000);
      check("dictation: what was said lands in the Assist question", panelListening && dictated, {
        listening: panelListening,
        value: await panel.executeJavaScript("document.querySelector('.composer textarea')?.value ?? ''"),
        error: await panel.executeJavaScript("document.querySelector('.dictation-error')?.innerText ?? ''"),
      });
      await panel.executeJavaScript(
        "(() => { const t = document.querySelector('.composer textarea'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(t, ''); t.dispatchEvent(new Event('input', { bubbles: true })); })()",
      );
    }
    ctx.assist.close(win);
  } finally {
    ctx.assist.setTestProvider(undefined);
    ctx.settings.update({ dictation: before });
    ctx.settings.setSecret("transcriptionApiKey", "");
    win.sendCommand({ type: "close-overlays" });
    for (const id of opened) win.closeTab(id);
    server.close();
  }
}
