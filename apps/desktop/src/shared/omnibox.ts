import type { OmniboxIntent } from "@corvus/shared";
import { KNOWN_TLDS } from "./tlds";

/** Schemes the omnibox navigates to directly when typed explicitly. */
const NAVIGABLE_SCHEMES = new Set([
  "http",
  "https",
  "file",
  "ftp",
  "corvus",
  "about",
  "data",
  "chrome",
  "chrome-extension",
  "view-source",
  "mailto",
]);

const SCHEME_RE = /^([a-z][a-z0-9+.-]*):/i;
const LABEL_RE = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/i;
const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const WINDOWS_PATH_RE = /^[a-z]:[\\/]/i;

export const SEARCH_PAGE = "corvus://search";

export function searchUrl(query: string): string {
  return `${SEARCH_PAGE}?q=${encodeURIComponent(query)}`;
}

/** Returns the query of a corvus://search URL, or null if the URL is not a search page. */
export function searchQueryOf(url: string): string | null {
  if (!url.startsWith(`${SEARCH_PAGE}`)) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "corvus:" || parsed.hostname !== "search") return null;
    return parsed.searchParams.get("q") ?? "";
  } catch {
    return null;
  }
}

function isIPv4(host: string): boolean {
  const m = IPV4_RE.exec(host);
  return m !== null && m.slice(1).every((octet) => Number(octet) <= 255);
}

function isValidPort(port: string): boolean {
  if (!/^\d{1,5}$/.test(port)) return false;
  const n = Number(port);
  return n > 0 && n <= 65535;
}

/**
 * Splits "host[:port][/path?query#hash]" into host and port. Supports bracketed IPv6.
 * Returns null when the authority part is malformed.
 */
function splitAuthority(input: string): { host: string; port?: string; rest: string } | null {
  const restIdx = input.search(/[/?#]/);
  const authority = restIdx === -1 ? input : input.slice(0, restIdx);
  const rest = restIdx === -1 ? "" : input.slice(restIdx);
  if (authority.length === 0) return null;

  if (authority.startsWith("[")) {
    const close = authority.indexOf("]");
    if (close === -1) return null;
    const host = authority.slice(0, close + 1);
    const after = authority.slice(close + 1);
    if (after === "") return { host, rest };
    if (!after.startsWith(":") || !isValidPort(after.slice(1))) return null;
    return { host, port: after.slice(1), rest };
  }

  const parts = authority.split(":");
  if (parts.length > 2) return null;
  const host = parts[0] ?? "";
  if (parts.length === 2) {
    const port = parts[1] ?? "";
    if (!isValidPort(port)) return null;
    return { host, port, rest };
  }
  return { host, rest };
}

function isIPv6Literal(host: string): boolean {
  if (!host.startsWith("[") || !host.endsWith("]")) return false;
  try {
    new URL(`http://${host}/`);
    return true;
  } catch {
    return false;
  }
}

type HostKind = "localhost" | "ip" | "domain" | "single-label" | "invalid";

function classifyHost(rawHost: string): HostKind {
  const host = rawHost.toLowerCase().replace(/\.$/, "");
  if (host === "localhost" || host.endsWith(".localhost")) return "localhost";
  if (isIPv4(host) || isIPv6Literal(host)) return "ip";
  const labels = host.split(".");
  if (!labels.every((l) => LABEL_RE.test(l))) return "invalid";
  if (labels.length === 1) return "single-label";
  const tld = labels[labels.length - 1] ?? "";
  if (/^\d+$/.test(tld)) return "invalid";
  if (KNOWN_TLDS.has(tld) || /^xn--[a-z0-9-]+$/.test(tld)) return "domain";
  return "invalid";
}

/**
 * Decide whether omnibox input is a URL to navigate to or a query to search for.
 *
 * Rules, in order:
 * - leading "?" forces a search
 * - explicit navigable scheme (http:, https:, corvus:, about:, file:, ...) -> URL as typed
 * - Windows drive paths -> file:// URL
 * - whitespace anywhere -> search
 * - "user@host" without scheme -> search (looks like an e-mail address)
 * - host[:port][/path]: localhost / IPv4 / [IPv6] -> http://, domain with known TLD -> https://,
 *   single label followed by "/" or a port -> http:// (intranet hosts)
 * - everything else -> search
 */
export function classifyOmnibox(rawInput: string): OmniboxIntent {
  const input = rawInput.trim();
  if (input.length === 0) return { kind: "search", query: "" };
  if (input.startsWith("?")) return { kind: "search", query: input.slice(1).trim() };

  const schemeMatch = SCHEME_RE.exec(input);
  if (schemeMatch) {
    const scheme = (schemeMatch[1] ?? "").toLowerCase();
    if (NAVIGABLE_SCHEMES.has(scheme) && !/\s/.test(input)) {
      const rest = input.slice(scheme.length + 1);
      if ((scheme === "http" || scheme === "https") && !rest.startsWith("//")) {
        return { kind: "url", url: `${scheme}://${rest}` };
      }
      if (scheme === "corvus" && !rest.startsWith("//")) {
        return { kind: "url", url: `corvus://${rest}` };
      }
      return { kind: "url", url: `${scheme}:${rest}` };
    }
  }

  if (WINDOWS_PATH_RE.test(input) && !/[\n\t]/.test(input)) {
    return { kind: "url", url: `file:///${input.replace(/\\/g, "/").split("/").map(encodeURI).join("/")}` };
  }

  if (/\s/.test(input)) return { kind: "search", query: input };
  if (input.includes("@") && !input.includes("/")) return { kind: "search", query: input };

  const authority = splitAuthority(input);
  if (!authority) return { kind: "search", query: input };
  const { host, port, rest } = authority;
  const kind = classifyHost(host);
  const portPart = port ? `:${port}` : "";

  switch (kind) {
    case "localhost":
    case "ip":
      return { kind: "url", url: `http://${host.toLowerCase()}${portPart}${rest || "/"}` };
    case "domain":
      return { kind: "url", url: `https://${host.toLowerCase()}${portPart}${rest || "/"}` };
    case "single-label":
      if (port || rest.startsWith("/")) {
        return { kind: "url", url: `http://${host.toLowerCase()}${portPart}${rest || "/"}` };
      }
      return { kind: "search", query: input };
    default:
      return { kind: "search", query: input };
  }
}

/** URL to load for an intent. */
export function intentToUrl(intent: OmniboxIntent): string {
  return intent.kind === "url" ? intent.url : searchUrl(intent.query);
}

/** Human-friendly URL for display in the omnibox when it is not focused. */
export function displayUrl(url: string): string {
  if (url === "corvus://newtab/" || url === "corvus://newtab" || url === "about:blank") return "";
  const query = searchQueryOf(url);
  if (query !== null) return query;
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "https:" || parsed.protocol === "http:") {
      const host = parsed.host.replace(/^www\./, "");
      const tail = `${parsed.pathname === "/" ? "" : parsed.pathname}${parsed.search}${parsed.hash}`;
      return `${host}${tail}`;
    }
  } catch {
    // fall through to the raw URL
  }
  return url;
}
