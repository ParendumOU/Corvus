/**
 * The browser's address bar: whether what was typed is a web address or a search, the search
 * engines it can search with, and how a page's address is shown. Pure, so it is tested as is. The
 * rules follow the desktop omnibox (apps/desktop/src/shared/omnibox.ts), for web pages only.
 */
import { KNOWN_TLDS } from '@corvus/shared';

export type AddressIntent = { kind: 'url'; url: string } | { kind: 'search'; query: string };

const LABEL_RE = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/i;
const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function isIPv4(host: string): boolean {
  const m = IPV4_RE.exec(host);
  return m !== null && m.slice(1).every((octet) => Number(octet) <= 255);
}

function isValidPort(port: string): boolean {
  return /^\d{1,5}$/.test(port) && Number(port) > 0 && Number(port) <= 65535;
}

/** "host[:port][/path?query#hash]" split into host, port and the rest; null when malformed. */
function splitAuthority(input: string): { host: string; port?: string; rest: string } | null {
  const restIdx = input.search(/[/?#]/);
  const authority = restIdx === -1 ? input : input.slice(0, restIdx);
  const rest = restIdx === -1 ? '' : input.slice(restIdx);
  if (authority.length === 0) return null;
  if (authority.startsWith('[')) {
    const close = authority.indexOf(']');
    if (close === -1) return null;
    const host = authority.slice(0, close + 1);
    const after = authority.slice(close + 1);
    if (after === '') return { host, rest };
    if (!after.startsWith(':') || !isValidPort(after.slice(1))) return null;
    return { host, port: after.slice(1), rest };
  }
  const parts = authority.split(':');
  if (parts.length > 2) return null;
  const host = parts[0] ?? '';
  if (parts.length === 2) {
    const port = parts[1] ?? '';
    return isValidPort(port) ? { host, port, rest } : null;
  }
  return { host, rest };
}

type HostKind = 'local' | 'domain' | 'single-label' | 'invalid';

function classifyHost(rawHost: string): HostKind {
  const host = rawHost.toLowerCase().replace(/\.$/, '');
  if (host === 'localhost' || host.endsWith('.localhost') || isIPv4(host)) return 'local';
  if (host.startsWith('[') && host.endsWith(']')) {
    try {
      new URL(`http://${host}/`);
      return 'local';
    } catch {
      return 'invalid';
    }
  }
  const labels = host.split('.');
  if (!labels.every((l) => LABEL_RE.test(l))) return 'invalid';
  if (labels.length === 1) return 'single-label';
  const tld = labels[labels.length - 1] ?? '';
  if (/^\d+$/.test(tld)) return 'invalid';
  return KNOWN_TLDS.has(tld) || /^xn--[a-z0-9-]+$/.test(tld) ? 'domain' : 'invalid';
}

/**
 * What typed text is. A leading "?" searches; "http://" or "https://" goes as typed; anything with
 * a space, or an e-mail address, searches; a domain with a known top-level domain gets https://,
 * localhost and IP addresses http://, and a single word with a port or a path (an intranet host)
 * http://. Everything else (other schemes included) is a search: the address bar opens web pages only.
 */
export function classifyAddress(rawInput: string): AddressIntent {
  const input = rawInput.trim();
  if (input === '') return { kind: 'search', query: '' };
  if (input.startsWith('?')) return { kind: 'search', query: input.slice(1).trim() };
  const scheme = /^(https?):(.*)$/is.exec(input);
  if (scheme && !/\s/.test(input)) {
    const rest = scheme[2]!.replace(/^\/*/, '');
    const url = `${scheme[1]!.toLowerCase()}://${rest}`;
    try {
      if (new URL(url).hostname) return { kind: 'url', url };
    } catch {
      // Not an address after all: search for it.
    }
    return { kind: 'search', query: input };
  }
  if (/\s/.test(input)) return { kind: 'search', query: input };
  if (input.includes('@') && !input.includes('/')) return { kind: 'search', query: input };
  // Other schemes ("mailto:x", "javascript:…") never load from the address bar; "host:8080" does.
  if (/^[a-z][a-z0-9+.-]*:(?!\d)/i.test(input)) return { kind: 'search', query: input };
  const authority = splitAuthority(input);
  if (!authority) return { kind: 'search', query: input };
  const { host, port, rest } = authority;
  const portPart = port ? `:${port}` : '';
  switch (classifyHost(host)) {
    case 'local':
      return { kind: 'url', url: `http://${host.toLowerCase()}${portPart}${rest || '/'}` };
    case 'domain':
      return { kind: 'url', url: `https://${host.toLowerCase()}${portPart}${rest || '/'}` };
    case 'single-label':
      return port || rest.startsWith('/') ? { kind: 'url', url: `http://${host.toLowerCase()}${portPart}${rest || '/'}` } : { kind: 'search', query: input };
    default:
      return { kind: 'search', query: input };
  }
}

export type SearchEngineId = 'duckduckgo' | 'brave' | 'google' | 'startpage';

export interface SearchEngine {
  id: SearchEngineId;
  name: string;
  /** The results page for a query. */
  search: (query: string) => string;
  /** Its own pages, where the address bar shows the query instead of the address. */
  host: RegExp;
  queryParam: string;
}

export const SEARCH_ENGINES: readonly SearchEngine[] = [
  { id: 'duckduckgo', name: 'DuckDuckGo', search: (q) => `https://duckduckgo.com/?q=${encodeURIComponent(q)}`, host: /^(www\.)?duckduckgo\.com$/, queryParam: 'q' },
  { id: 'brave', name: 'Brave Search', search: (q) => `https://search.brave.com/search?q=${encodeURIComponent(q)}`, host: /^search\.brave\.com$/, queryParam: 'q' },
  { id: 'google', name: 'Google', search: (q) => `https://www.google.com/search?q=${encodeURIComponent(q)}`, host: /^(www\.)?google\.[a-z.]+$/, queryParam: 'q' },
  { id: 'startpage', name: 'Startpage', search: (q) => `https://www.startpage.com/do/search?query=${encodeURIComponent(q)}`, host: /^(www\.)?startpage\.com$/, queryParam: 'query' },
];

export const DEFAULT_ENGINE: SearchEngineId = 'duckduckgo';

export function engineById(id: string | null | undefined): SearchEngine {
  return SEARCH_ENGINES.find((e) => e.id === id) ?? SEARCH_ENGINES[0]!;
}

/**
 * The engine to search with: the one picked on the phone, else the one the computers use as their
 * home page (the desktop's synced `appearance.homePage`) when the phone offers it, else DuckDuckGo.
 */
export function pickEngine(chosen: string | null, desktopHomePage: unknown): SearchEngineId {
  if (chosen && SEARCH_ENGINES.some((e) => e.id === chosen)) return chosen as SearchEngineId;
  if (typeof desktopHomePage === 'string' && SEARCH_ENGINES.some((e) => e.id === desktopHomePage)) return desktopHomePage as SearchEngineId;
  return DEFAULT_ENGINE;
}

/** The page to load for typed text: the address, or the engine's results. Null for empty text. */
export function addressTarget(input: string, engine: SearchEngine): string | null {
  const intent = classifyAddress(input);
  if (intent.kind === 'url') return intent.url;
  return intent.query ? engine.search(intent.query) : null;
}

/** The query of a search engine's results page, or null for any other page. */
export function searchQueryOf(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return null;
    for (const engine of SEARCH_ENGINES) {
      if (engine.host.test(parsed.hostname)) {
        const q = parsed.searchParams.get(engine.queryParam);
        if (q) return q;
      }
    }
  } catch {
    // Not an address.
  }
  return null;
}

/**
 * How the address bar shows a page while it is not being edited: the search for a results page,
 * else the host without "www." (the path is left for editing, as mobile browsers do).
 */
export function displayAddress(url: string): string {
  if (url === '' || url === 'about:blank') return '';
  const query = searchQueryOf(url);
  if (query !== null) return query;
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'https:' || parsed.protocol === 'http:') return parsed.host.replace(/^www\./, '');
  } catch {
    // Show it as it is.
  }
  return url;
}

/** Whether a page is a web page the browser loads and records (http or https). */
export function isWebPage(url: string): boolean {
  return /^https?:\/\/[^\s/?#]+/i.test(url);
}

/** Whether the connection to a page is encrypted (https). */
export function isSecure(url: string): boolean {
  return /^https:\/\//i.test(url);
}
