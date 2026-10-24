/**
 * "Send to your phone": a page as a QR code to scan, or sent through the person's own Telegram
 * bot, which can also send links back that Corvus opens. Pure rules here (reading the Bot API's
 * replies, finding links in a message); main/telegram-link.ts talks to the API.
 */

/** What the "Send to your phone" popover shows for a page. */
export interface PhoneShare {
  url: string;
  title: string;
  /** The URL as a QR code (SVG markup) for a phone camera. */
  qrSvg: string;
  /** A Telegram chat is linked, so "Send to Telegram" is offered. */
  telegram: boolean;
}

/** Telegram link state for Settings. */
export interface TelegramStatus {
  /** A bot token is saved. */
  hasToken: boolean;
  /** The bot's @username, once checked. */
  bot: string;
  /** The linked private chat (the person who sent /start to the bot). */
  chatName: string;
  linked: boolean;
}

/** The outcome of "Connect" in Settings. */
export interface TelegramConnectResult {
  ok: boolean;
  status: TelegramStatus;
  /** What to do next, or what went wrong. */
  message: string;
}

const MAX_LINKS_PER_MESSAGE = 5;

/** The http(s) links in a message, in order, without trailing punctuation, at most 5. */
export function extractLinks(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/https?:\/\/[^\s<>"']+/gi)) {
    const url = m[0].replace(/[),.;:!?»”’]+$/u, "");
    try {
      const parsed = new URL(url);
      if ((parsed.protocol === "http:" || parsed.protocol === "https:") && !out.includes(parsed.href)) out.push(parsed.href);
    } catch {
      // Not a URL after all.
    }
    if (out.length >= MAX_LINKS_PER_MESSAGE) break;
  }
  return out;
}

interface RawChat {
  id?: unknown;
  type?: unknown;
  first_name?: unknown;
  last_name?: unknown;
  username?: unknown;
}

interface RawUpdate {
  update_id?: unknown;
  message?: { chat?: RawChat; text?: unknown; caption?: unknown };
}

/** A chat's display name: "First Last (@user)". */
function chatName(chat: RawChat): string {
  const name = [chat.first_name, chat.last_name].filter((p): p is string => typeof p === "string" && p !== "").join(" ");
  const user = typeof chat.username === "string" && chat.username ? `@${chat.username}` : "";
  return name && user ? `${name} (${user})` : name || user || "Telegram";
}

/**
 * Reads a getUpdates reply: the links sent from the linked chat (other chats are ignored), the
 * private chats that sent /start (to link one), and the offset that acknowledges these updates.
 */
export function readUpdates(raw: unknown, linkedChatId: string): { links: string[]; starts: Array<{ id: string; name: string }>; nextOffset: number | null } {
  const result = (raw as { ok?: unknown; result?: unknown } | null)?.result;
  const updates = Array.isArray(result) ? (result as RawUpdate[]) : [];
  const links: string[] = [];
  const starts: Array<{ id: string; name: string }> = [];
  let last = -1;
  for (const u of updates) {
    if (typeof u.update_id === "number") last = Math.max(last, u.update_id);
    const chat = u.message?.chat;
    if (!chat || chat.type !== "private" || (typeof chat.id !== "number" && typeof chat.id !== "string")) continue;
    const id = String(chat.id);
    const text = typeof u.message?.text === "string" ? u.message.text : typeof u.message?.caption === "string" ? u.message.caption : "";
    if (/^\/start\b/.test(text.trim())) {
      if (!starts.some((s) => s.id === id)) starts.push({ id, name: chatName(chat) });
      continue;
    }
    if (linkedChatId && id === linkedChatId) for (const url of extractLinks(text)) if (!links.includes(url)) links.push(url);
  }
  return { links, starts, nextOffset: last >= 0 ? last + 1 : null };
}

/** The message a page is sent as: its title, then its address (Telegram shows a preview). */
export function shareMessage(url: string, title: string): string {
  const t = title.replace(/\s+/g, " ").trim().slice(0, 200);
  return t && t !== url ? `${t}\n${url}` : url;
}
