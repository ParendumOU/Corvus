// Preload for the browser chrome UI (corvus://chrome). Exposes window.corvus only.
import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import { injectBrowserAction } from "electron-chrome-extensions/browser-action";
import { CHROME_EVENT, CHROME_RPC, type ChromeBridge, type ChromeEventMessage } from "../shared/ipc";

// The preload is type-checked with the Node project (no DOM lib); declare the one global it reads.
declare const location: { protocol: string; hostname: string };

function subscribe(listener: (message: ChromeEventMessage) => void): () => void {
  const handler = (_event: IpcRendererEvent, message: ChromeEventMessage): void => listener(message);
  ipcRenderer.on(CHROME_EVENT, handler);
  return () => ipcRenderer.off(CHROME_EVENT, handler);
}

const bridge: ChromeBridge = {
  call: ((method: string, ...args: unknown[]) => ipcRenderer.invoke(CHROME_RPC, method, args)) as ChromeBridge["call"],
  onState: (listener) => subscribe((m) => m.kind === "state" && listener(m.state)),
  onCommand: (listener) => subscribe((m) => m.kind === "command" && listener(m.command)),
};

if (location.protocol === "corvus:" && location.hostname === "chrome") {
  contextBridge.exposeInMainWorld("corvus", bridge);
  injectBrowserAction();
}
