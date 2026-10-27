import http from "node:http";
import type { AddressInfo } from "node:net";
import { isLoopbackHost, isLoopbackUrl, phoneServerAddresses, reachableFromPhone, type NetworkInterfaceMap } from "@corvus/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { phonePairingAddress, probeHealth } from "../src/main/pairing-address";

const v4 = (address: string, internal = false) => ({ address, family: "IPv4", internal });
const v6 = (address: string, internal = false) => ({ address, family: "IPv6", internal });

/** A Windows laptop on Wi-Fi with WSL, Hyper-V, VirtualBox, a disconnected Ethernet port and Tailscale. */
const WINDOWS: NetworkInterfaceMap = {
  "vEthernet (WSL (Hyper-V firewall))": [v6("fe80::1d2c:3b4a:5968:7a8b"), v4("172.29.80.1")],
  "vEthernet (Default Switch)": [v4("172.20.0.1")],
  "VirtualBox Host-Only Network": [v4("192.168.56.1")],
  Ethernet: [v6("fe80::aa:bb:cc:dd"), v4("169.254.10.3")],
  "Wi-Fi": [v6("fe80::1234:5678:9abc:def0"), v4("192.168.1.20")],
  Tailscale: [v6("fd7a:115c:a1e0::1"), v4("100.101.102.103")],
  "Loopback Pseudo-Interface 1": [v6("::1", true), v4("127.0.0.1", true)],
};

/** A Linux desktop with Docker networks, Wi-Fi and wired Ethernet. */
const LINUX: NetworkInterfaceMap = {
  lo: [v4("127.0.0.1", true), v6("::1", true)],
  docker0: [v4("172.17.0.1")],
  "br-1a2b3c4d5e6f": [v4("172.18.0.1")],
  veth9f8e7d6: [v6("fe80::a0b1:c2ff:fed3:e4f5")],
  virbr0: [v4("192.168.122.1")],
  enp3s0: [v4("10.0.0.5"), v6("fe80::1")],
  wlp2s0: [v4("192.168.0.42"), v6("fe80::2")],
};

/** A Mac on Wi-Fi sharing its connection (bridge100), with Tailscale on a utun adapter. */
const MAC: NetworkInterfaceMap = {
  lo0: [v4("127.0.0.1", true)],
  bridge100: [v4("192.168.64.1")],
  awdl0: [v6("fe80::3")],
  utun3: [v4("100.88.1.2")],
  en0: [v6("fe80::4"), v4("192.168.1.30")],
};

describe("loopback sync server addresses", () => {
  it("knows every way of writing this device", () => {
    for (const host of ["localhost", "LOCALHOST", "sync.localhost", "localhost.", "127.0.0.1", "127.1.2.3", "0.0.0.0", "::1", "[::1]", "::", "::ffff:7f00:1"]) {
      expect(isLoopbackHost(host), host).toBe(true);
    }
    for (const host of ["192.168.1.20", "10.0.0.5", "sync.example.com", "localhost.example.com", "128.0.0.1", "sync-server", "fe80::1", "100.64.0.7"]) {
      expect(isLoopbackHost(host), host).toBe(false);
    }
  });

  it("reads it from a URL, as the URL parser normalizes it", () => {
    expect(isLoopbackUrl("http://localhost:8797")).toBe(true);
    expect(isLoopbackUrl("http://127.1:8797")).toBe(true);
    expect(isLoopbackUrl("http://[0:0:0:0:0:0:0:1]:8797")).toBe(true);
    expect(isLoopbackUrl("http://[::ffff:127.0.0.1]:8797")).toBe(true);
    expect(isLoopbackUrl("http://0.0.0.0:8797")).toBe(true);
    expect(isLoopbackUrl("https://sync.example.com")).toBe(false);
    expect(isLoopbackUrl("not a url")).toBe(false);
  });

  it("is never reachable from the phone", () => {
    expect(reachableFromPhone("http://0.0.0.0:8797")).toBe(false);
    expect(reachableFromPhone("http://[::1]:8797")).toBe(false);
    expect(reachableFromPhone("http://sync.localhost:8797")).toBe(false);
    expect(reachableFromPhone("http://192.168.1.20:8797")).toBe(true);
  });
});

