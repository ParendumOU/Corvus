/**
 * Agent toolset contract: visual (coordinate) input, richer page reading, waiting, devtools-style
 * inspection and human handoff. Every method is optional on BrowserController so implementations
 * can grow into it; the MCP server only exposes tools whose methods exist.
 *
 * Coordinates are always CSS pixels relative to the top-level viewport, the same space as an
 * unscaled `capture()` image and the `bbox` of snapshot elements.
 */
import type { Tab, TabId } from "./browser.js";

/** What MCP clients may do. read < standard < full. */
export type AccessLevel = "read" | "standard" | "full";
export const ACCESS_LEVELS: readonly AccessLevel[] = ["read", "standard", "full"];

export interface Viewport {
  /** CSS pixels. */
  width: number;
  height: number;
  devicePixelRatio: number;
  scrollX: number;
  scrollY: number;
  zoom: number;
}

/** [x, y, width, height] in CSS pixels of the top-level viewport. */
export type BBox = [number, number, number, number];

export type ChallengeKind = "recaptcha" | "hcaptcha" | "turnstile" | "arkose" | "datadome" | "interstitial";

/** A human-verification challenge on the page. Agents must hand these to the user, never solve them. */
export interface ChallengeInfo {
  kind: ChallengeKind;
  detail: string;
  bbox?: BBox;
}

export type DialogType = "alert" | "confirm" | "prompt" | "beforeunload";

export interface DialogInfo {
  type: DialogType;
  message: string;
  defaultPrompt?: string;
  url: string;
  at: number;
}

export interface SnapshotElement {
  ref: string;
  role: string;
  name: string;
  value?: string;
  /** e.g. disabled, checked, unchecked, mixed, selected, expanded, collapsed, pressed, required, readonly, focused, cross-origin */
  states?: string[];
  /** Heading level. */
  level?: number;
  /** Option labels of a <select>, capped. */
  options?: string[];
  bbox?: BBox;
}

export interface SnapshotOptions {
  maxChars?: number;
  /** Only elements that intersect the viewport. */
  viewportOnly?: boolean;
  /** Include bounding boxes. */
  boxes?: boolean;
  /** Include the main text (default true). */
  text?: boolean;
  maxElements?: number;
}

export interface CaptureOptions {
  mode?: "viewport" | "full" | "element";
  /** Element ref for mode "element". */
  ref?: string;
  /** Output pixels per CSS pixel, 0.1-2. Default 1. */
  scale?: number;
  format?: "png" | "jpeg";
  /** JPEG quality 1-100. */
  quality?: number;
}

export interface Capture {
  mimeType: "image/png" | "image/jpeg";
  base64: string;
  /** Image size in pixels. */
  width: number;
  height: number;
  /** Image pixels per CSS pixel. */
  scale: number;
  viewport: Viewport;
  /** Captured region in CSS pixels (viewport coordinates; page coordinates for mode "full"). */
  clip: { x: number; y: number; width: number; height: number };
  challenge?: ChallengeInfo;
}

export type MouseButton = "left" | "right" | "middle";

export interface Point {
  x: number;
  y: number;
}

export type AgentInput =
  | { type: "click"; x: number; y: number; button?: MouseButton; clickCount?: number; modifiers?: string[] }
  | { type: "move"; x: number; y: number }
  | { type: "drag"; from: Point; to: Point; steps?: number }
  | { type: "wheel"; x: number; y: number; deltaX: number; deltaY: number }
  /** Key combos such as "Control+A", "Enter", "Shift+Tab". Pressed in order. */
  | { type: "keys"; keys: string[] }
  /** Real key events for each character. */
  | { type: "text"; text: string; delayMs?: number };

export type ElementAction =
  | { type: "hover" }
  | { type: "focus" }
  | { type: "check"; checked: boolean }
  /** Matches option values or labels. */
  | { type: "select"; values: string[] };

/** A form value: text for text fields, boolean for checkboxes/radios, string[] for (multi) selects. */
export type FieldValue = string | boolean | string[];

export interface FindQuery {
  text?: string;
  selector?: string;
  role?: string;
  exact?: boolean;
  limit?: number;
}

export interface WaitCondition {
  /** Text appears anywhere in the page (case-insensitive). */
  text?: string;
  /** Text no longer present. */
  textGone?: string;
  ref?: string;
  selector?: string;
  state?: "visible" | "hidden" | "attached" | "detached";
  /** URL contains this string, or matches it as a glob when it contains "*". */
  url?: string;
  /** No network requests in flight for 500 ms. */
  networkIdle?: boolean;
  /** Wait for the tab to finish loading. */
  load?: boolean;
  timeoutMs?: number;
}

export interface WaitResult {
  matched: boolean;
  elapsedMs: number;
  url: string;
  detail?: string;
}

export type ExtractKind = "markdown" | "tables" | "links" | "metadata";

export interface ExtractOptions {
  kind: ExtractKind;
  /** Limit to an element (default: main content for markdown, whole page otherwise). */
  ref?: string;
  maxChars?: number;
  /** Max tables/links/rows. */
  limit?: number;
}

export interface ExtractedTable {
  ref?: string;
  caption?: string;
  headers: string[];
  rows: string[][];
  totalRows: number;
}

export interface ExtractResult {
  url: string;
  title: string;
  markdown?: string;
  tables?: ExtractedTable[];
  links?: Array<{ text: string; href: string }>;
  metadata?: Record<string, string>;
  truncated: boolean;
}

export interface ConsoleEntry {
  level: string;
  text: string;
  source?: string;
  at: number;
}

export interface NetworkEntry {
  method: string;
  url: string;
  type?: string;
  status?: number;
  mimeType?: string;
  bytes?: number;
  durationMs?: number;
  failed?: string;
  at: number;
}

