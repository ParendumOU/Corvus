import http from "node:http";
import type { AddressInfo } from "node:net";
import type { WebContents } from "electron";
import type { AppContext } from "./context";
import type { BrowserWindowCtl } from "./window";

interface PhoneSmokeHelpers {
  url: string;
  win: BrowserWindowCtl;
  check: (name: string, ok: boolean, detail?: unknown) => void;
  capture: (name: string, wc: WebContents) => Promise<void>;
}

const TOKEN = "123456:SMOKE-token";
const ME = { id: 42, type: "private", first_name: "Ana", username: "ana" };

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
 * "Send to your phone": a QR code in a popover, the person's own Telegram bot linked from Settings
 * (a bad token refused without echoing it), a page sent to the linked chat, and links back from
 * that chat opened as tabs while other chats are ignored. Telegram is a local stand-in.
 */
export async function runPhoneSmoke(ctx: AppContext, h: PhoneSmokeHelpers): Promise<void> {
  const { win, check, capture } = h;
  const sent: Array<{ chat_id: unknown; text: unknown }> = [];
  let pending: unknown[] = [];
  let updateId = 100;
  const queue = (chat: Record<string, unknown>, text: string): void => {
    pending.push({ update_id: (updateId += 1), message: { chat, text } });
  };
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const m = /^\/bot([^/]+)\/(\w+)$/.exec(req.url ?? "");
      const reply = (data: unknown): void => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(data));
      };
      if (!m || m[1] !== TOKEN) return reply({ ok: false, description: "Unauthorized" });
      const args = (body ? JSON.parse(body) : {}) as Record<string, unknown>;
      if (m[2] === "getMe") return reply({ ok: true, result: { username: "corvus_smoke_bot" } });
      if (m[2] === "sendMessage") {
        sent.push({ chat_id: args.chat_id, text: args.text });
        return reply({ ok: true, result: {} });
      }
      if (m[2] === "getUpdates") {
        const offset = typeof args.offset === "number" ? args.offset : 0;
        const result = pending.filter((u) => (u as { update_id: number }).update_id >= offset);
        return reply({ ok: true, result });
      }
      reply({ ok: false, description: "Not Found" });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const apiBefore = ctx.telegram.apiBase;
  ctx.telegram.apiBase = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const opened: string[] = [];
  try {
    const bad = await ctx.telegram.connect("999:wrong-token");
    check("phone: a bad bot token is refused without echoing it", !bad.ok && !bad.message.includes("wrong-token") && !bad.status.linked, bad);

    const first = await ctx.telegram.connect(TOKEN);
    queue(ME, "/start");
    const linked = await ctx.telegram.connect();
    check(
      "phone: Connect links the private chat that sent /start",
      first.ok && /send it \/start/.test(first.message) && linked.ok && linked.status.linked && linked.status.chatName === "Ana (@ana)" && linked.status.bot === "@corvus_smoke_bot",
      { first: first.message, linked },
    );

    // The QR popover, and the page sent to the linked chat from it.
    const page = `${h.url}?send-to-phone`;
    await win.shareToPhone(page, "Smoke page");
    const chrome = win.chrome.webContents;
    const popover = await poll(chrome, "document.querySelector('.share-popover img.share-qr')?.complete && document.querySelector('.share-popover img.share-qr').naturalWidth > 0");
    await capture("share-to-phone", chrome);
    await chrome.executeJavaScript("[...document.querySelectorAll('.share-popover .btn')].find((b) => b.textContent.includes('Send to Telegram'))?.click()");
    let delivered = false;
    for (let i = 0; i < 40 && !delivered; i++) {
      delivered = sent.some((s) => s.chat_id === "42" && typeof s.text === "string" && s.text === `Smoke page\n${page}`);
      await sleep(100);
    }
    check("phone: the popover shows a QR code and sends the page to the linked chat", popover && delivered, { popover, sent });
    win.sendCommand({ type: "close-overlays" });

    // Links back: the linked chat's open as tabs; a stranger's do not.
    const mine = `${h.url}?from-phone`;
    const theirs = `${h.url}?from-stranger`;
    queue(ME, `look at this ${mine}`);
    queue({ id: 99, type: "private", first_name: "Stranger" }, theirs);
    const received = await ctx.telegram.poll();
    await sleep(300);
    const urls = win.tabRuntimes().map((t) => t.url);
    for (const t of win.tabRuntimes()) if (t.url.includes("from-phone") || t.url.includes("from-stranger")) opened.push(t.id);
    check(
      "phone: links from the linked chat open as tabs, others are ignored",
      received.join() === mine && urls.includes(mine) && !urls.includes(theirs),
      { received, urls: urls.filter((u) => u.includes("from-")) },
    );
    pending = [];

    const settings = win.createTab("corvus://settings/#phone", { activate: true });
    opened.push(settings.id);
    const shown = await poll(settings.view.webContents, "document.querySelector('#phone')?.innerText.includes('Ana (@ana)')");
    check("phone: Settings shows the linked chat", shown);
    await capture("settings-phone", settings.view.webContents);
  } finally {
    ctx.telegram.disconnect();
    ctx.telegram.apiBase = apiBefore;
    win.closeTabs(opened);
    server.close();
  }
}
