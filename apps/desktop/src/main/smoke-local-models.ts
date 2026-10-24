import http from "node:http";
import type { WebContents } from "electron";
import type { AppContext } from "./context";
import type { BrowserWindowCtl } from "./window";

interface LocalModelsSmokeHelpers {
  win: BrowserWindowCtl;
  check: (name: string, ok: boolean, detail?: unknown) => void;
  capture: (name: string, wc: WebContents) => Promise<void>;
}

const OLLAMA_PORT = 11434;
const MODELS = ["llama3.1:8b", "nomic-embed-text:latest", "qwen2.5:7b"];

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function poll(wc: WebContents, expr: string, timeoutMs = 8000): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if ((await wc.executeJavaScript(`Boolean(${expr})`).catch(() => false)) === true) return true;
    await sleep(120);
  }
  return false;
}

/**
 * Local models: an Ollama stand-in on its default port is found from Settings > AI search, offered
 * in one click (embedding models left out), and its models fill the model picker.
 */
export async function runLocalModelsSmoke(ctx: AppContext, h: LocalModelsSmokeHelpers): Promise<void> {
  const { win, check, capture } = h;
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    if (req.url === "/api/tags") res.end(JSON.stringify({ models: MODELS.map((name) => ({ name })) }));
    else if (req.url === "/api/show") res.end(JSON.stringify({ capabilities: ["completion"] }));
    else res.end("{}");
  });
  const listening = await new Promise<boolean>((resolve) => {
    server.once("error", () => resolve(false));
    // No host: both IPv4 and IPv6 loopback, wherever "localhost" resolves.
    server.listen(OLLAMA_PORT, () => resolve(true));
  });
  if (!listening) {
    check("local models: an Ollama stand-in could listen on its default port", false, `port ${OLLAMA_PORT} is taken`);
    return;
  }
  const before = ctx.settings.get().ai;
  const tab = win.createTab("corvus://settings/#ai", { activate: true });
  const wc = tab.view.webContents;
  try {
    ctx.settings.update({ ai: { provider: "anthropic-api" } });
    const offered = await poll(wc, "document.querySelector('.local-offer') && document.querySelector('.local-offer').innerText.includes('Ollama')", 10_000);
    const offerText = (await wc.executeJavaScript("document.querySelector('.local-offer')?.innerText ?? ''")) as string;
    check("local models: Settings finds Ollama running on this computer", offered && offerText.includes("llama3.1:8b") && !offerText.includes("nomic"), offerText);
    await capture("settings-local-offer", wc);

    await wc.executeJavaScript("document.querySelector('.local-offer .btn.primary')?.click()");
    let switched = false;
    for (let i = 0; i < 40 && !switched; i++) {
      const ai = ctx.settings.get().ai;
      switched = ai.provider === "local" && ai.localApi === "ollama" && ai.localBaseUrl === `http://localhost:${OLLAMA_PORT}` && ai.model === "llama3.1:8b";
      await sleep(100);
    }
    check("local models: “Use Ollama” switches AI to it in one click", switched, ctx.settings.get().ai);

    const picker = await poll(wc, "[...document.querySelectorAll('#ai select')].some((s) => [...s.options].some((o) => o.value === 'qwen2.5:7b'))", 10_000);
    const options = (await wc.executeJavaScript(
      "[...[...document.querySelectorAll('#ai select')].find((s) => [...s.options].some((o) => o.value === 'qwen2.5:7b'))?.options ?? []].map((o) => o.textContent)",
    )) as string[];
    await wc.executeJavaScript(`(() => {
      const select = [...document.querySelectorAll('#ai select')].find((s) => [...s.options].some((o) => o.value === 'qwen2.5:7b'));
      select.value = 'qwen2.5:7b';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    let picked = false;
    for (let i = 0; i < 30 && !picked; i++) {
      picked = ctx.settings.get().ai.model === "qwen2.5:7b";
      await sleep(100);
    }
    check(
      "local models: the model picker lists the server's models and sets one",
      picker && picked && options.includes("nomic-embed-text:latest (embeddings)") && options.includes("llama3.1:8b"),
      { options, model: ctx.settings.get().ai.model },
    );
    await capture("settings-local-models", wc);
  } finally {
    ctx.settings.update({ ai: { provider: before.provider, model: before.model, localApi: before.localApi, localBaseUrl: before.localBaseUrl } });
    win.closeTab(tab.id);
    server.close();
  }
}
