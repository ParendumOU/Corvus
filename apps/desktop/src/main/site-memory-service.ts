/**
 * Per-profile site memory (see shared/site-memory.ts). Owned by FlowService (ctx.flows.memory) so
 * workflows and learned hints share one service and the app wiring stays untouched.
 *
 * The on/off switch is the `agent.siteMemory` setting (default on). When off, nothing is learned or
 * injected and the read tools report it; what was already learned is kept until the user forgets it.
 */
import type { SiteMemoryPaneView, SiteMemoryState } from "../shared/flow-ipc";
import { memoryStats, type MemoryHintKind, type SiteMemoryEntry, type TrailEvent } from "../shared/site-memory";
import type { AppContext } from "./context";
import type { ProfileRuntime } from "./profiles";
import { SiteMemoryStore } from "./site-memory-store";

export class SiteMemoryService {
  private readonly stores = new Map<string, SiteMemoryStore>();

  constructor(
    private readonly ctx: AppContext,
    private readonly onChanged: (profileId: string) => void,
  ) {}

  storeFor(runtime: ProfileRuntime): SiteMemoryStore {
    let store = this.stores.get(runtime.profile.id);
    if (!store) {
      store = new SiteMemoryStore(runtime.dataDir);
      this.stores.set(runtime.profile.id, store);
      const id = runtime.profile.id;
      store.onChange(() => this.onChanged(id));
    }
    return store;
  }

  enabled(): boolean {
    return this.ctx.settings?.get().agent.siteMemory !== false;
  }

  setEnabled(on: boolean): void {
    this.ctx.settings.update({ agent: { siteMemory: on } });
  }

  entry(runtime: ProfileRuntime, host: string): SiteMemoryEntry | undefined {
    return host ? this.storeFor(runtime).get(host) : undefined;
  }

  /** Fold a finished Command Bar run into memory (no-op when the setting is off). */
  learn(runtime: ProfileRuntime, trail: readonly TrailEvent[], runOk: boolean): string[] {
    if (!this.enabled() || trail.length === 0) return [];
    return this.storeFor(runtime).learn(trail, runOk);
  }

  noteFailure(runtime: ProfileRuntime, host: string, role: string, name: string): void {
    if (this.enabled()) this.storeFor(runtime).noteFailure(host, role, name);
  }

  /** The Learned tab of the side panel, for one host. */
  paneView(runtime: ProfileRuntime, host: string): SiteMemoryPaneView {
    return {
      enabled: this.enabled(),
      entry: this.entry(runtime, host) ?? null,
      stats: memoryStats(runtime.agentRuns.views(), host),
      totalHosts: this.storeFor(runtime).size,
    };
  }

  /** Everything, for the manager page. */
  state(runtime: ProfileRuntime): SiteMemoryState {
    return { enabled: this.enabled(), entries: this.storeFor(runtime).list(), stats: memoryStats(runtime.agentRuns.views()) };
  }

  removeHint(runtime: ProfileRuntime, host: string, kind: MemoryHintKind, key: string): void {
    this.storeFor(runtime).removeHint(host, kind, key);
  }

  forget(runtime: ProfileRuntime, host: string): void {
    this.storeFor(runtime).forget(host);
  }

  forgetAll(runtime: ProfileRuntime): void {
    this.storeFor(runtime).forgetAll();
  }

  flush(): void {
    for (const s of this.stores.values()) s.flush();
  }
}
