import { clipboard, ipcMain, type IpcMainInvokeEvent } from "electron";
import { ASSIST_RPC, OVERLAY_DISMISS, type AssistChromeRpc, type AssistRpc, type AssistView } from "../shared/assist-ipc";
import type { AgentApprovalDecision } from "../shared/command-bar-ipc";
import type { FlowApprovalDecision } from "../shared/flow-ipc";
import type { AppContext } from "./context";
import { recordingBytes } from "./dictation-service";
import { safeUrl } from "../shared/assist-artifacts";
import { hintKind, paramValues } from "./ipc-flow";
import type { BrowserWindowCtl } from "./window";

class IpcError extends Error {}

type Handlers<T> = {
  [K in keyof T]: T[K] extends (...args: infer A) => infer R ? (w: BrowserWindowCtl, ...args: A) => R | Promise<Awaited<R>> : never;
};

const view = (value: unknown): AssistView => (value === "agents" || value === "workflows" ? value : "assist");
const agentDecision = (value: unknown): AgentApprovalDecision => {
  if (value === "approve" || value === "skip" || value === "stop") return value;
  throw new IpcError("Invalid decision");
};
const flowDecision = (value: unknown): FlowApprovalDecision => {
  if (value === "approve" || value === "skip" || value === "stop") return value;
  throw new IpcError("Invalid decision");
};
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
    "dictation.transcribe": (_w, audio, mimeType) => ctx.dictation.transcribe(recordingBytes(audio), text(mimeType, "type", 200)),
    "assist.summarize": (w) => ctx.assist.activeAction(w, "summarize"),
    "assist.ask": (w, question) => {
      const q = text(question, "question", 4000).trim();
      if (q) ctx.assist.activeAction(w, "ask", q);
    },
    "assist.translatePage": (w) => ctx.assist.activeAction(w, "translate-page"),
    "assist.translateMore": (w) => ctx.assist.activeAction(w, "translate-more"),
    "assist.restorePage": (w) => ctx.assist.restorePage(w),
    "assist.cancel": (w) => ctx.assist.cancel(w),
    "assist.write": (w, request) => {
      const r = text(request, "request", 2000).trim();
      if (r) ctx.assist.writeRequest(w, r);
    },
    "assist.cancelWrite": (w) => ctx.assist.cancelWrite(w),
    "assist.insertWrite": (w, id) => ctx.assist.insertWrite(w, text(id, "message", 128)),
    "assist.copyText": (w, id) => ctx.assist.copyText(w, text(id, "message", 128)),
    "assist.retry": (w, id) => ctx.assist.retry(w, text(id, "message", 128)),
    "assist.editLast": (w, id) => ctx.assist.editLast(w, text(id, "message", 128)),
    "assist.copyPlain": (_w, value) => clipboard.writeText(text(value, "text", 200_000)),
    "assist.compare": (w, tabIds, focus) => {
      if (!Array.isArray(tabIds) || tabIds.length > 50) throw new IpcError("Invalid tabs");
      void ctx.assist.compareTabs(
        w,
        tabIds.map((id) => text(id, "tab", 128)),
        text(focus ?? "", "focus", 600).trim(),
      );
    },
    "assist.closeCompare": (w) => ctx.assist.closeCompare(w),
    "assist.copyComparison": (w, id) => ctx.assist.copyComparison(w, text(id, "message", 128)),
    "assist.clear": (w) => ctx.assist.clear(w),
    "assist.jumpToSection": (w, index) => {
      if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || index > 1000) throw new IpcError("Invalid section");
      return ctx.assist.jumpToSection(w, index);
    },
    "assist.openSettings": (w, section) => w.openSingleton(section === "agents" ? "corvus://settings/#agents" : "corvus://settings/#ai"),
    "assist.approve": (w, decision) => ctx.assist.approve(w, agentDecision(decision)),
    "assist.handBack": (w) => ctx.assist.handBack(w),
    "assist.openUrl": (w, url) => {
      const safe = safeUrl(url);
      if (!safe) throw new IpcError("Invalid address");
      w.createTab(safe, { activate: true });
    },
    "assist.showTab": (w, tabId, url) => ctx.assist.showTab(w, text(tabId, "tab", 128), typeof url === "string" ? url.slice(0, 4096) : undefined),
    "history.list": (w, query) => ctx.assist.historyList(w, typeof query === "string" ? query.slice(0, 200) : ""),
    "history.open": (w, id) => ctx.assist.openConversation(w, text(id, "conversation", 128)),
    "history.remove": (w, id) => ctx.assist.removeConversation(w, text(id, "conversation", 128)),
    "history.clear": (w) => ctx.assist.clearHistory(w),
    "assist.stopRun": (w, runId) => ctx.agentRunner.stopRun(w, text(runId, "run", 128)),
    "agents.pause": (_w, paused) => ctx.agents.setPaused(paused === true),
    "agents.revoke": (_w, client) => ctx.agents.revoke(text(client, "client", 200)),
    "agents.clear": () => ctx.agents.clear(),
    "workflows.run": (w, id, params) => void ctx.flows.replay(w.profile, text(id, "id", 128), paramValues(params)),
    "workflows.update": (w, id, edit) => void ctx.flows.update(w.profile, text(id, "id", 128), edit),
    "workflows.remove": (w, id) => void ctx.flows.remove(w.profile, text(id, "id", 128)),
    "workflows.saveDraft": (w, edit) => void ctx.flows.saveDraft(w.profile, edit),
    "workflows.discardDraft": (w) => void ctx.flows.discardDraft(w.profile),
    "workflows.approve": (w, id, d) => void ctx.flows.approve(w.profile, text(id, "id", 128), flowDecision(d)),
    "workflows.stop": (w, id) => void ctx.flows.stopReplay(w.profile, text(id, "id", 128)),
    "workflows.openManager": (w) => w.openSingleton("corvus://flows/"),
    "memory.removeHint": (w, host, kind, key) => ctx.flows.memory.removeHint(w.profile, text(host, "host", 300), hintKind(kind), text(key, "key", 400)),
    "memory.forget": (w, host) => ctx.flows.memory.forget(w.profile, text(host, "host", 300)),
    "memory.setEnabled": (w, on) => {
      ctx.flows.memory.setEnabled(on === true);
      ctx.assist.refresh(w);
    },
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
