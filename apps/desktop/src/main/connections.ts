import crypto from "node:crypto";
import path from "node:path";
import { net, session as electronSession, type Session } from "electron";
import {
  chromiumProxy,
  cleanPattern,
  isProxied,
  parseTrace,
  proxyRule,
  reviveConnections,
  type ConnectionChoice,
  type ConnectionsConfig,
  type ProxyServer,
} from "../shared/connections";
import { JsonFile } from "./json-file";
import type { SecretCipher } from "./settings-store";

interface StoredConnections extends ConnectionsConfig {
  /** Proxy passwords by proxy id, encrypted with the OS keychain. */
  secrets: Record<string, string>;
}

/** Where "Check connection" asks which address the sites see (only when the person asks). */
const TRACE_URL = "https://www.cloudflare.com/cdn-cgi/trace";

/** A new proxy, or changes to one (password: a new one, "" to forget it, absent to keep it). */
export interface ProxyInput {
  name: string;
  kind: ProxyServer["kind"];
  host: string;
  port: number;
  pacUrl?: string;
  username?: string;
  password?: string;
}

/**
 * A profile's connections (connections.json): its proxies, which one the profile and each container
 * use, and site rules. Passwords are encrypted with the OS keychain; without one they are kept for
 * this session only.
 */
export class ConnectionStore {
  private readonly file: JsonFile<StoredConnections>;
  private readonly listeners = new Set<() => void>();
  /** Passwords kept in memory when the keychain is unavailable. */
  private readonly memory = new Map<string, string>();

  constructor(
    dir: string,
    private readonly cipher: SecretCipher,
  ) {
    this.file = JsonFile.load(
      path.join(dir, "connections.json"),
      () => ({ ...reviveConnections(null), secrets: {} }),
      (raw) => {
        const config = reviveConnections(raw);
        const stored = (raw as { secrets?: unknown } | null)?.secrets;
        const secrets: Record<string, string> = {};
        if (stored && typeof stored === "object") {
          for (const [id, v] of Object.entries(stored as Record<string, unknown>)) if (typeof v === "string" && config.proxies.some((p) => p.id === id)) secrets[id] = v;
        }
        return { ...config, proxies: config.proxies.map((p) => ({ ...p, hasPassword: p.id in secrets })), secrets };
      },
      0,
    );
  }

  /** The configuration without passwords (safe to show in a page). */
  config(): ConnectionsConfig {
    const { secrets: _secrets, ...config } = this.file.get();
    return { ...config, proxies: config.proxies.map((p) => ({ ...p, hasPassword: p.hasPassword || this.memory.has(p.id) })) };
  }

  password(proxyId: string): string | null {
    const memo = this.memory.get(proxyId);
    if (memo !== undefined) return memo;
    const enc = this.file.get().secrets[proxyId];
    if (!enc || !this.cipher.isEncryptionAvailable()) return null;
    try {
      return this.cipher.decryptString(Buffer.from(enc, "base64"));
    } catch {
      return null;
    }
  }

  /** Adds a proxy (or updates the one with `id`); returns it. */
  saveProxy(input: ProxyInput, id?: string): ProxyServer {
    const name = input.name.trim().slice(0, 60);
    const pac = input.kind === "pac";
    if (pac ? !/^https?:\/\//i.test(input.pacUrl ?? "") : !input.host.trim() || !Number.isInteger(input.port) || input.port < 1 || input.port > 65535) {
      throw new Error(pac ? "A PAC proxy needs the address of its script." : "A proxy needs a host and a port (1-65535).");
    }
    const proxyId = id ?? crypto.randomUUID();
    const existing = this.file.get().proxies.find((p) => p.id === proxyId);
    if (id && !existing) throw new Error("No such proxy");
    const proxy: ProxyServer = {
      id: proxyId,
      name: name || (pac ? "PAC" : `${input.host.trim()}:${input.port}`),
      kind: input.kind,
      host: pac ? "" : input.host.trim(),
      port: pac ? 0 : input.port,
      ...(pac ? { pacUrl: input.pacUrl!.trim() } : {}),
      ...(!pac && input.username?.trim() ? { username: input.username.trim() } : {}),
      hasPassword: existing?.hasPassword ?? false,
    };
    this.file.update((f) => {
      const secrets = { ...f.secrets };
      let hasPassword = proxy.hasPassword;
      if (input.password !== undefined) {
        delete secrets[proxyId];
        this.memory.delete(proxyId);
        hasPassword = false;
        if (input.password !== "") {
          if (this.cipher.isEncryptionAvailable()) secrets[proxyId] = this.cipher.encryptString(input.password).toString("base64");
          else this.memory.set(proxyId, input.password);
          hasPassword = true;
        }
      }
      const saved = { ...proxy, hasPassword };
      const proxies = existing ? f.proxies.map((p) => (p.id === proxyId ? saved : p)) : [...f.proxies, saved];
      return { ...f, proxies, secrets };
    });
    this.emit();
    return this.config().proxies.find((p) => p.id === proxyId)!;
  }

