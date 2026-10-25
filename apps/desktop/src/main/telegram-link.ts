import { Notification, net } from "electron";
import { readUpdates, shareMessage, type TelegramConnectResult, type TelegramStatus } from "../shared/phone-share";
import type { AppContext } from "./context";
import { tr } from "./menu-i18n";

const API_TIMEOUT_MS = 15_000;
const POLL_MS = 30_000;

/**
 * The person's own Telegram bot as a bridge to their phone: Corvus sends pages to the private
 * chat linked to the bot, and opens links that chat sends back (nothing from any other chat).
 * The bot token lives in the OS keychain; only Telegram's Bot API is contacted, from the main process.
 */
export class TelegramLink {
  /** Telegram's Bot API; the smoke test points it at a local stand-in. */
  apiBase = "https://api.telegram.org";
  private offset: number | null = null;
  private timer: NodeJS.Timeout | null = null;
  private polling = false;

  constructor(private readonly ctx: AppContext) {}

  status(): TelegramStatus {
    const phone = this.ctx.settings.get().phone;
    return {
      hasToken: Boolean(this.ctx.settings.getSecret("telegramBotToken")),
      bot: phone.telegramBot,
      chatName: phone.telegramChatName,
      linked: Boolean(phone.telegramChatId && this.ctx.settings.getSecret("telegramBotToken")),
    };
  }

  private async call<T>(token: string, method: string, body: Record<string, unknown> = {}): Promise<T> {
    const res = await net.fetch(`${this.apiBase}/bot${token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
    const data = (await res.json().catch(() => null)) as { ok?: boolean; result?: T; description?: string } | null;
    if (!data?.ok) throw new Error(data?.description || `Telegram answered HTTP ${res.status}`);
    return data.result as T;
  }

  /**
   * "Connect": checks the token, then links the private chat that sent /start to the bot. Run
   * again after sending /start when no chat had done so yet. A new token unlinks the old chat.
   */
  async connect(token?: string): Promise<TelegramConnectResult> {
    const fresh = token?.trim();
    if (fresh && fresh !== this.ctx.settings.getSecret("telegramBotToken")) {
      this.ctx.settings.setSecret("telegramBotToken", fresh);
      this.ctx.settings.update({ phone: { telegramBot: "", telegramChatId: "", telegramChatName: "" } });
      this.offset = null;
    }
    const saved = this.ctx.settings.getSecret("telegramBotToken");
    if (!saved) return { ok: false, status: this.status(), message: "Paste your bot's token first." };
    try {
      const me = await this.call<{ username?: string }>(saved, "getMe");
      this.ctx.settings.update({ phone: { telegramBot: me.username ? `@${me.username}` : "" } });
      const updates = readUpdates({ ok: true, result: await this.call<unknown[]>(saved, "getUpdates", { allowed_updates: ["message"] }) }, "");
      if (updates.nextOffset !== null) this.offset = updates.nextOffset;
      const chat = updates.starts.at(-1);
      if (chat) {
        this.ctx.settings.update({ phone: { telegramChatId: chat.id, telegramChatName: chat.name } });
        await this.call(saved, "sendMessage", { chat_id: chat.id, text: "Corvus is linked: pages you send from Corvus arrive here, and links you send here open in Corvus." }).catch(() => undefined);
        this.ensurePolling();
        return { ok: true, status: this.status(), message: `Linked to ${chat.name}.` };
      }
      if (this.ctx.settings.get().phone.telegramChatId) return { ok: true, status: this.status(), message: "The bot works and your chat is linked." };
      const bot = me.username ? `@${me.username}` : "your bot";
      return { ok: true, status: this.status(), message: `Now open ${bot} in Telegram, send it /start, then click Connect again.` };
    } catch (err) {
      // Never echo the token back, whatever the error says.
      const detail = (err as Error).message.split(saved).join("[token]");
      return { ok: false, status: this.status(), message: `Telegram did not accept the token: ${detail}` };
    }
  }

  disconnect(): TelegramStatus {
    this.ctx.settings.setSecret("telegramBotToken", "");
    this.ctx.settings.update({ phone: { telegramBot: "", telegramChatId: "", telegramChatName: "" } });
    this.offset = null;
    return this.status();
  }

  /** Sends a page to the linked chat. */
  async send(url: string, title: string): Promise<void> {
    const token = this.ctx.settings.getSecret("telegramBotToken");
    const chatId = this.ctx.settings.get().phone.telegramChatId;
    if (!token || !chatId) throw new Error("Link a Telegram chat in Settings first.");
    await this.call(token, "sendMessage", { chat_id: chatId, text: shareMessage(url, title) });
  }

  /** Starts the poll for links from the linked chat (when it is linked and receiving is on). */
  start(): void {
    this.ensurePolling();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private ensurePolling(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.poll(), POLL_MS);
    this.timer.unref();
  }

  /** One look for new messages; links from the linked chat open as background tabs. */
  async poll(): Promise<string[]> {
    const token = this.ctx.settings.getSecret("telegramBotToken");
    const phone = this.ctx.settings.get().phone;
    if (this.polling || !token || !phone.telegramChatId || !phone.receiveLinks) return [];
    this.polling = true;
    try {
      const result = await this.call<unknown[]>(token, "getUpdates", { allowed_updates: ["message"], timeout: 0, ...(this.offset !== null ? { offset: this.offset } : {}) });
      const updates = readUpdates({ ok: true, result }, phone.telegramChatId);
      if (updates.nextOffset !== null) this.offset = updates.nextOffset;
      if (updates.links.length > 0) this.open(updates.links);
      return updates.links;
    } catch {
      return [];
    } finally {
      this.polling = false;
    }
  }

  private open(links: string[]): void {
    const win = this.ctx.windows.focused() ?? this.ctx.windows.all()[0];
    if (!win) return;
    for (const url of links) win.createTab(url, { activate: false });
    if (Notification.isSupported()) {
      const n = new Notification({ title: links.length === 1 ? tr("A link from your phone") : tr("{count} links from your phone", { count: links.length }), body: links.join("\n").slice(0, 200) });
      n.on("click", () => win.win.focus());
      n.show();
    }
  }
}
