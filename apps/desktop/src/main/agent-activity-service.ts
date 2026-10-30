import crypto from "node:crypto";
import { nativeTheme, type Rectangle, type WebContents } from "electron";
import type { McpToolResultEvent, TabId } from "@corvus/shared";
import {
  assertAgentsRunning,
  initialAgentActivity,
  overlayCaption,
  reduceAgentActivity,
  type AgentActivityAction,
  type AgentActivityState,
  type OverlayAction,
} from "../shared/agent-activity";
import type { AgentActivityView } from "../shared/assist-ipc";
import { AgentOverlayView } from "./assist-views";
import { describeRefScript, type RefBox } from "./assist-scripts";
import type { AppContext } from "./context";
import { AGENT_WORLD_ID } from "./page-scripts";
import type { BrowserWindowCtl } from "./window";

export type AgentStep =
  | { kind: "click"; ref: string }
  | { kind: "type"; ref: string; text: string }
  | { kind: "navigate"; url: string }
  | { kind: "scroll"; direction: "up" | "down" }
  | { kind: "read" }
  | { kind: "screenshot" }
  /** A coordinate action at viewport CSS px (click_at, hover_at, scroll_at). */
  | { kind: "point"; x: number; y: number; label: string; action: "click" | "hover" | "scroll" }
  | { kind: "key"; key: string };

/** Half the side of the ring drawn around a coordinate target, in DIPs. */
const POINT_RING = 12;

/** How long the cursor takes to glide to its target; the real input waits for it. */
const POINTER_TRAVEL_MS = 480;
/** The overlay stays up this long after the last action. */
const OVERLAY_HOLD_MS = 2200;
/** The toolbar shows the agent as active this long after the last action. */
const ACTIVE_MS = 4000;
/** An agent's input can land a moment after its tool call ended. */
const QUIET_AFTER_CALL_MS = 500;
/** A call that never reported its result stops counting after this long. */
const STALE_CALL_MS = 5 * 60_000;

const callKey = (event: { client: string; tool: string; at: number }): string => `${event.client}|${event.tool}|${event.at}`;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * MCP agent activity: timeline + clients (fed by the MCP server hooks), the pause switch, and the
 * per-window overlay that shows what the agent is doing in the page.
 */
export class AgentActivityService {
  private state: AgentActivityState = initialAgentActivity();
  private readonly overlays = new WeakMap<BrowserWindowCtl, AgentOverlayView>();
  private readonly contentBounds = new WeakMap<BrowserWindowCtl, Rectangle>();
  private readonly lastActive = new WeakMap<BrowserWindowCtl, number>();
  private readonly listeners = new Set<() => void>();
  private notifyTimer: NodeJS.Timeout | null = null;
  private lastClient = "AI agent";
  /** Tool calls under way (callKey -> start), so input in a page can be told from the agent's own. */
  private readonly inFlight = new Map<string, number>();
  private quietUntil = 0;

  constructor(private readonly ctx: AppContext) {}

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private dispatch(action: AgentActivityAction): void {
    const next = reduceAgentActivity(this.state, action);
    if (next === this.state) return;
    this.state = next;
    if (this.notifyTimer) return;
    this.notifyTimer = setTimeout(() => {
      this.notifyTimer = null;
      for (const l of this.listeners) l();
    }, 60);
  }

  get paused(): boolean {
    return this.state.paused;
  }

  /** Name of the agent client that made the latest tool call (for approval prompts). */
  get currentClient(): string {
    return this.lastClient;
  }

  view(): AgentActivityView {
    return { paused: this.state.paused, calls: this.state.calls, clients: this.state.clients, mcpRunning: this.ctx.mcp.isRunning() };
  }

  /** MCP onToolCall hook. Throws while paused, which fails the tool call. */
  toolCall(event: { client: string; tool: string; args: unknown; at: number }): void {
    this.inFlight.set(callKey(event), event.at);
    this.dispatch({ type: "call", id: crypto.randomUUID(), client: event.client, tool: event.tool, args: event.args, at: event.at });
    assertAgentsRunning(this.state);
    this.lastClient = event.client;
  }

  toolResult(event: McpToolResultEvent): void {
    this.inFlight.delete(callKey(event));
    this.quietUntil = Date.now() + QUIET_AFTER_CALL_MS;
    this.dispatch({ type: "result", ...event });
  }

  clientConnected(client: string, allowed: boolean): void {
    this.dispatch({ type: "connect", client, at: Date.now(), allowed });
  }

