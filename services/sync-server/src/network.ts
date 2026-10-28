/** IPv4 dotted quad as numbers, or null. Accepts IPv4-mapped IPv6 (::ffff:a.b.c.d). */
function ipv4(address: string): number[] | null {
  const m = /^(?:::ffff:)?(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/i.exec(address);
  if (!m) return null;
  const octets = m.slice(1).map(Number);
  return octets.every((n) => n <= 255) ? octets : null;
}

/**
 * Whether a client address belongs to this computer or a private network: loopback, the private
 * IPv4 ranges (10/8, 172.16/12, 192.168/16), link-local, carrier-grade NAT (100.64/10, which
 * Tailscale uses), and IPv6 loopback, unique-local (fc00::/7) and link-local (fe80::/10). A sync
 * server built into the desktop app answers only these, so it is never reachable from the internet
 * even on a computer with a public address.
 */
export function isPrivateAddress(address: string | undefined): boolean {
  if (!address) return false;
  const v4 = ipv4(address);
  if (v4) {
    const [a, b] = v4 as [number, number, number, number];
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
  }
  const v6 = address.toLowerCase().replace(/%.*$/, "");
  return v6 === "::1" || /^f[cd][0-9a-f]{2}:/.test(v6) || /^fe[89ab][0-9a-f]:/.test(v6);
}