describe("the phone's address for a sync server on this computer", () => {
  it("Windows: the Wi-Fi address, not WSL, Hyper-V, VirtualBox or link-local; Tailscale offered too", () => {
    expect(phoneServerAddresses("http://localhost:8797", WINDOWS)).toEqual([
      { url: "http://192.168.1.20:8797", address: "192.168.1.20", adapter: "Wi-Fi", kind: "lan" },
      { url: "http://100.101.102.103:8797", address: "100.101.102.103", adapter: "Tailscale", kind: "tailscale" },
    ]);
  });

  it("Linux: Wi-Fi and Ethernet, never docker0, br-*, veth or virbr; 192.168 first; scheme, port and path kept", () => {
    expect(phoneServerAddresses("http://localhost:8797/sync/", LINUX)?.map((a) => [a.url, a.adapter, a.kind])).toEqual([
      ["http://192.168.0.42:8797/sync", "wlp2s0", "lan"],
      ["http://10.0.0.5:8797/sync", "enp3s0", "lan"],
    ]);
    expect(phoneServerAddresses("https://[::1]:9443/base", LINUX)?.[0]?.url).toBe("https://192.168.0.42:9443/base");
    expect(phoneServerAddresses("http://127.0.0.1", LINUX)?.[0]?.url).toBe("http://192.168.0.42");
  });

  it("macOS: en0, not the connection-sharing bridge; Tailscale on utun is labelled", () => {
    expect(phoneServerAddresses("http://localhost:8797", MAC)?.map((a) => [a.address, a.adapter, a.kind])).toEqual([
      ["192.168.1.30", "en0", "lan"],
      ["100.88.1.2", "utun3", "tailscale"],
    ]);
  });

  it("only Tailscale: its address, labelled", () => {
    const only = { lo: [v4("127.0.0.1", true)], tailscale0: [v4("100.64.0.7"), v6("fd7a:115c:a1e0::7")] };
    expect(phoneServerAddresses("http://localhost:8797", only)).toEqual([{ url: "http://100.64.0.7:8797", address: "100.64.0.7", adapter: "tailscale0", kind: "tailscale" }]);
  });

  it("no usable address: an empty list (the code keeps the setting and the warning)", () => {
    expect(phoneServerAddresses("http://localhost:8797", { lo: [v4("127.0.0.1", true)], docker0: [v4("172.17.0.1")] })).toEqual([]);
    expect(phoneServerAddresses("http://localhost:8797", {})).toEqual([]);
  });

  it("an address a phone may reach goes in the code as it is", () => {
    expect(phoneServerAddresses("https://sync.example.com", WINDOWS)).toBeNull();
    expect(phoneServerAddresses("http://192.168.1.20:8797", WINDOWS)).toBeNull();
    expect(phoneServerAddresses("http://sync-server:8787", WINDOWS)).toBeNull();
  });

  it("is deterministic: Wi-Fi/Ethernet names first, then 192.168 before 10 before 172.16, then by name and address", () => {
    const layout: NetworkInterfaceMap = {
      br0: [v4("192.168.1.5")],
      "Ethernet 3": [v4("172.16.4.4")],
      "Ethernet 2": [v4("10.1.1.1")],
      WLAN: [v4("10.1.1.0")],
      eth0: [{ address: "10.1.1.2", family: 4, internal: false }],
    };
    const order = ["10.1.1.1", "10.1.1.0", "10.1.1.2", "172.16.4.4", "192.168.1.5"];
    expect(phoneServerAddresses("http://localhost:1", layout)?.map((a) => a.address)).toEqual(order);
    const reversed = Object.fromEntries(Object.entries(layout).reverse());
    expect(phoneServerAddresses("http://localhost:1", reversed)?.map((a) => a.address)).toEqual(order);
  });

  it("skips public, link-local and duplicate addresses", () => {
    const layout: NetworkInterfaceMap = {
      "Wi-Fi 2": [v4("192.168.1.20")],
      "Wi-Fi": [v4("203.0.113.9"), v4("169.254.1.1"), v4("192.168.1.20")],
    };
    expect(phoneServerAddresses("http://localhost:8797", layout)?.map((a) => [a.address, a.adapter])).toEqual([["192.168.1.20", "Wi-Fi"]]);
  });
});

