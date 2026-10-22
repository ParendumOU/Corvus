import { createHash, timingSafeEqual } from "node:crypto";

const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost"]);

/** Constant-time check of an `Authorization: Bearer <token>` header. */
export function bearerMatches(header: string | undefined, token: string): boolean {
  if (!header) return false;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
  if (!match?.[1]) return false;
  // Hashing first gives equal-length buffers, so timingSafeEqual never leaks the token length.
  const a = createHash("sha256").update(match[1]).digest();
  const b = createHash("sha256").update(token).digest();
  return timingSafeEqual(a, b);
}

/** True when the server bound a loopback interface (the strict DNS-rebinding checks apply). */
function bindsLoopback(bindHost: string): boolean {
  return bindHost !== "0.0.0.0" && bindHost !== "::";
}

/**
 * Host header validation. On a loopback listener it must name the loopback host on the bound port
 * (anything else is a DNS-rebinding attempt). On an all-interfaces listener the reachable LAN
 * name/IP can't be enumerated, so we only require a well-formed authority on the bound port — the
 * mandatory bearer token is the real gate (a rebinding page can't read it).
 */
export function isAllowedHost(host: string | undefined, port: number, bindHost = "127.0.0.1"): boolean {
  if (!host) return false;
  let parsed: URL;
  try {
    parsed = new URL(`http://${host}`);
  } catch {
    return false;
  }
  if (parsed.username || parsed.password || parsed.pathname !== "/") return false;
  if (bindsLoopback(bindHost) && !LOOPBACK_HOSTNAMES.has(parsed.hostname)) return false;
  return parsed.port === "" || parsed.port === String(port);
}

/**
 * Origin is optional (non-browser clients omit it). On a loopback listener a present Origin must be
 * a loopback web origin; on an all-interfaces listener any http(s) Origin is accepted because the
 * bearer token, not the Origin, authorizes the request.
 */
export function isAllowedOrigin(origin: string | undefined, bindHost = "127.0.0.1"): boolean {
  if (origin === undefined) return true;
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  return !bindsLoopback(bindHost) || LOOPBACK_HOSTNAMES.has(parsed.hostname);
}

export interface RateLimitOptions {
  /** Burst size: tool calls allowed back to back. */
  capacity: number;
  /** Sustained tool calls per second. */
  refillPerSecond: number;
}

export class TokenBucket {
  private tokens: number;
  private last: number;

  constructor(
    private readonly opts: RateLimitOptions,
    private readonly now: () => number = Date.now,
  ) {
    this.tokens = opts.capacity;
    this.last = now();
  }

  /** Takes one token; returns 0 on success, otherwise the milliseconds until one is available. */
  take(): number {
    const now = this.now();
    this.tokens = Math.min(this.opts.capacity, this.tokens + ((now - this.last) / 1000) * this.opts.refillPerSecond);
    this.last = now;
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return 0;
    }
    return Math.ceil(((1 - this.tokens) / this.opts.refillPerSecond) * 1000);
  }
}
