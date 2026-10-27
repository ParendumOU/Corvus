import os from "node:os";
import { phoneServerAddresses, reachableFromPhone, type NetworkInterfaceMap } from "@corvus/shared";
import type { PairingAddress } from "../shared/ipc";

/** How long "Pair a phone" waits for the sync server to answer on this computer's network address. */
const HEALTH_TIMEOUT_MS = 2500;

/**
 * Whether a sync server answers GET <serverUrl>/healthz within a short time. Sends no cookies or
 * credentials and follows no redirects.
 */
export async function probeHealth(serverUrl: string, timeoutMs = HEALTH_TIMEOUT_MS): Promise<boolean> {
  try {
    const res = await fetch(`${serverUrl}/healthz`, { signal: AbortSignal.timeout(timeoutMs), credentials: "omit", redirect: "manual" });
    await res.body?.cancel().catch(() => undefined);
    return res.ok;
  } catch {
    return false;
  }
}

export interface PairingAddressOptions {
  /** This computer's network adapters (default: os.networkInterfaces()). */
  interfaces?: NetworkInterfaceMap;
  /** Checks that the sync server answers at a URL (default: probeHealth). */
  probe?: (serverUrl: string) => Promise<boolean>;
  /** The URL to use, when it is one of the candidates (the address picked in "Pair a phone"). */
  prefer?: string;
}

/**
 * The sync server address the pairing code gives the phone. A loopback address (the sync server
 * runs on this computer, e.g. in Docker on localhost) becomes this computer's LAN address, and the
 * server is checked to answer there; any other address goes in the code as it is.
 */
export async function phonePairingAddress(desktopServerUrl: string, opts: PairingAddressOptions = {}): Promise<PairingAddress> {
  const candidates = phoneServerAddresses(desktopServerUrl, opts.interfaces ?? os.networkInterfaces()) ?? [];
  const address = candidates.find((c) => c.url === opts.prefer) ?? candidates[0];
  if (!address) {
    return { serverUrl: desktopServerUrl, desktopServerUrl, lanOnly: false, reachable: reachableFromPhone(desktopServerUrl), address: null, alternatives: [] };
  }
  const reachable = await (opts.probe ?? probeHealth)(address.url);
  return { serverUrl: address.url, desktopServerUrl, lanOnly: true, reachable, address, alternatives: candidates.filter((c) => c !== address) };
}
