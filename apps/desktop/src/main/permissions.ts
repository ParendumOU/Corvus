import crypto from "node:crypto";
import { desktopCapturer, webContents as allWebContents, type Session, type WebContents } from "electron";
import type { DisplaySourceView, PermissionPromptView, PermissionResponse, SitePermissionView } from "../shared/browser-ipc";
import {
  AGENT_FORBIDDEN,
  decidePermission,
  isRememberable,
  isSecureOrigin,
  kindsForPermission,
  originOf,
  type PermissionDecision,
  type PermissionKind,
  type Verdict,
} from "../shared/permissions";
import type { SiteSettingsStore } from "./site-settings";

/** What the permission layer needs from the window layer (implemented by WindowManager). */
export interface PermissionHost {
  /** The browser tab showing this webContents, if any. Prompts are only shown for tabs. */
  tabFor(wc: WebContents): { agent: boolean } | undefined;
  /** The pending prompt of a tab changed: the window should re-render its state. */
  promptsChanged(wc: WebContents): void;
}

type Resolver = (allowed: boolean, sourceId?: string) => void;

interface PendingPrompt {
  id: string;
  wc: WebContents;
  origin: string;
  kinds: PermissionKind[];
  agent: boolean;
  sources?: DisplaySourceView[];
  resolvers: Resolver[];
}

const sameKinds = (a: readonly PermissionKind[], b: readonly PermissionKind[]): boolean =>
  a.length === b.length && a.every((k) => b.includes(k));

/**
 * Site permissions for one profile session. Requests go through the pure decision table; what it
 * cannot decide becomes a prompt rendered by the chrome UI of the tab's window (never inside web
 * content). Remembered decisions live in the profile's SiteSettingsStore; answers given without
 * "remember" (and every answer in an agent tab) last until the tab navigates away.
 */
export class PermissionManager {
  private pending: PendingPrompt[] = [];
  private readonly temporary = new Map<number, Map<string, PermissionDecision>>();
  private readonly watched = new Set<number>();

  constructor(
    private readonly store: SiteSettingsStore,
    private readonly host: PermissionHost,
  ) {}

  install(session: Session): void {
    session.setPermissionRequestHandler((wc, permission, callback, details) => {
      const mediaTypes = "mediaTypes" in details ? details.mediaTypes : undefined;
      const origin = originOf(details.requestingUrl);
      const topOrigin = details.isMainFrame || !wc || wc.isDestroyed() ? origin : originOf(wc.getURL()) || origin;
      this.request(wc, origin, topOrigin, kindsForPermission(permission, mediaTypes), (allowed) => callback(allowed));
    });
    session.setPermissionCheckHandler((wc, permission, requestingOrigin, details) => {
      const mediaTypes =
        permission === "media" ? (details.mediaType === "video" || details.mediaType === "audio" ? [details.mediaType] : ["video", "audio"]) : undefined;
      const origin = originOf(requestingOrigin);
      const topOrigin = details.embeddingOrigin ? originOf(details.embeddingOrigin) : origin;
      return this.decide(wc, origin, topOrigin, kindsForPermission(permission, mediaTypes)).action === "allow";
    });
    session.setDisplayMediaRequestHandler((request, callback) => {
      const deny = (): void => {
        try {
          callback(null);
        } catch {
          // The requesting frame is already gone.
        }
      };
      const wc = request.frame ? allWebContents.fromFrame(request.frame) : undefined;
      if (!wc) return deny();
      const origin = originOf(request.securityOrigin || request.frame?.url || "");
      const topOrigin = originOf(wc.getURL()) || origin;
      const verdict = this.decide(wc, origin, topOrigin, ["display-capture"]);
      const tab = this.host.tabFor(wc);
      if (verdict.action !== "prompt" || !tab) return deny();
      desktopCapturer
        .getSources({ types: ["screen", "window"], thumbnailSize: { width: 0, height: 0 } })
        .then((sources) => {
          if (sources.length === 0) return deny();
          const views: DisplaySourceView[] = sources.map((s) => ({ id: s.id, name: s.name, kind: s.id.startsWith("screen:") ? "screen" : "window" }));
          this.enqueue(wc, origin, ["display-capture"], tab.agent, views, (allowed, sourceId) => {
            const source = allowed ? (sources.find((s) => s.id === sourceId) ?? sources[0]) : undefined;
            if (!source) return deny();
            try {
              callback({ video: { id: source.id, name: source.name } });
            } catch {
              // The requesting frame is already gone.
            }
          });
        })
        .catch(deny);
    });
  }

  private decide(wc: WebContents | null | undefined, origin: string, topOrigin: string, kinds: PermissionKind[]): Verdict {
    const live = wc && !wc.isDestroyed() ? wc : undefined;
    const temp = live ? this.temporary.get(live.id) : undefined;
    return decidePermission({
      kinds,
      origin,
      topOrigin,
      agent: live ? (this.host.tabFor(live)?.agent ?? false) : false,
      lookup: (kind) => ({ persistent: this.store.permission(origin, kind), temporary: temp?.get(`${origin}|${kind}`) }),
    });
  }

  /** Decide a request now, or queue a prompt for the tab. */
  private request(wc: WebContents | null | undefined, origin: string, topOrigin: string, kinds: PermissionKind[], done: (allowed: boolean) => void): void {
    const verdict = this.decide(wc, origin, topOrigin, kinds);
    if (verdict.action !== "prompt") return done(verdict.action === "allow");
    const tab = wc && !wc.isDestroyed() ? this.host.tabFor(wc) : undefined;
    if (!wc || !tab) return done(false);
    this.enqueue(wc, origin, verdict.kinds, tab.agent, undefined, (allowed) => done(allowed));
  }

