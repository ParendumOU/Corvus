/**
 * Where a sync chain lives. One encrypted record (collection `chain_server`, id "current") lists the
 * addresses other devices can reach the chain's sync server at, best first. A computer whose
 * profile syncs through the server built into Corvus ("This computer") keeps it current with its
 * network addresses, so a phone also knows its other addresses (another adapter, Tailscale).
 * Moving the chain to another server writes the new addresses on the old server: devices that read
 * it there follow. Only devices with the recovery phrase can write or read it, so a server cannot
 * send devices elsewhere.
 */
import { normalizeServerUrl } from "./pairing.js";

export const CHAIN_SERVER_ID = "current";
const MAX_URLS = 8;

export interface ChainServer {
  /** Addresses of the chain's sync server, best first. */
  urls: string[];
  /** When the chain moved there (or the addresses last changed). */
  at: number;
  /** The device that wrote it (it does not follow its own record). */
  from: string;
}

export function parseChainServer(raw: unknown): ChainServer | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.urls) || typeof r.at !== "number" || typeof r.from !== "string") return null;
  const urls = [...new Set(r.urls.map((u) => (typeof u === "string" ? normalizeServerUrl(u) : null)).filter((u): u is string => u !== null))].slice(0, MAX_URLS);
  return urls.length > 0 ? { urls, at: r.at, from: r.from } : null;
}

/**
 * The addresses to try when this device should follow the chain elsewhere: the record lists
 * addresses and the one this device uses is not among them. Null when there is nothing to do.
 */
export function chainServerMove(record: unknown, currentUrl: string, ownDeviceId: string): string[] | null {
  const parsed = parseChainServer(record);
  if (!parsed || parsed.from === ownDeviceId) return null;
  const current = normalizeServerUrl(currentUrl);
  return current && parsed.urls.includes(current) ? null : parsed.urls;
}

/** The other addresses of the chain's server, for when the one in use does not answer. */
export function chainServerAlternatives(record: unknown, currentUrl: string): string[] {
  const parsed = parseChainServer(record);
  const current = normalizeServerUrl(currentUrl);
  return parsed && current && parsed.urls.includes(current) ? parsed.urls.filter((u) => u !== current) : [];
}
