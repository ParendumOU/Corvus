import type { Scope, ScopeEntry } from "./types.js";

export function emptyScope(): Scope {
  return { enabled: false, include: [], exclude: [] };
}

/** Convert a glob (`*` = any run of characters) into an anchored, case-insensitive regex. */
function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.*+?^${}()|[\]\\]/g, (ch) => (ch === "*" ? "\u0000" : `\\${ch}`));
  return new RegExp(`^${escaped.replace(/\u0000/g, ".*")}$`, "i");
}

/**
 * Normalize a hostname for matching so scope cannot be bypassed with cosmetic variants:
 * lowercased, trailing dot removed, surrounding brackets (IPv6) stripped. Returns "" on failure.
 */
export function normalizeHost(host: string): string {
  return host
    .trim()
    .toLowerCase()
    .replace(/\.+$/, "")
    .replace(/^\[|\]$/g, "");
}

export interface ParsedTarget {
  host: string;
  port: number | null;
  path: string;
  href: string;
}

/**
 * Parse a URL into the fields scope matches on. Userinfo (`user:pass@`) is dropped so it cannot be
 * used to smuggle an in-scope host into the authority (`https://trusted.com@evil.com/`).
 */
export function parseTarget(url: string): ParsedTarget | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  const host = normalizeHost(parsed.hostname);
  if (!host) return null;
  const port = parsed.port ? Number(parsed.port) : null;
  return { host, port, path: parsed.pathname + parsed.search, href: parsed.href };
}

function entryMatches(entry: ScopeEntry, target: ParsedTarget): boolean {
  if (!entry.enabled) return false;
  const host = normalizeHost(entry.host);
  if (host && !globToRegExp(host).test(target.host)) return false;
  if (entry.port !== undefined && entry.port !== target.port) return false;
  if (entry.pathPrefix) {
    const prefix = entry.pathPrefix;
    const matchesPrefix = prefix.includes("*")
      ? globToRegExp(prefix.endsWith("*") ? prefix : `${prefix}*`).test(target.path)
      : target.path.startsWith(prefix);
    if (!matchesPrefix) return false;
  }
  return true;
}

/**
 * Whether a URL is in scope: scope must be enabled, at least one include entry must match, and no
 * exclude entry may match (exclude always wins). Invalid or non-http(s) URLs are never in scope.
 */
export function isInScope(scope: Scope, url: string): boolean {
  if (!scope.enabled) return false;
  const target = parseTarget(url);
  if (!target) return false;
  if (!scope.include.some((e) => entryMatches(e, target))) return false;
  if (scope.exclude.some((e) => entryMatches(e, target))) return false;
  return true;
}

/** Human-readable reason a URL is out of scope, for error messages returned to agents. */
export function scopeRejectionReason(scope: Scope, url: string): string | null {
  if (isInScope(scope, url)) return null;
  if (!scope.enabled) return "scope is disabled; enable it and add an in-scope target first";
  const target = parseTarget(url);
  if (!target) return "not a valid http(s) URL";
  if (scope.exclude.some((e) => entryMatches(e, target))) return `host ${target.host} is explicitly excluded from scope`;
  return `host ${target.host} is not in the allowlist; add it to scope to act on it`;
}

export function scopeEntry(host: string, opts: Partial<Omit<ScopeEntry, "host">> = {}): ScopeEntry {
  return {
    host,
    enabled: opts.enabled ?? true,
    ...(opts.pathPrefix !== undefined ? { pathPrefix: opts.pathPrefix } : {}),
    ...(opts.port !== undefined ? { port: opts.port } : {}),
  };
}
