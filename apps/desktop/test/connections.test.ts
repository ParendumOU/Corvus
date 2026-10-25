import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConnectionStore, webrtcPolicy } from "../src/main/connections";
import {
  chromiumProxy,
  cleanPattern,
  containerChoice,
  matchesPattern,
  pacScript,
  parseProxyAddress,
  parseTrace,
  reviveConnections,
  routeFor,
  type ConnectionsConfig,
  type ProxyServer,
} from "../src/shared/connections";

const socks: ProxyServer = { id: "s", name: "Home SOCKS", kind: "socks5", host: "10.0.0.2", port: 1080, hasPassword: false };
const http: ProxyServer = { id: "h", name: "Office", kind: "http", host: "proxy.office.example", port: 3128, username: "me", hasPassword: true };
const config = (patch: Partial<ConnectionsConfig> = {}): ConnectionsConfig => ({ proxies: [socks, http], profile: { mode: "system" }, containers: {}, rules: [], webrtcProtection: true, ...patch });

/** Runs a generated PAC script the way Chromium would, for one address. */
function runPac(script: string, url: string): string {
  const host = new URL(url).hostname;
  const env = {
    isPlainHostName: (h: string) => !h.includes("."),
    dnsDomainIs: (h: string, d: string) => h.endsWith(d),
  };
  const find = new Function("isPlainHostName", "dnsDomainIs", `${script}; return FindProxyForURL;`)(env.isPlainHostName, env.dnsDomainIs) as (u: string, h: string) => string;
  return find(url, host);
}

const pacOf = (data: string): string => Buffer.from(data.replace(/^data:[^,]*;base64,/, ""), "base64").toString("utf8");

