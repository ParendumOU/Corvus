/**
 * Connections: the proxies a profile keeps, which one the profile and each of its containers go
 * through, and per-site rules ("*.example.com goes direct"). Turned into Chromium's proxy settings
 * here, so the rules are unit tested. A proxy never falls back to a direct connection: when it is
 * down, pages fail instead of leaving through the person's own address.
 */

export type ProxyKind = "http" | "https" | "socks4" | "socks5" | "pac";
export const PROXY_KINDS: readonly ProxyKind[] = ["http", "https", "socks5", "socks4", "pac"];

export interface ProxyServer {
  id: string;
  name: string;
  kind: ProxyKind;
  host: string;
  port: number;
  /** "pac": the address of the PAC script. */
  pacUrl?: string;
  username?: string;
  /** A password is saved (it never leaves the main process). */
  hasPassword: boolean;
}

/** How a profile or a container connects. */
export type ConnectionChoice = { mode: "system" } | { mode: "direct" } | { mode: "proxy"; proxyId: string };

/** "Sites matching `pattern` go through `via`" ("direct" or a proxy id). */
export interface SiteRule {
  pattern: string;
  via: string;
}

export interface ConnectionsConfig {
  proxies: ProxyServer[];
  profile: ConnectionChoice;
  /** By container id; a container without one connects like its profile. */
  containers: Record<string, ConnectionChoice>;
  rules: SiteRule[];
  /** WebRTC only through the proxy (no direct UDP that would show the real address). */
  webrtcProtection: boolean;
}

export const DEFAULT_CONNECTIONS: ConnectionsConfig = { proxies: [], profile: { mode: "system" }, containers: {}, rules: [], webrtcProtection: true };

/** Chromium's proxy settings (Electron's ProxyConfig subset Corvus uses). */
export type ChromiumProxy =
  | { mode: "system" }
  | { mode: "direct" }
  | { mode: "fixed_servers"; proxyRules: string; proxyBypassRules: string }
  | { mode: "pac_script"; pacScript: string };

/** Never through a proxy: the machine itself. */
const LOCAL_BYPASS = "<local>;localhost;127.0.0.1;[::1]";

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/** "socks5://host:1080" for Chromium's proxy rules. */
export function proxyRule(p: ProxyServer): string {
  return `${p.kind}://${formatHost(p.host)}:${p.port}`;
}

const formatHost = (host: string): string => (host.includes(":") && !host.startsWith("[") ? `[${host}]` : host);

/** The PAC result for a proxy ("SOCKS5 host:port"). */
export function pacTarget(p: ProxyServer): string {
  const where = `${formatHost(p.host)}:${p.port}`;
  switch (p.kind) {
    case "http":
      return `PROXY ${where}`;
    case "https":
      return `HTTPS ${where}`;
    case "socks4":
      return `SOCKS ${where}`;
    case "socks5":
      return `SOCKS5 ${where}`;
    case "pac":
      // A PAC proxy cannot be a target inside another PAC script.
      return "DIRECT";
  }
}

