// Preload for extension contexts (MV3 service workers and chrome-extension:// pages), registered
// on each profile session after electron-chrome-extensions' own preload.
import { contextBridge, ipcRenderer } from "electron";
import { DNR_DEFAULTS_CHANNEL, EXTENSION_API_BRIDGE } from "../shared/extension-manifest";

// The preload is type-checked with the Node project (no DOM lib); declare the one global it reads.
declare const location: { protocol: string } | undefined;

const isWorker = process.type === "service-worker";

if (isWorker || (typeof location !== "undefined" && location.protocol === "chrome-extension:")) {
  // Chromium also exposes the `browser` namespace, a separate object from `chrome`. Extensions
  // such as uBlock Origin Lite use it, so mirror the APIs electron-chrome-extensions added to
  // `chrome` (windows, permissions, contextMenus, ...) onto it.
  contextBridge.executeInMainWorld({
    args: [EXTENSION_API_BRIDGE],
    func: (bridgeName: string) => {
      const g = globalThis as unknown as Record<string, unknown> & { chrome?: Record<string, unknown>; browser?: Record<string, unknown> };
      const { chrome, browser } = g;
      // electron-chrome-extensions defines chrome.topSites and chrome.downloads as stubs; `chrome`
      // is frozen by now but the namespace objects are not, so point them at Corvus (topSites at the
      // history, downloads at the download list; main/extension-apis.ts).
      const bridge = g[bridgeName] as { invoke(id: string, name: string, args: unknown[]): Promise<unknown> } | undefined;
      delete g[bridgeName];
      const runtime = chrome?.runtime as { id?: string; getManifest?: () => { permissions?: unknown } } | undefined;
      const permissions = runtime?.getManifest?.().permissions;
      const topSites = chrome?.topSites as { get?: unknown } | undefined;
      if (bridge && runtime?.id && topSites && Array.isArray(permissions) && permissions.includes("topSites")) {
        const id = runtime.id;
        topSites.get = (callback?: (sites: unknown) => void) => {
          const result = bridge.invoke(id, "topSites.get", []);
          if (!callback) return result;
          result.then(callback, () => callback([]));
          return undefined;
        };
      }
      const downloads = chrome?.downloads as Record<string, unknown> | undefined;
      if (bridge && runtime?.id && downloads && Array.isArray(permissions) && permissions.includes("downloads")) {
        const id = runtime.id;
        const methods = ["download", "search", "pause", "resume", "cancel", "erase", "open", "show", "showDefaultFolder", "getFileIcon", "acceptDanger", "removeFile", "setUiOptions"];
        for (const name of methods) {
          // An optional trailing callback, else a promise (like every chrome.* function).
          downloads[name] = (...args: unknown[]) => {
            const callback = typeof args[args.length - 1] === "function" ? (args.pop() as (result?: unknown) => void) : undefined;
            const result = bridge.invoke(id, `downloads.${name}`, args);
            if (!callback) return result;
            result.then(callback, (err: unknown) => {
              console.error(`downloads.${name}: ${(err as Error).message}`);
              callback(undefined);
            });
            return undefined;
          };
        }
      }
      if (!chrome || !browser || chrome === browser) return;
      for (const key of Object.keys(chrome)) {
        if (browser[key] !== undefined) continue;
        try {
          Object.defineProperty(browser, key, { value: chrome[key], enumerable: true, configurable: true });
        } catch {
          // non-extensible namespace object: leave it as is
        }
      }
    },
  });
}

if (isWorker) {
  // Electron exposes chrome.declarativeNetRequest but never enables the static rulesets a
  // manifest marks as "enabled": ask the main process which ones to turn on (once per installed
  // version, so the extension's own later choices stick) and enable them in the worker.
  void (async () => {
    const ids: unknown = await ipcRenderer.invoke(DNR_DEFAULTS_CHANNEL);
    if (!Array.isArray(ids) || ids.length === 0) return;
    contextBridge.executeInMainWorld({
      func: (enable: string[]) => {
        const dnr = (
          globalThis as unknown as {
            chrome?: { declarativeNetRequest?: { updateEnabledRulesets(o: { enableRulesetIds: string[] }): Promise<void> } };
          }
        ).chrome?.declarativeNetRequest;
        dnr?.updateEnabledRulesets({ enableRulesetIds: enable }).catch((err: unknown) => console.error("Corvus: enabling static rulesets failed", err));
      },
      args: [ids.filter((id): id is string => typeof id === "string")],
    });
  })();
}
