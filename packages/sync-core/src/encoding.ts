import type { SyncCollection } from "@corvus/shared";

export { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";

export const SYNC_COLLECTIONS = [
  "bookmarks",
  "history",
  "settings",
  "open_tabs",
  "profiles",
  "extensions",
  "credentials",
  "reading",
  "watches",
  "workspaces",
  "annotations",
] as const satisfies readonly SyncCollection[];

// Compile-time guard: fails if a collection is added to @corvus/shared but not listed above.
type MissingCollection = Exclude<SyncCollection, (typeof SYNC_COLLECTIONS)[number]>;
const collectionsAreExhaustive: [MissingCollection] extends [never] ? true : never = true;
void collectionsAreExhaustive;

export function isSyncCollection(value: string): value is SyncCollection {
  return (SYNC_COLLECTIONS as readonly string[]).includes(value);
}

const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export function isBase64(value: string): boolean {
  return BASE64_RE.test(value);
}

export function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
}

/** Strict base64 decoding (Buffer.from silently skips invalid characters). */
export function fromBase64(value: string): Uint8Array {
  if (!isBase64(value)) throw new Error("Invalid base64");
  return new Uint8Array(Buffer.from(value, "base64"));
}

export function bytesToUtf8(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

/** JSON.stringify with recursively sorted object keys, for stable fingerprints. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value)) ?? "null";
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object" && !(value instanceof Date)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) out[key] = sortKeys((value as Record<string, unknown>)[key]);
    return out;
  }
  return value;
}