  setPaused(paused: boolean): void {
    this.dispatch({ type: "pause", paused });
    if (paused) for (const w of this.ctx.windows.all()) this.overlays.get(w)?.hide();
    this.ctx.windows.broadcastState();
  }

  revoke(client: string): void {
    this.ctx.mcp.revokeClient(client);
    this.dispatch({ type: "revoke", client });
  }

  clear(): void {
    this.dispatch({ type: "clear" });
  }

  /** An agent's tool call is under way or just ended: input arriving now may be the agent's own. */
  acting(): boolean {
    const now = Date.now();
    for (const [key, at] of this.inFlight) if (now - at > STALE_CALL_MS) this.inFlight.delete(key);
    return this.inFlight.size > 0 || now < this.quietUntil;
  }

  isActive(win: BrowserWindowCtl): boolean {
    return Date.now() - (this.lastActive.get(win) ?? 0) < ACTIVE_MS;
  }

  // ------------------------------------------------------------- overlay

  layout(win: BrowserWindowCtl, content: Rectangle): void {
    this.contentBounds.set(win, content);
    this.overlays.get(win)?.layout(content);
  }

  disposeWindow(win: BrowserWindowCtl): void {
    this.overlays.get(win)?.dispose();
    this.overlays.delete(win);
  }

  /** Overlay view that sent an IPC message, if any (the dismiss channel). */
  dismissFrom(sender: WebContents): void {
    for (const w of this.ctx.windows.all()) {
      const overlay = this.overlays.get(w);
      if (overlay?.webContents === sender) overlay.hide();
    }
  }

  overlayFor(win: BrowserWindowCtl): AgentOverlayView {
    let overlay = this.overlays.get(win);
    if (!overlay) {
      overlay = new AgentOverlayView(win.win, () => win.chrome);
      this.overlays.set(win, overlay);
      const bounds = this.contentBounds.get(win);
      if (bounds) overlay.layout(bounds);
    }
    return overlay;
  }

  /**
   * Shows the step in the tab before the controller performs it. Only for the visible tab of a
   * visible window; background work stays silent. Resolves once the cursor reached its target.
   */
  async beforeAction(win: BrowserWindowCtl, tabId: TabId, wc: WebContents, step: AgentStep): Promise<void> {
    this.lastActive.set(win, Date.now());
    win.pushState();
    if (win.activeTab()?.id !== tabId || !win.win.isVisible() || win.win.isMinimized() || wc.isDestroyed()) return;
    let box: RefBox | null = null;
    if (step.kind === "click" || step.kind === "type") {
      box = await (wc.executeJavaScriptInIsolatedWorld(AGENT_WORLD_ID, [{ code: describeRefScript(step.ref) }]) as Promise<RefBox | null>).catch(() => null);
      // Also when the tab closed meanwhile: the step itself finds it gone.
      if (!box || wc.isDestroyed()) return;
    }
    const zoom = wc.getZoomFactor();
    if (step.kind === "point" || step.kind === "key") {
      const action: OverlayAction =
        step.kind === "key" ? { kind: "key", key: step.key } : step.action === "click" ? { kind: "click", label: step.label } : { kind: "hover", label: step.label };
      const target =
        step.kind === "point" ? { x: step.x * zoom - POINT_RING, y: step.y * zoom - POINT_RING, width: POINT_RING * 2, height: POINT_RING * 2 } : null;
      const kind = step.kind === "key" ? "type" : step.action === "click" ? "click" : "scroll";
      this.overlayFor(win).show({ type: "act", caption: overlayCaption(this.lastClient, action), target, kind, dark: nativeTheme.shouldUseDarkColors }, OVERLAY_HOLD_MS);
      if (target) await sleep(POINTER_TRAVEL_MS);
      return;
    }
    const action: OverlayAction =
      step.kind === "click"
        ? { kind: "click", label: box?.label ?? "" }
        : step.kind === "type"
          ? { kind: "type", label: box?.label ?? "", text: step.text, secret: box?.secret ?? false }
          : step.kind === "navigate"
            ? { kind: "navigate", url: step.url }
            : step.kind === "scroll"
              ? { kind: "scroll", direction: step.direction }
              : { kind: step.kind };
    const target = box ? { x: box.x * zoom, y: box.y * zoom, width: box.width * zoom, height: box.height * zoom } : null;
    this.overlayFor(win).show(
      { type: "act", caption: overlayCaption(this.lastClient, action), target, kind: step.kind, dark: nativeTheme.shouldUseDarkColors },
      OVERLAY_HOLD_MS,
    );
    if (target) await sleep(POINTER_TRAVEL_MS);
  }
}