  private enqueue(wc: WebContents, origin: string, kinds: PermissionKind[], agent: boolean, sources: DisplaySourceView[] | undefined, resolve: Resolver): void {
    const existing = sources
      ? undefined
      : this.pending.find((p) => p.wc === wc && p.origin === origin && !p.sources && sameKinds(p.kinds, kinds));
    if (existing) {
      existing.resolvers.push(resolve);
      return;
    }
    this.watch(wc);
    this.pending.push({ id: crypto.randomUUID(), wc, origin, kinds, agent, ...(sources ? { sources } : {}), resolvers: [resolve] });
    this.host.promptsChanged(wc);
  }

  /** Forget per-page answers and deny open prompts when the tab navigates away or closes. */
  private watch(wc: WebContents): void {
    if (this.watched.has(wc.id)) return;
    this.watched.add(wc.id);
    const id = wc.id;
    const reset = (): void => {
      this.temporary.delete(id);
      const dropped = this.pending.filter((p) => p.wc === wc);
      if (dropped.length === 0) return;
      this.pending = this.pending.filter((p) => p.wc !== wc);
      for (const p of dropped) for (const r of p.resolvers) r(false);
      if (!wc.isDestroyed()) this.host.promptsChanged(wc);
    };
    wc.on("did-navigate", reset);
    wc.once("destroyed", () => {
      reset();
      this.watched.delete(id);
    });
  }

  /** A tab can be taken over by an agent while a prompt is open, so this is checked live. */
  private isAgent(p: PendingPrompt): boolean {
    return p.agent || (!p.wc.isDestroyed() && this.host.tabFor(p.wc)?.agent === true);
  }

  promptFor(wc: WebContents): PermissionPromptView | null {
    const p = this.pending.find((x) => x.wc === wc);
    if (!p) return null;
    const agent = this.isAgent(p);
    return {
      id: p.id,
      origin: p.origin,
      kinds: [...p.kinds],
      agent,
      rememberable: !agent && p.kinds.every(isRememberable),
      ...(p.sources ? { sources: p.sources } : {}),
    };
  }

  /**
   * Answer a prompt. `owns` lets the caller restrict answers to its own tabs (a window's chrome UI
   * may only answer prompts of tabs in that window). Returns false for unknown prompts.
   */
  respond(id: string, response: PermissionResponse, remember: boolean, sourceId: string | undefined, owns: (wc: WebContents) => boolean): boolean {
    const prompt = this.pending.find((p) => p.id === id);
    if (!prompt || prompt.wc.isDestroyed() || !owns(prompt.wc)) return false;
    this.pending = this.pending.filter((p) => p !== prompt);
    const agent = this.isAgent(prompt);
    const forbidden = agent && prompt.kinds.some((k) => AGENT_FORBIDDEN.has(k));
    if (response !== "dismiss" && !forbidden) {
      for (const kind of prompt.kinds) {
        if (remember && !agent && isRememberable(kind)) this.store.setPermission(prompt.origin, kind, response);
        else if (isRememberable(kind)) this.setTemporary(prompt.wc, prompt.origin, kind, response);
      }
    }
    const allowed = response === "allow" && !forbidden;
    for (const r of prompt.resolvers) r(allowed, sourceId);

    // Other prompts of the same tab may now be decided by this answer.
    for (const other of this.pending.filter((p) => p.wc === prompt.wc && !p.sources)) {
      const verdict = this.decide(other.wc, other.origin, other.origin, other.kinds);
      if (verdict.action === "prompt") continue;
      this.pending = this.pending.filter((p) => p !== other);
      for (const r of other.resolvers) r(verdict.action === "allow");
    }
    this.host.promptsChanged(prompt.wc);
    return true;
  }

  private setTemporary(wc: WebContents, origin: string, kind: PermissionKind, decision: PermissionDecision): void {
    let map = this.temporary.get(wc.id);
    if (!map) {
      map = new Map();
      this.temporary.set(wc.id, map);
    }
    map.set(`${origin}|${kind}`, decision);
  }

  /** Permissions shown in the site info popover: remembered ones plus answers for this page. */
  siteView(wc: WebContents, url: string): { origin: string; secure: boolean; permissions: SitePermissionView[] } {
    const origin = originOf(url);
    const stored = this.store.permissionsFor(origin);
    const views = new Map<PermissionKind, SitePermissionView>();
    for (const [kind, decision] of Object.entries(stored) as Array<[PermissionKind, PermissionDecision]>) {
      views.set(kind, { kind, decision, temporary: false });
    }
    for (const [key, decision] of this.temporary.get(wc.id) ?? []) {
      const [keyOrigin, kind] = key.split("|") as [string, PermissionKind];
      if (keyOrigin === origin) views.set(kind, { kind, decision, temporary: true });
    }
    return { origin, secure: isSecureOrigin(origin), permissions: [...views.values()] };
  }

  /** Change a site's permission from the site info popover; also drops the per-page answer. */
  setSitePermission(wc: WebContents, url: string, kind: PermissionKind, decision: PermissionDecision | null): void {
    const origin = originOf(url);
    this.temporary.get(wc.id)?.delete(`${origin}|${kind}`);
    this.store.setPermission(origin, kind, decision);
  }

  resetSite(wc: WebContents, url: string): void {
    const origin = originOf(url);
    const temp = this.temporary.get(wc.id);
    for (const key of [...(temp?.keys() ?? [])]) if (key.startsWith(`${origin}|`)) temp?.delete(key);
    this.store.resetPermissions(origin);
  }
}