describe("connections: Chromium's proxy settings", () => {
  it("system, direct, or a fixed proxy that never falls back to direct", () => {
    expect(chromiumProxy({ mode: "system" }, config())).toEqual({ mode: "system" });
    expect(chromiumProxy({ mode: "direct" }, config())).toEqual({ mode: "direct" });
    expect(chromiumProxy({ mode: "proxy", proxyId: "s" }, config())).toEqual({ mode: "fixed_servers", proxyRules: "socks5://10.0.0.2:1080", proxyBypassRules: "<local>;localhost;127.0.0.1;[::1]" });
    expect(chromiumProxy({ mode: "proxy", proxyId: "h" }, config())).toMatchObject({ proxyRules: "http://proxy.office.example:3128" });
    // A proxy that was removed: nothing goes out, rather than everything going direct.
    expect(chromiumProxy({ mode: "proxy", proxyId: "gone" }, config())).toMatchObject({ mode: "fixed_servers", proxyRules: "http://127.0.0.1:9" });
    const pac: ProxyServer = { id: "p", name: "Work PAC", kind: "pac", host: "", port: 0, pacUrl: "https://wpad.example/proxy.pac", hasPassword: false };
    expect(chromiumProxy({ mode: "proxy", proxyId: "p" }, config({ proxies: [pac] }))).toEqual({ mode: "pac_script", pacScript: "https://wpad.example/proxy.pac" });
    expect(chromiumProxy({ mode: "proxy", proxyId: "x" }, config({ proxies: [{ ...socks, id: "x", host: "::1" }] }))).toMatchObject({ proxyRules: "socks5://[::1]:1080" });
  });

  it("site rules become a PAC script; the first matching rule wins", () => {
    const rules = [
      { pattern: "*.bank.example", via: "direct" },
      { pattern: "video.example", via: "h" },
      { pattern: "*.example", via: "gone" },
    ];
    const setting = chromiumProxy({ mode: "proxy", proxyId: "s" }, config({ rules }));
    expect(setting.mode).toBe("pac_script");
    const script = pacOf((setting as { pacScript: string }).pacScript);
    expect(runPac(script, "https://www.bank.example/login")).toBe("DIRECT");
    expect(runPac(script, "https://bank.example/")).toBe("DIRECT");
    expect(runPac(script, "https://video.example/x")).toBe("PROXY proxy.office.example:3128");
    expect(runPac(script, "https://shop.example/")).toBe("PROXY 127.0.0.1:9");
    expect(runPac(script, "https://news.other/")).toBe("SOCKS5 10.0.0.2:1080");
    expect(runPac(script, "http://localhost:8080/")).toBe("DIRECT");
    // "System" with rules: other sites go direct.
    expect(runPac(pacOf((chromiumProxy({ mode: "system" }, config({ rules: [{ pattern: "a.example", via: "s" }] })) as { pacScript: string }).pacScript), "https://b.example/")).toBe("DIRECT");
    expect(pacScript({ mode: "direct" }, [], [])).toContain('return "DIRECT";');
  });

  it("reads patterns, hosts and routes", () => {
    expect(cleanPattern(" https://*.Example.com/path ")).toBe("*.example.com");
    expect(cleanPattern("example.com:8443")).toBe("example.com");
    expect(cleanPattern("10.1.2.3")).toBe("10.1.2.3");
    expect(cleanPattern("*")).toBeNull();
    expect(cleanPattern("bad host")).toBeNull();
    expect(matchesPattern("a.b.example.com", "*.example.com")).toBe(true);
    expect(matchesPattern("example.com", "*.example.com")).toBe(true);
    expect(matchesPattern("notexample.com", "*.example.com")).toBe(false);
    expect(routeFor("x.example.com", { mode: "direct" }, [{ pattern: "*.example.com", via: "s" }])).toEqual({ mode: "proxy", proxyId: "s" });
    expect(containerChoice(config({ containers: { work: { mode: "direct" } } }), "work")).toEqual({ mode: "direct" });
    expect(containerChoice(config(), "other")).toEqual({ mode: "system" });
  });

  it("understands typed proxy addresses", () => {
    expect(parseProxyAddress("socks5://alice:p%40ss@10.0.0.2:1080")).toEqual({ kind: "socks5", host: "10.0.0.2", port: 1080, username: "alice", password: "p@ss" });
    expect(parseProxyAddress("proxy.example:3128")).toEqual({ kind: "http", host: "proxy.example", port: 3128 });
    expect(parseProxyAddress("socks://h.example")).toEqual({ kind: "socks5", host: "h.example", port: 1080 });
    expect(parseProxyAddress("https://wpad.example/proxy.pac")).toEqual({ kind: "pac", host: "", port: 0, pacUrl: "https://wpad.example/proxy.pac" });
    expect(parseProxyAddress("ftp://x:21")).toBeNull();
    expect(parseProxyAddress("host:99999")).toBeNull();
    expect(parseProxyAddress("")).toBeNull();
  });

  it("keeps only what makes sense when loading, and reads Cloudflare's trace", () => {
    const revived = reviveConnections({
      proxies: [socks, { id: "bad", kind: "socks5", host: "", port: 1080 }, { id: "p", kind: "pac" }],
      profile: { mode: "proxy", proxyId: "missing" },
      containers: { work: { mode: "proxy", proxyId: "s" }, old: { mode: "proxy", proxyId: "missing" } },
      rules: [{ pattern: "*.ok.example", via: "s" }, { pattern: "bad pattern", via: "s" }, { pattern: "x.example", via: "missing" }],
      webrtcProtection: false,
    });
    expect(revived.proxies.map((p) => p.id)).toEqual(["s"]);
    expect(revived.profile).toEqual({ mode: "system" });
    expect(revived.containers).toEqual({ work: { mode: "proxy", proxyId: "s" } });
    expect(revived.rules).toEqual([{ pattern: "*.ok.example", via: "s" }]);
    expect(revived.webrtcProtection).toBe(false);
    expect(parseTrace("fl=1\nh=www.cloudflare.com\nip=203.0.113.9\nloc=ES\n")).toEqual({ ip: "203.0.113.9", country: "ES" });
    expect(parseTrace("<html>")).toBeNull();
  });

  it("keeps WebRTC on the proxy only when the profile goes through one", () => {
    expect(webrtcPolicy({ mode: "proxy", proxyId: "s" }, config())).toBe("disable_non_proxied_udp");
    expect(webrtcPolicy({ mode: "proxy", proxyId: "s" }, config({ webrtcProtection: false }))).toBe("default");
    expect(webrtcPolicy({ mode: "direct" }, config())).toBe("default");
  });
});