describe("Pair a phone's address", () => {
  it("a loopback setting becomes the LAN address, checked to answer there; the setting is reported unchanged", async () => {
    const probe = vi.fn(async () => true);
    const result = await phonePairingAddress("http://localhost:8797", { interfaces: WINDOWS, probe });
    expect(probe).toHaveBeenCalledWith("http://192.168.1.20:8797");
    expect(result).toMatchObject({ serverUrl: "http://192.168.1.20:8797", desktopServerUrl: "http://localhost:8797", lanOnly: true, reachable: true });
    expect(result.address?.adapter).toBe("Wi-Fi");
    expect(result.alternatives.map((a) => a.url)).toEqual(["http://100.101.102.103:8797"]);
  });

  it("another of the computer's addresses can be picked; an unknown one falls back to the best", async () => {
    const picked = await phonePairingAddress("http://localhost:8797", { interfaces: WINDOWS, probe: async () => false, prefer: "http://100.101.102.103:8797" });
    expect(picked).toMatchObject({ serverUrl: "http://100.101.102.103:8797", lanOnly: true, reachable: false });
    expect(picked.alternatives.map((a) => a.url)).toEqual(["http://192.168.1.20:8797"]);
    const unknown = await phonePairingAddress("http://localhost:8797", { interfaces: WINDOWS, probe: async () => true, prefer: "http://evil.example" });
    expect(unknown.serverUrl).toBe("http://192.168.1.20:8797");
  });

  it("any other address goes in the code unchanged, without a network check", async () => {
    const probe = vi.fn(async () => true);
    expect(await phonePairingAddress("https://sync.example.com", { interfaces: WINDOWS, probe })).toEqual({
      serverUrl: "https://sync.example.com",
      desktopServerUrl: "https://sync.example.com",
      lanOnly: false,
      reachable: true,
      address: null,
      alternatives: [],
    });
    expect((await phonePairingAddress("http://sync-server:8787", { interfaces: WINDOWS, probe })).reachable).toBe(false);
    expect(probe).not.toHaveBeenCalled();
  });

  it("a loopback setting on a computer without a usable address keeps today's warning", async () => {
    const result = await phonePairingAddress("http://localhost:8797", { interfaces: { lo: [v4("127.0.0.1", true)] }, probe: async () => true });
    expect(result).toEqual({ serverUrl: "http://localhost:8797", desktopServerUrl: "http://localhost:8797", lanOnly: false, reachable: false, address: null, alternatives: [] });
  });
});

describe("the sync server health check", () => {
  const servers: http.Server[] = [];
  afterEach(() => {
    for (const s of servers.splice(0)) {
      s.closeAllConnections();
      s.close();
    }
  });
  const serve = async (handler: http.RequestListener): Promise<string> => {
    const server = http.createServer(handler);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  };

  it("asks /healthz without credentials and needs a 2xx answer", async () => {
    const seen: http.IncomingHttpHeaders[] = [];
    const ok = await serve((req, res) => {
      seen.push(req.headers);
      res.writeHead(req.url === "/healthz" ? 200 : 404, { "content-type": "application/json" });
      res.end('{"ok":true}');
    });
    expect(await probeHealth(ok)).toBe(true);
    expect(seen[0]?.cookie).toBeUndefined();
    expect(seen[0]?.authorization).toBeUndefined();
    expect(await probeHealth(await serve((_req, res) => res.writeHead(500).end()))).toBe(false);
    expect(await probeHealth(await serve((_req, res) => res.writeHead(302, { location: "http://example.com/" }).end()))).toBe(false);
  });

  it("gives up quickly when nothing answers", async () => {
    const closed = await serve(() => undefined);
    servers.pop()?.close();
    expect(await probeHealth(closed)).toBe(false);
    const silent = await serve(() => undefined);
    const started = Date.now();
    expect(await probeHealth(silent, 200)).toBe(false);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
