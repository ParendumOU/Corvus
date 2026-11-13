import type { TabId } from "@corvus/shared";
import { agentRenderCap, tabsToStopRendering } from "../shared/background-tabs";
import type { AppContext } from "./context";
import type { BrowserWindowCtl } from "./window";

/**
 * The agent tabs that keep painting while hidden (Settings > AI agents, "Let AI agents render pages
 * in the background"), across windows: the ones an agent used most recently, up to a cap that
 * drops when the computer is low on memory. A tab that falls out stops painting until an agent uses
 * it again; a capture of it still works (see BrowserWindowCtl.paintHidden).
 */
export class BackgroundRender {
  private readonly entries = new Map<TabId, { win: BrowserWindowCtl; usedAt: number }>();

  constructor(private readonly ctx: AppContext) {
    ctx.settings.onChange((next, prev) => {
      if (prev.agent.renderInBackground && !next.agent.renderInBackground) this.clear();
    });
  }

  /** An agent opened or acted on the tab: it paints while hidden, and the least recently used ones over the cap stop. */
  use(win: BrowserWindowCtl, id: TabId): void {
    if (!this.ctx.settings.get().agent.renderInBackground || win.isPrivate || !win.hasTab(id)) return;
    const entry = this.entries.get(id);
    this.entries.set(id, { win, usedAt: Math.max(Date.now(), this.newest() + 1) });
    if (!entry) win.setPaintHold(id, "agent", true);
    this.enforce();
  }

  /** The tab stops painting while hidden (no longer an agent's, asleep, or closing). */
  forget(id: TabId): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    this.entries.delete(id);
    entry.win.setPaintHold(id, "agent", false);
  }

  /** The tab moved to another window (dragged there), where it keeps painting. */
  moved(id: TabId, win: BrowserWindowCtl): void {
    const entry = this.entries.get(id);
    if (entry) entry.win = win;
  }

  /** Whether the tab is one of the agent tabs painting while hidden. */
  isRendering(id: TabId): boolean {
    return this.entries.has(id);
  }

  /** The agent tabs painting while hidden, most recently used first. */
  rendering(): TabId[] {
    return [...this.entries].sort((a, b) => b[1].usedAt - a[1].usedAt).map(([id]) => id);
  }

  /** Keeps to the cap (it drops when memory runs low; the tab sleeper calls this on each pass). */
  enforce(): void {
    for (const [id, entry] of this.entries) if (!entry.win.hasTab(id)) this.entries.delete(id);
    const cap = agentRenderCap(this.ctx.tabSleeper.freeShare());
    const stop = tabsToStopRendering(
      [...this.entries].map(([id, e]) => ({ id, usedAt: e.usedAt })),
      cap,
    );
    for (const id of stop) this.forget(id);
  }

  private clear(): void {
    for (const id of [...this.entries.keys()]) this.forget(id);
  }

  /** Two uses in the same millisecond still order by which came last. */
  private newest(): number {
    let max = 0;
    for (const e of this.entries.values()) max = Math.max(max, e.usedAt);
    return max;
  }
}
