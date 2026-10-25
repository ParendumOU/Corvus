import type { HosterReason } from "../../shared/hosters";

/**
 * What a hoster resolver works with: requests through the profile's session (so the person's
 * sign-ins and premium accounts count), and what it finds out about a link.
 */

export interface HostResponse {
  status: number;
  /** Final address, after redirects. */
  url: string;
  header(name: string): string | null;
  /** The body is a file (an attachment, or not a page/JSON/script). */
  isFile: boolean;
  /** At most a few MB of the body, as text. */
  text(): Promise<string>;
  json(): Promise<unknown>;
  /** Drops the body unread. */
  cancel(): Promise<void>;
}

export interface FetchInit {
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  /** application/x-www-form-urlencoded body. */
  form?: Record<string, string>;
  /** JSON body. */
  json?: unknown;
}

export interface HosterNet {
  fetch(url: string, init?: FetchInit): Promise<HostResponse>;
  /** A cookie of the profile's session for that address. */
  cookie(url: string, name: string): Promise<string | null>;
  setCookie(url: string, name: string, value: string): Promise<void>;
  /** Waits, unless the download is paused or removed meanwhile (then it throws). */
  sleep(ms: number): Promise<void>;
}

/** MEGA files arrive encrypted: AES-128-CTR with this key and counter (hex). */
export interface MegaCipher {
  key: string;
  iv: string;
}

/** A file link found inside a folder (or a list) link. */
export interface FolderEntry {
  url: string;
  filename?: string;
  size?: number;
  /** The address is the file itself; otherwise it is resolved like any hoster link. */
  direct?: boolean;
}

export type Resolution =
  | {
      type: "file";
      url: string;
      filename?: string;
      size?: number;
      mega?: MegaCipher;
      /** False when the host must not be asked for parts in parallel (free downloads). */
      segments?: boolean;
    }
  | { type: "folder"; name?: string; entries: FolderEntry[] }
  /** The host asks to wait before the next download (a free-account limit or a countdown). */
  | { type: "wait"; seconds: number; reason: HosterReason }
  /** Only the person can go on: a CAPTCHA, a sign-in, a password, a premium-only file. */
  | { type: "attention"; reason: HosterReason }
  /** The file is gone (deleted, taken down, wrong address). */
  | { type: "offline"; reason: HosterReason };

export type Resolver = (url: string, net: HosterNet) => Promise<Resolution>;

/** Resolution helpers. */
export const file = (url: string, extra: Omit<Extract<Resolution, { type: "file" }>, "type" | "url"> = {}): Resolution => ({ type: "file", url, ...extra });
export const attention = (reason: HosterReason): Resolution => ({ type: "attention", reason });
export const offline = (): Resolution => ({ type: "offline", reason: "offline" });
export const wait = (seconds: number, reason: HosterReason): Resolution => ({ type: "wait", seconds: Math.max(1, Math.round(seconds)), reason });
