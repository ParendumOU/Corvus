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

/**
 * Whether a phone can likely reach this sync server address: not on "localhost", a loopback
 * address or a bare name only Docker or this computer knows (no dot).
 */
export function reachableFromPhone(serverUrl: string): boolean {
  try {
    const host = new URL(serverUrl).hostname.replace(/^\[|\]$/g, "");
    if (host === "localhost" || host.endsWith(".localhost") || host === "::1" || /^127\./.test(host)) return false;
    return host.includes(".") || host.includes(":");
  } catch {
    return false;
  }
}