describe("a profile's connection store", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "corvus-conn-"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  /** A keychain that only reverses the bytes, to see what is stored. */
  const cipher = (available = true) => ({
    isEncryptionAvailable: () => available,
    encryptString: (s: string) => Buffer.from([...Buffer.from(s, "utf8")].reverse()),
    decryptString: (b: Buffer) => Buffer.from([...b].reverse()).toString("utf8"),
  });

  it("saves proxies with their password encrypted, never shown", () => {
    const store = new ConnectionStore(dir, cipher());
    const p = store.saveProxy({ name: "", kind: "socks5", host: "10.0.0.2", port: 1080, username: "alice", password: "s3cret" });
    expect(p).toMatchObject({ name: "10.0.0.2:1080", username: "alice", hasPassword: true });
    expect(JSON.stringify(store.config())).not.toContain("s3cret");
    expect(store.password(p.id)).toBe("s3cret");
    store.flush();
    const saved = fs.readFileSync(path.join(dir, "connections.json"), "utf8");
    expect(saved).not.toContain("s3cret");
    // Reloaded, it still has its password; editing without one keeps it, "" forgets it.
    const again = new ConnectionStore(dir, cipher());
    expect(again.password(p.id)).toBe("s3cret");
    again.saveProxy({ name: "Home", kind: "socks5", host: "10.0.0.2", port: 1081, username: "alice" }, p.id);
    expect(again.password(p.id)).toBe("s3cret");
    expect(again.proxyAt("10.0.0.2", 1081)?.name).toBe("Home");
    again.saveProxy({ name: "Home", kind: "socks5", host: "10.0.0.2", port: 1081, password: "" }, p.id);
    expect(again.password(p.id)).toBeNull();
    expect(again.config().proxies[0]!.hasPassword).toBe(false);
  });

  it("without a keychain, keeps passwords in memory only", () => {
    const store = new ConnectionStore(dir, cipher(false));
    const p = store.saveProxy({ name: "x", kind: "http", host: "h.example", port: 8080, username: "u", password: "pw" });
    expect(store.password(p.id)).toBe("pw");
    store.flush();
    expect(new ConnectionStore(dir, cipher(false)).password(p.id)).toBeNull();
  });

  it("checks choices and rules, and removes a proxy only once nothing uses it", () => {
    const store = new ConnectionStore(dir, cipher());
    const changes: number[] = [];
    store.onChange(() => changes.push(1));
    const p = store.saveProxy({ name: "VPS", kind: "socks5", host: "vps.example", port: 1080 });
    expect(() => store.setProfileChoice({ mode: "proxy", proxyId: "nope" })).toThrow("No such proxy");
    expect(() => store.saveProxy({ name: "", kind: "http", host: "", port: 80 })).toThrow("host and a port");
    expect(() => store.setRules([{ pattern: "*", via: "direct" }])).toThrow("Not a site");
    store.setProfileChoice({ mode: "proxy", proxyId: p.id });
    store.setContainerChoice("work", { mode: "direct" });
    store.setRules([{ pattern: "https://Intranet.Example/", via: "direct" }]);
    expect(store.config()).toMatchObject({ profile: { mode: "proxy", proxyId: p.id }, containers: { work: { mode: "direct" } }, rules: [{ pattern: "intranet.example", via: "direct" }] });
    expect(() => store.removeProxy(p.id)).toThrow("in use");
    store.setProfileChoice({ mode: "direct" });
    store.removeProxy(p.id);
    store.flush();
    const reloaded = new ConnectionStore(dir, cipher()).config();
    expect(reloaded.proxies).toEqual([]);
    expect(reloaded.profile).toEqual({ mode: "direct" });
    expect(changes.length).toBe(6);
  });
});
