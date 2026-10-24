/**
 * Pages sent from one device to another (sync collection `sent_tabs`, one record per page, keyed by
 * a random id). The receiving device opens the page once and deletes the record; the sender sees
 * it waiting until then and can take it back.
 */
import { MAX_TAB_TITLE, isSyncableTabUrl } from "./open-tabs.js";

export interface SentTab {
  url: string;
  title: string;
  /** Device id of the receiving device. */
  to: string;
  /** Device id and display name of the sending device. */
  fromId: string;
  from: string;
  sentAt: number;
}

/** Record ids: random, URL-safe. */
export const SENT_TAB_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const DEVICE_ID_RE = /^[A-Za-z0-9-]{8,64}$/;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Validate a record received from another device; null when it is not a page that can be opened. */
export function parseSentTab(raw: unknown): SentTab | null {
  if (!isObject(raw) || typeof raw.url !== "string" || !isSyncableTabUrl(raw.url)) return null;
  if (typeof raw.to !== "string" || !DEVICE_ID_RE.test(raw.to)) return null;
  if (typeof raw.fromId !== "string" || !DEVICE_ID_RE.test(raw.fromId)) return null;
  if (typeof raw.sentAt !== "number" || !Number.isFinite(raw.sentAt)) return null;
  return {
    url: raw.url,
    title: typeof raw.title === "string" ? raw.title.slice(0, MAX_TAB_TITLE) : "",
    to: raw.to,
    fromId: raw.fromId,
    from: typeof raw.from === "string" ? raw.from.slice(0, 64) : "",
    sentAt: raw.sentAt,
  };
}

export interface SentTabRecord extends SentTab {
  id: string;
}

/** The valid records of a `sent_tabs` replica that match `filter`, oldest first. */
export function sentTabs(records: Record<string, unknown>, filter: (tab: SentTab) => boolean): SentTabRecord[] {
  const out: SentTabRecord[] = [];
  for (const [id, raw] of Object.entries(records)) {
    if (!SENT_TAB_ID_RE.test(id)) continue;
    const tab = parseSentTab(raw);
    if (tab && filter(tab)) out.push({ id, ...tab });
  }
  return out.sort((a, b) => a.sentAt - b.sentAt);
}

/** Pages to send: a URL as typed or shared, with or without its scheme ("example.com/a" works). */
export function normalizeSentUrl(input: string): string | null {
  const text = input.trim();
  // Shared text often wraps the link in a sentence ("Look at this https://...").
  const found = /https?:\/\/[^\s<>"]+/i.exec(text)?.[0] ?? (/^[^\s/]+\.[^\s/]{2,}(\/\S*)?$/.test(text) ? `https://${text}` : null);
  if (!found) return null;
  try {
    const url = new URL(found);
    return isSyncableTabUrl(url.href) ? url.href : null;
  } catch {
    return null;
  }
}
