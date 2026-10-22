import { ipcMain, type IpcMainInvokeEvent } from "electron";
import { ASSIST_RPC, OVERLAY_DISMISS, type AssistChromeRpc, type AssistRpc, type AssistView } from "../shared/assist-ipc";
import type { AppContext } from "./context";
import type { BrowserWindowCtl } from "./window";

class IpcError extends Error {}

type Handlers<T> = {
  [K in keyof T]: T[K] extends (...args: infer A) => infer R ? (w: BrowserWindowCtl, ...args: A) => R | Promise<Awaited<R>> : never;
};

const view = (value: unknown): AssistView => (value === "agents" ? "agents" : "assist");
const text = (value: unknown, name: string, max: number): string => {
  if (typeof value !== "string" || value.length > max) throw new IpcError(`Invalid ${name}`);
  return value;
};

/** Chrome UI methods for the Assist toggle and the tab organizer (spread into ChromeRpc handlers). */
export function assistChromeHandlers(ctx: AppContext): Handlers<AssistChromeRpc> {
  return {
    "assist.toggle": (w, v) => ctx.assist.toggle(w, v === undefined ? undefined : view(v)),
    "organizer.propose": (w) => ctx.assist.propose(w),
    "organizer.apply": (w, groups, close) => ctx.assist.applyOrganizer(w, groups, close),
  };
}

function panelHandlers(ctx: AppContext): Handlers<AssistRpc> {
  return {
    "state.get": (w) => ctx.assist.panelState(w),
    "panel.close": (w) => ctx.assist.close(w),
    "panel.resize": (w, width) => {
      if (typeof width !== "number" || !Number.isFinite(width)) throw new IpcError("Invalid width");
      ctx.assist.resize(w, width);
    },
    "panel.setView": (w, v) => ctx.assist.setView(w, view(v)),
    "assist.summarize": (w) => ctx.assist.activeAction(w, "summarize"),
    "assist.ask": (w, question) => {
      const q = text(question, "question", 4000).trim();
      if (q) ctx.assist.activeAction(w, "ask", q);
    },
    "assist.translatePage": (w) => ctx.assist.activeAction(w, "translate-page"),
    "assist.translateMore": (w) => ctx.assist.activeAction(w, "translate-more"),
    "assist.restorePage": (w) => ctx.assist.restorePage(w),
    "assist.cancel": (w) => ctx.assist.cancel(w),
    "assist.clear": (w) => ctx.assist.clear(w),
    "assist.jumpToSection": (w, index) => {
      if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || index > 1000) throw new IpcError("Invalid section");
      return ctx.assist.jumpToSection(w, index);
    },
    "assist.openSettings": (w) => w.openSingleton("corvus://settings/#ai"),
    "agents.pause": (_w, paused) => ctx.agents.setPaused(paused === true),
    "agents.revoke": (_w, client) => ctx.agents.revoke(text(client, "client", 200)),
    "agents.clear": () => ctx.agents.clear(),
  };
}

/** The panel channel only answers the Assist panel views; the overlay may only ask to hide. */
export function registerAssistIpc(ctx: AppContext): void {
  const handlers = panelHandlers(ctx);
  ipcMain.handle(ASSIST_RPC, (event: IpcMainInvokeEvent, method: unknown, args: unknown) => {
    const window = ctx.assist.windowForPanel(event.sender);
    if (!window || event.senderFrame !== event.sender.mainFrame) throw new IpcError("Unauthorized sender");
    if (typeof method !== "string" || !Object.hasOwn(handlers, method)) throw new IpcError(`Unknown method ${String(method)}`);
    const handler = handlers[method as keyof AssistRpc] as (w: BrowserWindowCtl, ...a: unknown[]) => unknown;
    return handler(window, ...(Array.isArray(args) ? args : []));
  });
  ipcMain.on(OVERLAY_DISMISS, (event) => ctx.agents.dismissFrom(event.sender));
}
