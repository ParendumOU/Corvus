/**
 * IPC contract for the reader view (corvus://reader). The reader is its own trusted WebContentsView
 * in the default session, never a tab, so web pages, extensions and MCP agents cannot read or
 * script it. Article content it renders is sanitized page content (treated as data, not markup
 * that can run code).
 */
import type { TabId } from "@corvus/shared";

export const READER_RPC = "corvus:reader-rpc";
export const READER_EVENT = "corvus:reader-event";

export const READER_FONT_MIN = 15;
export const READER_FONT_MAX = 28;
export const READER_WIDTH_MIN = 36;
export const READER_WIDTH_MAX = 90;

export type ReaderTheme = "light" | "sepia" | "dark";
export type ReaderFontFamily = "serif" | "sans";

export interface ReaderSettings {
  /** Base font size in px. */
  fontSize: number;
  /** Measure (content column width) in rem-ish ch units. */
  lineWidth: number;
  theme: ReaderTheme;
  font: ReaderFontFamily;
}

export interface ReaderDoc {
  url: string;
  title: string;
  byline: string;
  siteName: string;
  lang: string;
  dir: "ltr" | "rtl" | "";
  /** Sanitized article HTML; headings carry data-corvus-section="n". */
  content: string;
  excerpt: string;
  wordCount: number;
  readingMinutes: number;
  sectionHeadings: string[];
}

export type ReaderToolKind = "key-points" | "tldr" | "simplify" | "eli5" | "translate" | "define" | "explain";

export const READER_TOOLS: ReadonlyArray<{ kind: ReaderToolKind; label: string }> = [
  { kind: "key-points", label: "Key points" },
  { kind: "tldr", label: "TL;DR" },
  { kind: "simplify", label: "Simplify" },
  { kind: "eli5", label: "Explain like I'm 5" },
  { kind: "translate", label: "Translate" },
];

export interface ReaderUsage {
  inputTokens: number;
  outputTokens: number;
  model: string;
  cached: boolean;
  ms: number;
}

export interface ReaderToolMessage {
  id: string;
  kind: ReaderToolKind;
  label: string;
  /** Selection or term echoed back for define/explain/translate-of-selection. */
  prompt: string;
  text: string;
  status: "streaming" | "done" | "error" | "cancelled";
  error?: string;
  /** Key-points parse (also while streaming); sections are 0-based indices. */
  points?: Array<{ text: string; sections: number[] }>;
  usage?: ReaderUsage;
  at: number;
}

export interface ReaderState {
  /** The reader view is open for the active tab. */
  active: boolean;
  tabId: TabId | null;
  loading: boolean;
  error: string | null;
  dark: boolean;
  providerReady: boolean;
  setupReason: string | null;
  /** Default UI/answer language. */
  lang: string;
  translateLanguage: string;
  settings: ReaderSettings;
  doc: ReaderDoc | null;
  messages: ReaderToolMessage[];
  busy: boolean;
  saved: boolean;
  /** Bumped when the reader should take focus. */
  focusToken: number;
}

export type ReaderEventMessage = { type: "state"; state: ReaderState };

export interface ReaderRpc {
  "state.get"(): ReaderState;
  "reader.close"(): void;
  "reader.setSettings"(patch: Partial<ReaderSettings>): void;
  "reader.tool"(kind: ReaderToolKind, input?: string): void;
  "reader.cancel"(): void;
  "reader.clear"(): void;
  "reader.save"(): void;
  "reader.openReadingList"(): void;
  "reader.openLink"(url: string): void;
}

export interface ReaderBridge {
  call<K extends keyof ReaderRpc>(method: K, ...args: Parameters<ReaderRpc[K]>): Promise<Awaited<ReturnType<ReaderRpc[K]>>>;
  onEvent(listener: (event: ReaderEventMessage) => void): () => void;
}

// --------------------------------------------------------------- chrome UI + reading library

export interface ReaderChromeRpc {
  "reader.toggle"(): void;
}

import type { ReadingSummary } from "./reading";

export interface ReadingLibraryRpc {
  "reading.list"(query: string): ReadingSummary[];
  "reading.remove"(id: string): void;
  "reading.export"(id: string): boolean;
  "reading.open"(id: string): void;
}
