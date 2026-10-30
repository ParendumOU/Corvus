// Preload for the Corvus Assist panel (corvus://assist), the agent overlay (corvus://agent-overlay),
// the reader and the account dropdown under a field (corvus://field-menu). All live in their own
// views, never in tabs.
import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import {
  ASSIST_EVENT,
  ASSIST_RPC,
  OVERLAY_DISMISS,
  OVERLAY_EVENT,
  type AssistBridge,
  type AssistEventMessage,
  type OverlayBridge,
  type OverlayEvent,
} from "../shared/assist-ipc";
import { READER_EVENT, READER_RPC, type ReaderBridge, type ReaderEventMessage } from "../shared/reader-ipc";
import { FIELD_MENU_ACTION, FIELD_MENU_EVENT, type FieldDropdownState, type FieldMenuBridge } from "../shared/credentials-ipc";

// The preload is type-checked with the Node project (no DOM lib); declare the globals it reads.
declare const location: { protocol: string; hostname: string };
declare const window: { top: unknown };

const trusted = location.protocol === "corvus:" && window.top === window;

if (trusted && location.hostname === "assist") {
  const bridge: AssistBridge = {
    call: ((method: string, ...args: unknown[]) => ipcRenderer.invoke(ASSIST_RPC, method, args)) as AssistBridge["call"],
    onEvent: (listener) => {
      const handler = (_event: IpcRendererEvent, message: AssistEventMessage): void => listener(message);
      ipcRenderer.on(ASSIST_EVENT, handler);
      return () => ipcRenderer.off(ASSIST_EVENT, handler);
    },
  };
  contextBridge.exposeInMainWorld("corvusAssist", bridge);
}

if (trusted && location.hostname === "reader") {
  const bridge: ReaderBridge = {
    call: ((method: string, ...args: unknown[]) => ipcRenderer.invoke(READER_RPC, method, args)) as ReaderBridge["call"],
    onEvent: (listener) => {
      const handler = (_event: IpcRendererEvent, message: ReaderEventMessage): void => listener(message);
      ipcRenderer.on(READER_EVENT, handler);
      return () => ipcRenderer.off(READER_EVENT, handler);
    },
  };
  contextBridge.exposeInMainWorld("corvusReader", bridge);
}

if (trusted && location.hostname === "agent-overlay") {
  const bridge: OverlayBridge = {
    onEvent: (listener) => {
      const handler = (_event: IpcRendererEvent, message: OverlayEvent): void => listener(message);
      ipcRenderer.on(OVERLAY_EVENT, handler);
      return () => ipcRenderer.off(OVERLAY_EVENT, handler);
    },
    dismiss: () => ipcRenderer.send(OVERLAY_DISMISS),
  };
  contextBridge.exposeInMainWorld("corvusOverlay", bridge);
}

if (trusted && location.hostname === "field-menu") {
  const bridge: FieldMenuBridge = {
    onState: (listener) => {
      const handler = (_event: IpcRendererEvent, state: FieldDropdownState | null): void => listener(state);
      ipcRenderer.on(FIELD_MENU_EVENT, handler);
      return () => ipcRenderer.off(FIELD_MENU_EVENT, handler);
    },
    send: (action) => ipcRenderer.send(FIELD_MENU_ACTION, action),
  };
  contextBridge.exposeInMainWorld("corvusFieldMenu", bridge);
}
