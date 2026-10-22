/**
 * Chrome Web Store extensions published by each device (sync collection `extensions`, one record per
 * device). Other devices only ever suggest them; installing always takes an explicit click.
 */
import type { ExtensionInfo } from "./ipc";

export interface SyncedExtension {
  id: string;
  name: string;
}

export interface DeviceExtensions {
  device: string;
  extensions: SyncedExtension[];
}

export interface ExtensionSuggestion {
  id: string;
  name: string;
  /** Names of the devices that have it installed. */
  devices: string[];
}

/** Chrome Web Store extension ids: 32 characters a-p. */
export const WEBSTORE_ID_RE = /^[a-p]{32}$/;
const MAX_EXTENSIONS = 200;

export function webstoreExtensions(installed: ExtensionInfo[]): SyncedExtension[] {
  return installed
    .filter((e) => e.source === "webstore" && WEBSTORE_ID_RE.test(e.id))
    .map((e) => ({ id: e.id, name: e.name.slice(0, 120) }))
    .sort((a, b) => a.id.localeCompare(b.id))
    .slice(0, MAX_EXTENSIONS);
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export function parseDeviceExtensions(raw: unknown): DeviceExtensions | null {
  if (!isObject(raw) || typeof raw.device !== "string" || !Array.isArray(raw.extensions)) return null;
  const extensions: SyncedExtension[] = [];
  for (const e of raw.extensions.slice(0, MAX_EXTENSIONS)) {
    if (isObject(e) && typeof e.id === "string" && WEBSTORE_ID_RE.test(e.id)) {
      extensions.push({ id: e.id, name: typeof e.name === "string" && e.name ? e.name.slice(0, 120) : e.id });
    }
  }
  return { device: raw.device.slice(0, 64), extensions };
}

/** Extensions installed on other devices but not here, minus the ones the user dismissed. */
export function extensionSuggestions(
  remote: Record<string, unknown>,
  ownDeviceId: string | null,
  installedIds: Iterable<string>,
  dismissed: Iterable<string>,
): ExtensionSuggestion[] {
  const skip = new Set([...installedIds, ...dismissed]);
  const byId = new Map<string, ExtensionSuggestion>();
  for (const [deviceId, raw] of Object.entries(remote)) {
    if (deviceId === ownDeviceId) continue;
    const record = parseDeviceExtensions(raw);
    if (!record) continue;
    for (const ext of record.extensions) {
      if (skip.has(ext.id)) continue;
      const entry = byId.get(ext.id) ?? { id: ext.id, name: ext.name, devices: [] };
      if (!entry.devices.includes(record.device)) entry.devices.push(record.device);
      byId.set(ext.id, entry);
    }
  }
  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
}