export interface DownloadEntry {
  id: string;
  url: string;
  filename: string;
  path: string;
  state: string;
  receivedBytes: number;
  totalBytes: number;
  startedAt: number;
}

export interface CookieInfo {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  /** True when the cookie has no explicit expiry (dropped when the session ends). */
  session: boolean;
  /** Unix seconds; absent for session cookies. */
  expiresAt?: number;
  sameSite?: "no_restriction" | "lax" | "strict" | "unspecified";
}

export interface UserActionRequest {
  message: string;
  timeoutMs: number;
}

export interface UserActionResult {
  outcome: "done" | "cancelled" | "timeout";
  waitedMs: number;
}

export interface ViewportOverride {
  width: number;
  height: number;
  deviceScaleFactor?: number;
  mobile?: boolean;
}

export interface AgentCapabilities {
  capture?(id: TabId, opts?: CaptureOptions): Promise<Capture>;
  input?(id: TabId, action: AgentInput): Promise<void>;
  elementAction?(id: TabId, ref: string, action: ElementAction): Promise<void>;
  fill?(id: TabId, ref: string, value: FieldValue): Promise<void>;
  uploadFiles?(id: TabId, ref: string, paths: string[]): Promise<{ files: number }>;
  find?(id: TabId, query: FindQuery): Promise<SnapshotElement[]>;
  waitFor?(id: TabId, condition: WaitCondition, signal?: AbortSignal): Promise<WaitResult>;
  getText?(id: TabId, opts?: { ref?: string; maxChars?: number }): Promise<{ text: string; truncated: boolean }>;
  extract?(id: TabId, opts: ExtractOptions): Promise<ExtractResult>;
  getHtml?(id: TabId, opts?: { ref?: string; selector?: string; maxChars?: number }): Promise<{ html: string; truncated: boolean }>;
  consoleMessages?(id: TabId, opts?: { level?: string; limit?: number; clear?: boolean }): Promise<ConsoleEntry[]>;
  networkRequests?(id: TabId, opts?: { filter?: string; failedOnly?: boolean; limit?: number; clear?: boolean }): Promise<NetworkEntry[]>;
  pendingDialog?(id: TabId): Promise<DialogInfo | null>;
  handleDialog?(id: TabId, opts: { accept: boolean; promptText?: string }): Promise<DialogInfo>;
  pdf?(id: TabId, opts?: { landscape?: boolean; printBackground?: boolean }): Promise<{ path: string; bytes: number }>;
  setZoom?(id: TabId, factor: number): Promise<number>;
  setViewport?(id: TabId, viewport: ViewportOverride | null): Promise<void>;
  listDownloads?(limit?: number): Promise<DownloadEntry[]>;
  waitForLoad?(id: TabId, timeoutMs?: number): Promise<Tab>;
  detectChallenge?(id: TabId): Promise<ChallengeInfo | null>;
  requestUserAction?(id: TabId, request: UserActionRequest, signal?: AbortSignal): Promise<UserActionResult>;
  /** Cookies the tab's current site can read. Scoped to that origin — never another site's cookies. */
  cookies?(id: TabId): Promise<CookieInfo[]>;
  /** Removes every cookie named `name` set for the tab's current site. Returns how many were removed. */
  clearCookie?(id: TabId, name: string): Promise<{ removed: number }>;
  /** Downloads a URL into the browser's downloads folder through the normal download path, capped at maxBytes. */
  download?(id: TabId, url: string, opts?: { maxBytes?: number }): Promise<DownloadEntry>;
  /**
   * Fills the current 2FA code of a saved login into the field `ref`, only when the user allowed agents
   * to use that login's code and approves this use. The browser fills it; the result never contains it.
   */
  fillTotp?(id: TabId, ref: string, opts?: { username?: string }): Promise<CredentialFillResult>;
  /**
   * Fills a saved login (username and password) around the field `ref`, or into the page's login form,
   * under the same opt-in and approval gates. The result never contains the password.
   */
  fillLogin?(id: TabId, opts?: { ref?: string; username?: string }): Promise<CredentialFillResult>;
  /**
   * Why script access and raw page reads are refused on this tab, or null when they are allowed. A
   * tab is locked after the browser fills a saved password or 2FA code into it, until its main frame
   * navigates to a new document. The MCP server checks this before evaluate and raw DOM/text reads.
   */
  secretFillLock?(id: TabId): Promise<string | null>;
  /**
   * Role, accessible name and page context of the element `ref` (computed like page_snapshot), plus
   * its form's action and default submit button. Used by the spend gate; null when the element is gone.
   */
  describeTarget?(id: TabId, ref: string): Promise<ActionTarget | null>;
  /**
   * Asks the person, in a native browser dialog, to allow one action that spends money. Resolves true
   * only when they allow it. MCP tools call this for every spend, at every access level.
   */
  confirmSpend?(id: TabId, request: SpendApprovalRequest): Promise<boolean>;
}

/** The element an action targets, as the spend gate sees it. */
export interface ActionTarget {
  /** URL of the page the element is on. */
  url: string;
  role: string;
  name: string;
  /** The form the element belongs to, when it is in one. */
  form?: { action?: string; submitName?: string; submitRole?: string };
}

/** One money-spending action an AI client wants to take. */
export interface SpendApprovalRequest {
  /** What it does, e.g. `Click "Place order" on shop.example`. */
  action: string;
  /** Host of the page, e.g. "shop.example". */
  host: string;
}

/** Outcome of a credential fill by reference. `message` is safe to show a model: it never holds a secret. */
export interface CredentialFillResult {
  /** filled: done; handoff: not allowed, hand the step to the user; declined: the user said no; error: bad ref or page. */
  status: "filled" | "handoff" | "declined" | "error";
  message: string;
}
