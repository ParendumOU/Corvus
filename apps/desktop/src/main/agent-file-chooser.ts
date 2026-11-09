/**
 * A page's file chooser while an AI agent acts in its tab. The system's file window is one the agent
 * cannot see or answer, and it would be left open in front of the person, so for a few seconds after
 * each agent click or key press the tab's DevTools protocol catches the chooser instead. The agent
 * then answers it with upload_file. The rest of the time the person's own clicks open the system's
 * window as usual. A chooser opened in a cross-site frame is not caught: it opens the system's window.
 */
import type { WebContents } from "electron";
import { resolveMcpAccessLevel, type Settings } from "../shared/settings";
import { COMMAND_BAR_CLIENT } from "./agent-credential-policy";

/** Whether `client` has a way to answer a file chooser: otherwise the person's system window opens, as before. */
export function canAnswerFileChooser(settings: Pick<Settings, "mcp">, client: string): boolean {
  return client === COMMAND_BAR_CLIENT || resolveMcpAccessLevel(settings.mcp) === "full";
}

export interface OpenFileChooser {
  /** The file input that opened it; null for a picker without one (showOpenFilePicker). */
  backendNodeId: number | null;
  multiple: boolean;
}

const ARMED_MS = 8_000;

export class AgentFileChoosers {
  private readonly watched = new WeakSet<WebContents>();
  private readonly armed = new Map<WebContents, NodeJS.Timeout>();
  private readonly open = new Map<WebContents, OpenFileChooser>();

  /** Catches the tab's file choosers for the next few seconds. A tab that cannot be debugged keeps the system's window. */
  async arm(wc: WebContents): Promise<void> {
    if (wc.isDestroyed()) return;
    try {
      const dbg = wc.debugger;
      if (!dbg.isAttached()) dbg.attach("1.3");
      this.watch(wc);
      if (!this.armed.has(wc)) {
        await dbg.sendCommand("Page.enable");
        await dbg.sendCommand("Page.setInterceptFileChooserDialog", { enabled: true });
      }
      clearTimeout(this.armed.get(wc));
      this.armed.set(
        wc,
        setTimeout(() => void this.disarm(wc), ARMED_MS),
      );
    } catch {
      this.armed.delete(wc);
    }
  }

  /** The chooser waiting for an answer in this tab. */
  pending(wc: WebContents): OpenFileChooser | null {
    return this.open.get(wc) ?? null;
  }

  /** Puts the files on the input that opened the chooser, which ends it. */
  async answer(wc: WebContents, chooser: OpenFileChooser, paths: string[]): Promise<void> {
    await wc.debugger.sendCommand("DOM.setFileInputFiles", { files: paths, backendNodeId: chooser.backendNodeId });
    this.open.delete(wc);
  }

  private watch(wc: WebContents): void {
    if (this.watched.has(wc)) return;
    this.watched.add(wc);
    wc.debugger.on("message", (_event, method, params) => {
      if (method === "Page.fileChooserOpened") {
        this.open.set(wc, { backendNodeId: typeof params.backendNodeId === "number" ? params.backendNodeId : null, multiple: params.mode === "selectMultiple" });
      } else if (method === "Page.frameNavigated" && !params.frame?.parentId) {
        this.open.delete(wc);
      }
    });
    wc.debugger.on("detach", () => this.forget(wc));
    wc.once("destroyed", () => this.forget(wc));
  }

  private async disarm(wc: WebContents): Promise<void> {
    this.armed.delete(wc);
    if (wc.isDestroyed() || !wc.debugger.isAttached()) return;
    await wc.debugger.sendCommand("Page.setInterceptFileChooserDialog", { enabled: false }).catch(() => undefined);
  }

  private forget(wc: WebContents): void {
    clearTimeout(this.armed.get(wc));
    this.armed.delete(wc);
    this.open.delete(wc);
  }
}
