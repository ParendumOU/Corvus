// Whether a preload runs in an extension's own context. The session registers the extension preloads
// for every service worker and frame, web pages' included; those must get nothing.
import { contextBridge } from "electron";

declare const location: { protocol: string } | undefined;

export function inExtensionContext(): boolean {
  const protocol =
    process.type === "service-worker"
      ? (contextBridge.executeInMainWorld({ func: () => (globalThis as { location?: { protocol?: string } }).location?.protocol }) as unknown)
      : typeof location !== "undefined"
        ? location.protocol
        : undefined;
  return protocol === "chrome-extension:";
}