  /** Forgets a proxy that nothing uses (the profile, a container, a site rule must switch first). */
  removeProxy(id: string): void {
    const f = this.file.get();
    const used = (c: ConnectionChoice): boolean => c.mode === "proxy" && c.proxyId === id;
    if (used(f.profile) || Object.values(f.containers).some(used) || f.rules.some((r) => r.via === id)) {
      throw new Error("This proxy is in use: give the profile, its containers and site rules another connection first.");
    }
    this.memory.delete(id);
    this.file.update((f) => {
      const { [id]: _gone, ...secrets } = f.secrets;
      return { ...f, proxies: f.proxies.filter((p) => p.id !== id), secrets };
    });
    this.emit();
  }

  setProfileChoice(choice: ConnectionChoice): void {
    this.check(choice);
    this.file.update((f) => ({ ...f, profile: choice }));
    this.emit();
  }

  /** A container's own choice; null makes it follow the profile. */
  setContainerChoice(containerId: string, choice: ConnectionChoice | null): void {
    if (choice) this.check(choice);
    this.file.update((f) => {
      const containers = { ...f.containers };
      if (choice) containers[containerId] = choice;
      else delete containers[containerId];
      return { ...f, containers };
    });
    this.emit();
  }

  /** Replaces the site rules (each pattern cleaned; unknown targets refused). */
  setRules(rules: ReadonlyArray<{ pattern: string; via: string }>): void {
    const ids = new Set(this.file.get().proxies.map((p) => p.id));
    const clean = rules.map((r) => {
      const pattern = cleanPattern(r.pattern);
      if (!pattern) throw new Error(`Not a site: ${r.pattern}`);
      if (r.via !== "direct" && !ids.has(r.via)) throw new Error("No such proxy");
      return { pattern, via: r.via };
    });
    this.file.update((f) => ({ ...f, rules: clean.slice(0, 200) }));
    this.emit();
  }

  setWebrtcProtection(on: boolean): void {
    this.file.update((f) => ({ ...f, webrtcProtection: on }));
    this.emit();
  }

  /** The proxy of this profile at `host:port` (for a proxy's sign-in). */
  proxyAt(host: string, port: number): ProxyServer | undefined {
    const h = host.replace(/^\[|\]$/g, "").toLowerCase();
    return this.file.get().proxies.find((p) => p.kind !== "pac" && p.host.toLowerCase() === h && p.port === port);
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  flush(): void {
    this.file.flush();
  }

  private check(choice: ConnectionChoice): void {
    if (choice.mode === "proxy" && !this.file.get().proxies.some((p) => p.id === choice.proxyId)) throw new Error("No such proxy");
  }

  private emit(): void {
    for (const l of this.listeners) l();
  }
}

/** Applies a profile's (or container's) connection to its session; resolves once Chromium uses it. */
export async function applyConnection(session: Session, choice: ConnectionChoice, config: ConnectionsConfig): Promise<void> {
  await session.setProxy(chromiumProxy(choice, config));
  // Connections opened before keep their old route otherwise.
  await session.closeAllConnections().catch(() => undefined);
}

/** The WebRTC policy for a session's pages: through the proxy only, when it has one and the protection is on. */
export function webrtcPolicy(choice: ConnectionChoice, config: ConnectionsConfig): "default" | "disable_non_proxied_udp" {
  return config.webrtcProtection && isProxied(choice, config) ? "disable_non_proxied_udp" : "default";
}

/**
 * The address sites see through a session (Cloudflare's trace page), or why it failed. A proxy's
 * sign-in comes from `credentials`.
 */
export function checkConnection(session: Session, credentials: (host: string, port: number) => { username: string; password: string } | null): Promise<{ ip: string; country?: string } | { error: string }> {
  return new Promise((resolve) => {
    const req = net.request({ url: TRACE_URL, session, useSessionCookies: false });
    const timer = setTimeout(() => {
      req.abort();
      resolve({ error: "No answer in 15 seconds" });
    }, 15_000);
    req.on("login", (authInfo, callback) => {
      const found = authInfo.isProxy ? credentials(authInfo.host, authInfo.port) : null;
      if (found) callback(found.username, found.password);
      else callback();
    });
    req.on("response", (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        clearTimeout(timer);
        const trace = parseTrace(Buffer.concat(chunks).toString("utf8"));
        resolve(trace ?? { error: `Unexpected answer (${res.statusCode})` });
      });
    });
    req.on("error", (err) => {
      clearTimeout(timer);
      resolve({ error: err.message.replace(/^net::/, "") });
    });
    req.end();
  });
}

/** A temporary session that goes through one proxy, to test it before using it. */
export async function testProxy(proxy: ProxyServer, password: string | null, partition: string): Promise<{ ip: string; country?: string } | { error: string }> {
  const ses = electronSession.fromPartition(partition, { cache: false });
  await ses.setProxy(proxy.kind === "pac" ? { mode: "pac_script", pacScript: proxy.pacUrl ?? "" } : { mode: "fixed_servers", proxyRules: proxyRule(proxy) });
  await ses.closeAllConnections().catch(() => undefined);
  return checkConnection(ses, () => (proxy.username ? { username: proxy.username, password: password ?? "" } : null));
}
