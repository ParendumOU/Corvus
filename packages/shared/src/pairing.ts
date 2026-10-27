/**
 * Pairing a phone with a computer: the desktop shows a QR code that holds the sync server's
 * address and the chain's recovery phrase, and the Corvus mobile app reads it. Not a URL on
 * purpose, so a phone's camera app offers to copy it rather than open it in another app.
 * Format: "corvus-pair:1:" + base64url(JSON {s: server URL, p: recovery phrase}).
 */

const PREFIX = "corvus-pair:1:";
const PHRASE_WORDS = 24;

export interface PairingInfo {
  serverUrl: string;
  phrase: string;
}

function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(text: string): string {
  const base64 = text.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((text.length + 3) % 4);
  const binary = atob(base64);
  return new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
}

/** A sync server address as stored: http(s), no trailing slash; null when it is not one. */
export function normalizeServerUrl(raw: string): string | null {
  try {
    const url = new URL(raw.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.toString().replace(/\/+$/, "");
  } catch {
    return null;
  }
}

/** The text of the pairing QR code. */
export function encodePairing(info: PairingInfo): string {
  return PREFIX + toBase64Url(JSON.stringify({ s: info.serverUrl, p: info.phrase }));
}

/**
 * Reads a pairing code (as scanned or pasted): the server address and a 24-word phrase, or null
 * when it is not one. The phrase's checksum is checked when it is used (sync-core).
 */
export function decodePairing(text: string): PairingInfo | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith(PREFIX)) return null;
  try {
    const data = JSON.parse(fromBase64Url(trimmed.slice(PREFIX.length))) as { s?: unknown; p?: unknown };
    const serverUrl = typeof data.s === "string" ? normalizeServerUrl(data.s) : null;
    const phrase = typeof data.p === "string" ? data.p.trim().toLowerCase().split(/\s+/).join(" ") : "";
    if (!serverUrl || phrase.split(" ").length !== PHRASE_WORDS) return null;
    return { serverUrl, phrase };
  } catch {
    return null;
  }
}

/** A URL's host name without IPv6 brackets or a trailing dot, lower case; null when it is not a URL. */
function hostOf(serverUrl: string): string | null {
  try {
    return new URL(serverUrl).hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  } catch {
    return null;
  }
}

/**
 * Whether a host name means "this device": localhost (and *.localhost), 127.x.x.x, ::1, or the
 * "any address" 0.0.0.0 / ::. On a phone those point at the phone itself, never at the computer.
 */
export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host) || host === "0.0.0.0") return true;
  if (host === "::1" || host === "::") return true;
  // IPv4-mapped IPv6: the URL parser writes [::ffff:127.0.0.1] as [::ffff:7f00:1].
  return /^::ffff:(127\.|7f[0-9a-f]{2}:)/.test(host) || host === "::ffff:0:0";
}

/** Whether a sync server URL points at "this device" (see isLoopbackHost); false when it is not a URL. */
export function isLoopbackUrl(serverUrl: string): boolean {
  const host = hostOf(serverUrl);
  return host !== null && isLoopbackHost(host);
}

/**
 * Whether a phone can likely reach this sync server address: not on "localhost", a loopback
 * address or a bare name only Docker or this computer knows (no dot).
 */
export function reachableFromPhone(serverUrl: string): boolean {
  const host = hostOf(serverUrl);
  if (host === null || isLoopbackHost(host)) return false;
  return host.includes(".") || host.includes(":");
}

/** One address of a network adapter, shaped like an entry of Node's os.networkInterfaces(). */
export interface NetworkAddressInfo {
  address: string;
  /** "IPv4" or "IPv6" (Node 18.0 to 18.3 reported 4 or 6). */
  family: string | number;
  internal: boolean;
}

/** Network adapters by name with their addresses, as Node's os.networkInterfaces() returns them. */
export type NetworkInterfaceMap = Record<string, readonly NetworkAddressInfo[] | undefined>;

/** An address of this computer that a phone can use to reach a sync server running on it. */
export interface PhoneServerAddress {
  /** The sync server URL with this address as its host: same scheme, port and path. */
  url: string;
  /** The IPv4 address. */
  address: string;
  /** The network adapter's name as the system reports it ("Wi-Fi", "en0", "tailscale0"…). */
  adapter: string;
  /** "lan": a private address on the local network (Wi-Fi or Ethernet); "tailscale": a Tailscale address (100.64.0.0/10). */
  kind: "lan" | "tailscale";
}

