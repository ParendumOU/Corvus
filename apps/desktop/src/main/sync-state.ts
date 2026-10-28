import { parseChainServer, type ChainServer } from "@corvus/shared";
import type { SyncMode } from "../shared/ipc";

export interface ProfileSyncState {
  enabled: boolean;
  /** "local": the sync server built into Corvus on this computer; "custom": a server the person runs. */
  mode: SyncMode;
  /** The server in use: this computer's loopback address in "local" mode. */
  serverUrl: string;
  /** The last own server address entered (offered again when switching back). */
  customServerUrl: string;
  /** The port the built-in server listened on last time (tried first, so paired phones keep working). */
  localPort: number | null;
  /**
   * After the chain moved away from this computer, its built-in server keeps answering until then,
   * so devices that sync meanwhile read where the chain went. Its data is deleted afterwards.
   */
  retireLocalUntil: number | null;
  deviceName: string;
  chainId: string | null;
  phrase: { enc: boolean; data: string } | null;
  lastSyncAt: number | null;
  intervalMinutes: number;
  syncServiceUrls: boolean;
  /** Sync saved workflows (per device, default on; off keeps local data). */
  syncWorkflows: boolean;
  /** Sync site memory (per device, default on; off keeps local data). */
  syncSiteMemory: boolean;
  /** Sync the Command Bar's recents (per device, default on; off keeps local data). */
  syncCommandHistory: boolean;
  /** Sync Assist conversations (per device, default on; off keeps local data). */
  syncAssistHistory: boolean;
  /** Client/engine state written by older versions; moved to sync-kv.json on first start. */
  kv?: Record<string, string>;
}

/**
 * A profile's sync.json as read from disk. Written before Corvus had a sync server of its own, it
 * has no mode: a profile already syncing keeps its server as "Your own server"; one not syncing
 * starts on "This computer".
 */
export function reviveSyncState(raw: unknown, defaults: ProfileSyncState): ProfileSyncState {
  if (typeof raw !== "object" || raw === null) return defaults;
  const r = raw as Partial<ProfileSyncState>;
  const merged: ProfileSyncState = { ...defaults, ...r };
  if (r.mode !== "local" && r.mode !== "custom") {
    merged.mode = r.enabled ? "custom" : "local";
    if (typeof r.serverUrl === "string" && r.serverUrl) merged.customServerUrl = r.serverUrl;
  }
  if (typeof merged.localPort !== "number") merged.localPort = null;
  if (typeof merged.retireLocalUntil !== "number") merged.retireLocalUntil = null;
  return merged;
}

/**
 * The chain_server record a computer syncing through its own built-in server writes: the addresses
 * other devices reach it at. The stored one is kept while the addresses are the same (so it is not
 * pushed again every cycle).
 */
export function ownChainServer(urls: string[], stored: unknown, deviceId: string, now: number): ChainServer | null {
  if (urls.length === 0) return null;
  const current = parseChainServer(stored);
  if (current && current.from === deviceId && current.urls.join(" ") === urls.join(" ")) return current;
  return { urls, at: now, from: deviceId };
}

