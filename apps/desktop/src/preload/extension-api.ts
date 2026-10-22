// Preload for extension contexts (MV3 service workers and chrome-extension:// pages), registered
// BEFORE electron-chrome-extensions' preload: that one freezes `chrome`, so namespaces Corvus adds
// (bookmarks, history, tabGroups, sessions, search, sidePanel) must exist by then. Calls and events
// travel over electron-chrome-extensions' own IPC ("crx-msg", "crx-add-listener"), whose router in
// the main process checks the manifest permission of every call (see main/extension-apis.ts).
import { contextBridge, ipcRenderer } from "electron";
import { EXTENSION_API_BRIDGE } from "../shared/extension-manifest";

declare const location: { protocol: string } | undefined;

const isWorker = process.type === "service-worker";

if (isWorker || (typeof location !== "undefined" && location.protocol === "chrome-extension:")) {
  const bridge = {
    invoke: (extensionId: string, name: string, args: unknown[]): Promise<unknown> =>
      ipcRenderer.invoke("crx-msg", extensionId, name, ...args).catch((err: unknown) => {
        // "Error invoking remote method 'crx-msg': Error: <message>" -> "<message>"
        throw new Error(String((err as Error)?.message ?? err).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, ""));
      }),
    listen: (extensionId: string, name: string, fire: (...args: unknown[]) => void): void => {
      ipcRenderer.send("crx-add-listener", extensionId, name);
      ipcRenderer.on(`crx-${name}`, (_event, ...args: unknown[]) => fire(...args));
    },
  };
  contextBridge.exposeInMainWorld(EXTENSION_API_BRIDGE, bridge);
  contextBridge.executeInMainWorld({
    args: [EXTENSION_API_BRIDGE],
    func: (bridgeName: string) => {
      type Bridge = typeof bridge;
      const g = globalThis as unknown as Record<string, unknown> & { chrome?: Record<string, unknown> & { runtime?: { id?: string; getManifest?: () => { permissions?: unknown } } } };
      const chrome = g.chrome;
      const api = g[bridgeName] as Bridge | undefined;
      const id = chrome?.runtime?.id;
      if (!chrome || !api || !id) return;
      const manifest = chrome.runtime?.getManifest?.() ?? {};
      const granted = new Set(Array.isArray(manifest.permissions) ? manifest.permissions.filter((p): p is string => typeof p === "string") : []);

      // chrome.* functions accept an optional trailing callback and otherwise return a promise.
      const fn =
        (name: string) =>
        (...args: unknown[]): Promise<unknown> | undefined => {
          const callback = typeof args[args.length - 1] === "function" ? (args.pop() as (result?: unknown) => void) : undefined;
          const result = api.invoke(id, name, args);
          if (!callback) return result;
          result.then(
            (value) => callback(value),
            (err: unknown) => {
              console.error(`${name}: ${(err as Error).message}`);
              callback(undefined);
            },
          );
          return undefined;
        };

      class ExtensionEvent {
        private readonly listeners = new Set<(...args: unknown[]) => void>();
        private wired = false;
        constructor(private readonly name: string) {}
        addListener(listener: (...args: unknown[]) => void): void {
          if (typeof listener !== "function") return;
          this.listeners.add(listener);
          if (this.wired) return;
          this.wired = true;
          api!.listen(id!, this.name, (...args) => {
            for (const l of [...this.listeners]) {
              try {
                l(...args);
              } catch (err) {
                console.error(err);
              }
            }
          });
        }
        removeListener(listener: (...args: unknown[]) => void): void {
          this.listeners.delete(listener);
        }
        hasListener(listener: (...args: unknown[]) => void): boolean {
          return this.listeners.has(listener);
        }
        hasListeners(): boolean {
          return this.listeners.size > 0;
        }
      }

      const ns = (prefix: string, fns: string[], events: string[], extra: Record<string, unknown> = {}): Record<string, unknown> => ({
        ...Object.fromEntries(fns.map((f) => [f, fn(`${prefix}.${f}`)])),
        ...Object.fromEntries(events.map((e) => [e, new ExtensionEvent(`${prefix}.${e}`)])),
        ...extra,
      });

      const namespaces: Record<string, () => Record<string, unknown>> = {
        bookmarks: () =>
          ns(
            "bookmarks",
            ["get", "getChildren", "getRecent", "getTree", "getSubTree", "search", "create", "update", "move", "remove", "removeTree"],
            ["onCreated", "onRemoved", "onChanged", "onMoved", "onChildrenReordered", "onImportBegan", "onImportEnded"],
            { MAX_WRITE_OPERATIONS_PER_HOUR: 1_000_000, MAX_SUSTAINED_WRITE_OPERATIONS_PER_MINUTE: 1_000_000 },
          ),
        history: () => ns("history", ["search", "getVisits", "addUrl", "deleteUrl", "deleteRange", "deleteAll"], ["onVisited", "onVisitRemoved"]),
        tabGroups: () =>
          ns("tabGroups", ["get", "query", "update", "move"], ["onCreated", "onUpdated", "onRemoved", "onMoved"], {
            TAB_GROUP_ID_NONE: -1,
            Color: { GREY: "grey", BLUE: "blue", RED: "red", YELLOW: "yellow", GREEN: "green", PINK: "pink", PURPLE: "purple", CYAN: "cyan", ORANGE: "orange" },
          }),
        sessions: () => ns("sessions", ["getRecentlyClosed", "getDevices", "restore"], ["onChanged"], { MAX_SESSION_RESULTS: 25 }),
        search: () => ns("search", ["query"], [], { Disposition: { CURRENT_TAB: "CURRENT_TAB", NEW_TAB: "NEW_TAB", NEW_WINDOW: "NEW_WINDOW" } }),
        sidePanel: () => ns("sidePanel", ["setOptions", "getOptions", "setPanelBehavior", "getPanelBehavior", "open", "close"], ["onOpened", "onClosed"]),
      };
      for (const [name, build] of Object.entries(namespaces)) {
        if (!granted.has(name) || chrome[name] !== undefined) continue;
        try {
          Object.defineProperty(chrome, name, { value: build(), enumerable: true, configurable: true });
        } catch (err) {
          console.error(`Corvus: chrome.${name} unavailable`, err);
        }
      }
    },
  });
}