/** A site pattern a rule accepts: a host, "*.host", or "*" alone is not allowed. */
export function cleanPattern(raw: string): string | null {
  let p = raw.trim().toLowerCase();
  p = p.replace(/^[a-z]+:\/\//, "").replace(/\/.*$/, "").replace(/:\d+$/, "");
  if (!/^(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)*$/.test(p) && !/^\d{1,3}(\.\d{1,3}){3}$/.test(p)) return null;
  return p;
}

/** Whether a host matches a rule pattern ("*.example.com" also matches example.com). */
export function matchesPattern(host: string, pattern: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  if (pattern.startsWith("*.")) {
    const base = pattern.slice(2);
    return h === base || h.endsWith(`.${base}`);
  }
  return h === pattern;
}

/** The connection a request to `host` takes under a choice and the site rules (the first rule that matches wins). */
export function routeFor(host: string, choice: ConnectionChoice, rules: readonly SiteRule[]): ConnectionChoice {
  const rule = rules.find((r) => matchesPattern(host, r.pattern));
  if (!rule) return choice;
  return rule.via === "direct" ? { mode: "direct" } : { mode: "proxy", proxyId: rule.via };
}

const jsString = (s: string): string => JSON.stringify(s);

/**
 * A PAC script for site rules on top of a default route. Proxies that are missing (deleted) make
 * their sites fail rather than go direct.
 */
export function pacScript(choice: ConnectionChoice, rules: readonly SiteRule[], proxies: readonly ProxyServer[]): string {
  const target = (c: ConnectionChoice): string => {
    if (c.mode === "proxy") {
      const p = proxies.find((x) => x.id === c.proxyId);
      // An address nothing listens on: the request fails instead of leaking.
      return p ? pacTarget(p) : "PROXY 127.0.0.1:9";
    }
    return "DIRECT";
  };
  const lines = [
    "function FindProxyForURL(url, host) {",
    "  host = host.toLowerCase();",
    '  if (isPlainHostName(host) || host === "localhost" || host === "127.0.0.1" || host === "[::1]") return "DIRECT";',
  ];
  for (const r of rules) {
    const via = target(r.via === "direct" ? { mode: "direct" } : { mode: "proxy", proxyId: r.via });
    const cond = r.pattern.startsWith("*.")
      ? `host === ${jsString(r.pattern.slice(2))} || dnsDomainIs(host, ${jsString(r.pattern.slice(1))})`
      : `host === ${jsString(r.pattern)}`;
    lines.push(`  if (${cond}) return ${jsString(via)};`);
  }
  lines.push(`  return ${jsString(target(choice))};`, "}");
  return lines.join("\n");
}

/**
 * Chromium's proxy settings for a profile or container: its own choice, with the site rules on
 * top (as a PAC script). "system" with rules uses the PAC too, its default going direct.
 */
export function chromiumProxy(choice: ConnectionChoice, config: Pick<ConnectionsConfig, "proxies" | "rules">): ChromiumProxy {
  const proxy = choice.mode === "proxy" ? config.proxies.find((p) => p.id === choice.proxyId) : undefined;
  if (config.rules.length > 0 && proxy?.kind !== "pac") {
    const base: ConnectionChoice = choice.mode === "system" ? { mode: "direct" } : choice;
    return { mode: "pac_script", pacScript: `data:application/x-ns-proxy-autoconfig;base64,${toBase64(pacScript(base, config.rules, config.proxies))}` };
  }
  if (choice.mode === "system") return { mode: "system" };
  if (choice.mode === "direct") return { mode: "direct" };
  // A deleted proxy: nothing goes out rather than everything going direct.
  if (!proxy) return { mode: "fixed_servers", proxyRules: "http://127.0.0.1:9", proxyBypassRules: LOCAL_BYPASS };
  if (proxy.kind === "pac") return { mode: "pac_script", pacScript: proxy.pacUrl ?? "" };
  return { mode: "fixed_servers", proxyRules: proxyRule(proxy), proxyBypassRules: LOCAL_BYPASS };
}

function toBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** Whether a choice sends traffic through a proxy (for WebRTC protection and the toolbar). */
export function isProxied(choice: ConnectionChoice, config: Pick<ConnectionsConfig, "proxies">): boolean {
  return choice.mode === "proxy" && config.proxies.some((p) => p.id === choice.proxyId);
}

/** The choice of a container (its own, else the profile's). */
export function containerChoice(config: Pick<ConnectionsConfig, "profile" | "containers">, containerId: string): ConnectionChoice {
  return config.containers[containerId] ?? config.profile;
}

/**
 * A proxy typed as an address: "socks5://user@host:1080", "http://host:3128", "host:8080"
 * (http), or a PAC address ("https://example.com/proxy.pac"). Null when it is not one.
 */
export function parseProxyAddress(raw: string): { kind: ProxyKind; host: string; port: number; username?: string; password?: string; pacUrl?: string } | null {
  const text = raw.trim();
  if (!text) return null;
  if (/^https?:\/\/.+\.pac(\?|$)/i.test(text)) return { kind: "pac", host: "", port: 0, pacUrl: text };
  const withScheme = /^[a-z0-9]+:\/\//i.test(text) ? text : `http://${text}`;
  let url: URL;
  try {
    url = new URL(withScheme.replace(/^socks:\/\//i, "socks5://"));
  } catch {
    return null;
  }
  const scheme = url.protocol.replace(/:$/, "").toLowerCase();
  const kind = (["http", "https", "socks4", "socks5"] as const).find((k) => k === scheme);
  if (!kind || !url.hostname) return null;
  const port = Number(url.port || (kind === "http" ? 80 : kind === "https" ? 443 : 1080));
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return {
    kind,
    host: url.hostname.replace(/^\[|\]$/g, ""),
    port,
    ...(url.username ? { username: decodeURIComponent(url.username) } : {}),
    ...(url.password ? { password: decodeURIComponent(url.password) } : {}),
  };
}

function reviveChoice(raw: unknown, proxyIds: ReadonlySet<string>): ConnectionChoice | null {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  if (o.mode === "system" || o.mode === "direct") return { mode: o.mode };
  if (o.mode === "proxy" && typeof o.proxyId === "string" && proxyIds.has(o.proxyId)) return { mode: "proxy", proxyId: o.proxyId };
  return null;
}

/** Loads saved connections, dropping what does not make sense (unknown proxies, bad rules). */
export function reviveConnections(raw: unknown): ConnectionsConfig {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const proxies: ProxyServer[] = (Array.isArray(o.proxies) ? o.proxies : []).flatMap((p): ProxyServer[] => {
    const x = p && typeof p === "object" ? (p as Record<string, unknown>) : {};
    const kind = PROXY_KINDS.find((k) => k === x.kind);
    const id = str(x.id);
    const port = typeof x.port === "number" ? x.port : 0;
    if (!kind || !id) return [];
    if (kind === "pac" ? !str(x.pacUrl) : !str(x.host) || port < 1 || port > 65535) return [];
    return [
      {
        id,
        name: str(x.name)?.slice(0, 60) || (kind === "pac" ? "PAC" : `${str(x.host)}:${port}`),
        kind,
        host: str(x.host) ?? "",
        port,
        ...(str(x.pacUrl) ? { pacUrl: str(x.pacUrl)! } : {}),
        ...(str(x.username) ? { username: str(x.username)! } : {}),
        hasPassword: x.hasPassword === true,
      },
    ];
  });
  const ids = new Set(proxies.map((p) => p.id));
  const containers: Record<string, ConnectionChoice> = {};
  for (const [id, c] of Object.entries(o.containers && typeof o.containers === "object" ? (o.containers as Record<string, unknown>) : {})) {
    const choice = reviveChoice(c, ids);
    if (choice) containers[id] = choice;
  }
  const rules = (Array.isArray(o.rules) ? o.rules : []).flatMap((r): SiteRule[] => {
    const x = r && typeof r === "object" ? (r as Record<string, unknown>) : {};
    const pattern = cleanPattern(str(x.pattern) ?? "");
    const via = str(x.via);
    return pattern && via && (via === "direct" || ids.has(via)) ? [{ pattern, via }] : [];
  });
  return {
    proxies,
    profile: reviveChoice(o.profile, ids) ?? { mode: "system" },
    containers,
    rules,
    webrtcProtection: o.webrtcProtection !== false,
  };
}

/** What the Cloudflare trace endpoint says about a connection (ip=, loc=). */
export function parseTrace(text: string): { ip: string; country?: string } | null {
  const ip = /^ip=(.+)$/m.exec(text)?.[1]?.trim();
  const loc = /^loc=([A-Z]{2})$/m.exec(text)?.[1];
  return ip ? { ip, ...(loc ? { country: loc } : {}) } : null;
}
