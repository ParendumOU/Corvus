import type { CdpClient, WebScopeEngine } from "@corvus/webscope";
import { WebScopeEngine as Engine } from "@corvus/webscope";
import { app, webContents as allWebContents, type Session, type WebContents } from "electron";
import type { ProfileId } from "@corvus/shared";
import type { InterceptConfig, InterceptEdit } from "@corvus/webscope";
import type { WebScopeInterceptState, WebScopeState } from "../shared/webscope-ipc";
import type { AppContext } from "./context";
import type { ProfileRuntime } from "./profiles";

/** Wraps an Electron webContents debugger as the CdpClient the capture engine consumes. */
function cdpFromDebugger(wc: WebContents): CdpClient {
  const dbg = wc.debugger;
  return {
    send: (method, params) => (dbg.isAttached() ? dbg.sendCommand(method, params ?? {}) : Promise.reject(new Error("debugger detached"))),
    onEvent: (listener) => {
      const handler = (_e: Electron.Event, method: string, params: Record<string, unknown>): void => listener(method, params);
      dbg.on("message", handler);
      return () => dbg.off("message", handler);
    },
    detach: () => {
      try {
        if (dbg.isAttached()) dbg.detach();
      } catch {
        // already detached
      }
    },
  };
}

async function cookieHeader(session: Session, url: string): Promise<string | undefined> {
  try {
    const cookies = await session.cookies.get({ url });
    const header = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    return header || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Attaches a WebScope capture engine to the active profile's browsing when enabled in settings.
 * One engine per profile; the CDP source is each tab's webContents debugger. Scope is enforced by the
 * engine, so capturing everything here is safe — out-of-scope traffic is just recorded as such.
 */
export class WebScopeService {
  private readonly engines = new Map<ProfileId, WebScopeEngine>();
  private readonly detachers = new Map<WebContents, () => void>();

  constructor(private readonly ctx: AppContext) {
    app.on("web-contents-created", (_e, wc) => this.onWebContents(wc));
    ctx.settings.onChange((next, prev) => {
      if (next.webscope.enabled !== prev.webscope.enabled) this.apply();
    });
  }

  private get enabled(): boolean {
    return this.ctx.settings.get().webscope.enabled;
  }

  engineFor(profile: ProfileRuntime): WebScopeEngine {
    let engine = this.engines.get(profile.profile.id);
    if (!engine) {
      engine = new Engine({
        profileId: profile.profile.id,
        maxBodyBytes: this.ctx.settings.get().webscope.maxBodyBytes,
        cookieProvider: (url) => cookieHeader(profile.session, url),
      });
      this.engines.set(profile.profile.id, engine);
    }
    return engine;
  }

  /** The engine for the focused window's profile, or null when WebScope is off. Used by the MCP tools. */
  activeEngine(): WebScopeEngine | null {
    if (!this.enabled) return null;
    const window = this.ctx.windows.focused() ?? this.ctx.windows.all()[0];
    if (!window) return null;
    return this.engineFor(window.profile);
  }

  private onWebContents(wc: WebContents): void {
    if (!this.enabled || this.detachers.has(wc)) return;
    const profile = this.ctx.profiles.bySession(wc.session);
    if (!profile) return;
    const dbg = wc.debugger;
    try {
      if (!dbg.isAttached()) dbg.attach("1.3");
    } catch {
      return; // DevTools (or another consumer) already owns the debugger.
    }
    const engine = this.engineFor(profile);
    const client = cdpFromDebugger(wc);
    const detachCapture = engine.captureFrom(client);
    const detachIntercept = engine.interceptFrom(client);
    const cleanup = (): void => {
      detachCapture();
      detachIntercept();
      try {
        if (dbg.isAttached()) dbg.detach();
      } catch {
        // ignore
      }
      this.detachers.delete(wc);
    };
    wc.once("destroyed", cleanup);
    this.detachers.set(wc, cleanup);
  }

  /** Reconcile attachments with the current setting. */
  apply(): void {
    if (this.enabled) {
      for (const wc of allWebContents.getAllWebContents()) this.onWebContents(wc);
    } else {
      for (const cleanup of [...this.detachers.values()]) cleanup();
    }
  }

  setEnabled(enabled: boolean): WebScopeState {
    this.ctx.settings.update({ webscope: { enabled } });
    this.apply();
    const window = this.ctx.windows.focused() ?? this.ctx.windows.all()[0];
    return window ? this.state(window.profile) : { enabled, scope: this.emptyState().scope, rules: this.emptyState().rules, historySize: 0, attachedTabs: this.detachers.size };
  }

  state(profile: ProfileRuntime): WebScopeState {
    const engine = this.engineFor(profile);
    return {
      enabled: this.enabled,
      scope: engine.getScope(),
      rules: engine.getRules(),
      historySize: engine.history.size(),
      attachedTabs: this.detachers.size,
    };
  }

  private activeProfileEngine(): WebScopeEngine | null {
    const window = this.ctx.windows.focused() ?? this.ctx.windows.all()[0];
    return window ? this.engineFor(window.profile) : null;
  }

  interceptState(): WebScopeInterceptState {
    const engine = this.activeProfileEngine();
    if (!engine) return { config: { enabled: false, interceptRequests: true, interceptResponses: false }, queue: [] };
    return { config: engine.getInterceptConfig(), queue: engine.interceptQueue() };
  }

  async setInterceptConfig(config: InterceptConfig): Promise<WebScopeInterceptState> {
    const engine = this.activeProfileEngine();
    if (engine) await engine.setInterceptConfig(config);
    return this.interceptState();
  }

  async interceptForward(id: string, edit: InterceptEdit | null): Promise<WebScopeInterceptState> {
    const engine = this.activeProfileEngine();
    if (engine) await engine.interceptForward(id, edit ?? undefined);
    return this.interceptState();
  }

  async interceptDrop(id: string): Promise<WebScopeInterceptState> {
    const engine = this.activeProfileEngine();
    if (engine) await engine.interceptDrop(id);
    return this.interceptState();
  }

  private emptyState(): Pick<WebScopeState, "scope" | "rules"> {
    return { scope: { enabled: false, include: [], exclude: [] }, rules: { matchReplace: [], block: [], hostOverride: [] } };
  }

  stop(): void {
    for (const cleanup of [...this.detachers.values()]) cleanup();
    for (const engine of this.engines.values()) engine.detachAll();
  }
}