/**
 * Adapters that are not the computer's own network connection: virtual switches and bridges of
 * WSL, Hyper-V, Docker, VirtualBox, VMware, Parallels and Linux containers, VPN tunnels, and
 * Bluetooth or loopback pseudo-adapters. Their private addresses are not on the phone's Wi-Fi.
 */
const VIRTUAL_ADAPTER =
  /vethernet|wsl|hyper-v|virtualbox|vbox|host-only|vmware|vmnet|parallels|docker|^br-|^veth|virbr|lxcbr|lxdbr|incusbr|^cni|flannel|^cali|weave|podman|^bridge\d|^vnic|^zt|zerotier|^tun|^tap|^utun|^ipsec|^wg\d|wireguard|nordlynx|vpn|^ppp|bluetooth|loopback|isatap|teredo|npcap|^awdl|^llw|^anpi/i;

/** Names that look like the computer's Wi-Fi or Ethernet (Windows in English or Spanish, macOS, Linux). */
const PHYSICAL_ADAPTER = /wi-?fi|wlan|wireless|inal[aá]mbric|ethernet|local area connection|[aá]rea local|^(eth|en|eno|ens|wl)\d|^(enp|enx|wlp|wlo|wlx)[0-9a-f]/i;

function ipv4Octets(address: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(address);
  if (!m) return null;
  const octets = m.slice(1).map(Number);
  return octets.every((n) => n <= 255) ? octets : null;
}

/** 0 for 192.168/16 (most home networks), 1 for 10/8, 2 for 172.16/12 (also Docker's and WSL's); null when not private. */
function privateRange([a, b]: number[]): number | null {
  if (a === 192 && b === 168) return 0;
  if (a === 10) return 1;
  if (a === 172 && b! >= 16 && b! <= 31) return 2;
  return null;
}

const isTailscale = ([a, b]: number[]): boolean => a === 100 && b! >= 64 && b! <= 127;

const compareAddresses = (x: string, y: string): number => {
  const a = ipv4Octets(x)!;
  const b = ipv4Octets(y)!;
  for (let i = 0; i < 4; i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
  return 0;
};

/**
 * For a sync server URL on this computer's loopback (localhost, 127.x, ::1, 0.0.0.0), which a
 * phone cannot use, the URLs a phone can use instead: same scheme, port and path with one of this
 * computer's IPv4 addresses as the host, best first. LAN addresses come first (private ranges on
 * real adapters: no loopback, link-local or virtual adapters such as WSL, Hyper-V, Docker or VPNs;
 * Wi-Fi and Ethernet names before other names, 192.168 before 10 before 172.16, then by adapter
 * name and address), then Tailscale addresses. Pure, so the order is the same for the same input.
 *
 * Returns null when the URL is not a loopback one (the pairing code carries it as it is), and an
 * empty list when this computer has no usable address.
 */
export function phoneServerAddresses(serverUrl: string, interfaces: NetworkInterfaceMap): PhoneServerAddress[] | null {
  if (!isLoopbackUrl(serverUrl)) return null;
  // Rank: LAN on a Wi-Fi/Ethernet name (0) or another name (1), then Tailscale (2); then the range.
  const found: Array<{ entry: PhoneServerAddress; rank: [number, number] }> = [];
  for (const [adapter, addresses] of Object.entries(interfaces)) {
    for (const info of addresses ?? []) {
      if (info.internal || (info.family !== "IPv4" && info.family !== 4)) continue;
      const octets = ipv4Octets(info.address);
      if (!octets) continue;
      const url = new URL(serverUrl);
      url.hostname = info.address;
      const entry = { url: url.toString().replace(/\/+$/, ""), address: info.address, adapter };
      if (isTailscale(octets)) {
        found.push({ entry: { ...entry, kind: "tailscale" }, rank: [2, 0] });
        continue;
      }
      const range = privateRange(octets);
      if (range === null || VIRTUAL_ADAPTER.test(adapter)) continue;
      found.push({ entry: { ...entry, kind: "lan" }, rank: [PHYSICAL_ADAPTER.test(adapter) ? 0 : 1, range] });
    }
  }
  found.sort(
    (x, y) =>
      x.rank[0] - y.rank[0] ||
      x.rank[1] - y.rank[1] ||
      (x.entry.adapter < y.entry.adapter ? -1 : x.entry.adapter > y.entry.adapter ? 1 : compareAddresses(x.entry.address, y.entry.address)),
  );
  // The same address on two adapters (rare) is offered once, under the first in that order.
  const seen = new Set<string>();
  const out: PhoneServerAddress[] = [];
  for (const { entry } of found) {
    if (seen.has(entry.address)) continue;
    seen.add(entry.address);
    out.push(entry);
  }
  return out;
}
