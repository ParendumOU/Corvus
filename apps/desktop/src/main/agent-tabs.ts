import type { GroupId, Tab, TabId } from "@corvus/shared";
import type { AgentLeftTab } from "../shared/command-bar-ipc";
import { isNewTabUrl, NEW_TAB_URL } from "../shared/internal-urls";
import { agentGroupTitle, agentTabLine } from "../shared/agent-tabs";
import type { AppContext } from "./context";
import type { RunTabsHandle } from "./agent-tools";
import { CertificateError, type CertErrorPolicy } from "./controller";
import { pageOf } from "./tab-page";
import type { BrowserWindowCtl } from "./window";

/**
 * The tabs of one interactive agent run (Command Bar or Assist), in the run's window. Each tab the
 * agent opens joins one group named after the task, so the person sees where it works; the agent
 * moves between its tabs, closes the ones that led nowhere, and the rest stay open for the person
 * when the run ends. The tab an Assist run started in is the person's: it is never grouped or closed.
 */
export class RunTabs implements RunTabsHandle {
  private readonly own = new Set<TabId>();
  private groupId_: GroupId | null = null;
  private title: string;
  /** The Command Bar's fresh tab, while it still shows the New Tab page. */
  private blank: TabId | null = null;

  constructor(
    private readonly ctx: AppContext,
    private readonly win: BrowserWindowCtl,
    task: string,
    private readonly start: TabId | null,
  ) {
    this.title = agentGroupTitle(task);
  }

  /** The Command Bar's own tab: the first open_tab loads there instead of leaving it empty. */
  adopt(id: TabId, opts: { groupNow?: boolean } = {}): void {
    this.own.add(id);
    this.blank = id;
    if (opts.groupNow) this.group();
  }

  /** The run's tab group, once it has one. */
  get groupId(): GroupId | null {
    return this.groupId_;
  }

  async open(url: string, name: string, certs: CertErrorPolicy = "refuse"): Promise<Tab> {
    if (name.trim()) this.title = agentGroupTitle("", name);
    const blank = this.takeBlank();
    if (blank) {
      const tab = await this.ctx.controller.navigate(blank, url, certs);
      this.group();
      return tab;
    }
    const grouped = this.groupId_ && this.win.hasGroup(this.groupId_) ? this.groupId_ : null;
    const fresh = this.win.createTab(NEW_TAB_URL, { activate: this.watched(), agent: true, ...(grouped ? { groupId: grouped } : {}) });
    this.own.add(fresh.id);
    this.group();
    try {
      return await this.ctx.controller.navigate(fresh.id, url, certs);
    } catch (err) {
      // A certificate error waits there for the person's choice (Proceed or Back to safety).
      if (err instanceof CertificateError) throw err;
      this.own.delete(fresh.id);
      if (this.win.hasTab(fresh.id)) this.win.closeTab(fresh.id);
      throw err;
    }
  }

  switchTo(id: TabId): Tab {
    if (!this.mayUse(id)) throw new Error(`Tab ${id} is not one of your tabs. Use list_tabs: your tabs are marked "yours".`);
    const found = this.ctx.windows.findTab(id);
    if (!found) throw new Error(`Tab ${id} is closed.`);
    if (this.watched()) found.window.activate(id);
    return found.window.toTab(found.tab);
  }

  /** Closes one of the run's tabs; returns the tab to work in next (null: none left). */
  close(id: TabId, working: TabId | null): TabId | null {
    if (id === this.start || !this.isOwn(id)) throw new Error(`Tab ${id} is not one you opened; only close your own tabs.`);
    const found = this.ctx.windows.findTab(id);
    if (!found) throw new Error(`Tab ${id} is already closed.`);
    if (found.window.tabIds().length <= 1) throw new Error("This is the window's last tab; leave it open.");
    this.own.delete(id);
    if (this.blank === id) this.blank = null;
    found.window.closeTab(id);
    if (working !== id && working && this.ctx.windows.findTab(working)) return working;
    const next = [...this.own].reverse().find((t) => this.ctx.windows.findTab(t)) ?? (this.start && this.ctx.windows.findTab(this.start) ? this.start : null);
    if (next && this.watched()) this.ctx.windows.findTab(next)?.window.activate(next);
    return next;
  }

  list(working: TabId | null): string {
    return this.ctx.windows
      .regular()
      .flatMap((w) => w.listTabs())
      .map((t) => agentTabLine(t, { working: t.id === working, own: this.isOwn(t.id), start: t.id === this.start }))
      .join("\n");
  }

  /**
   * End of the run: the tabs it leaves open are the person's now (no agent badge or agent rules).
   * Returns them, so the panel can offer them; an untouched New Tab page is not worth offering.
   */
  release(): AgentLeftTab[] {
    if (this.groupId_) this.win.setAgentGroup(this.groupId_, false);
    const left: AgentLeftTab[] = [];
    for (const id of this.ownOpen()) {
      const found = this.ctx.windows.findTab(id);
      if (!found) continue;
      found.window.clearAgentMark(id);
      if (this.isBlank(id)) continue;
      const tab = found.window.toTab(found.tab);
      left.push({ id, title: tab.title, url: tab.url });
    }
    return left;
  }

  /**
   * The person is looking at the run: one of its tabs, or the tab it started in, is on screen. Then
   * the tabs it opens or moves to come to the front; once the person has gone to another tab, it
   * works in the background (the Assist panel shows it live) instead of pulling them back.
   */
  private watched(): boolean {
    const active = this.win.activeTab()?.id;
    return !active || active === this.start || this.isOwn(active);
  }

  private mayUse(id: TabId): boolean {
    return id === this.start || this.isOwn(id);
  }

  /** A tab the run opened, or one its pages opened (window.open lands in the same group). */
  owns(id: TabId): boolean {
    return this.isOwn(id);
  }

  private isOwn(id: TabId): boolean {
    if (this.own.has(id)) return true;
    return this.groupId_ !== null && this.win.hasTab(id) && this.win.groupOf(id) === this.groupId_;
  }

  private ownOpen(): TabId[] {
    const ids = new Set([...this.own].filter((id) => this.ctx.windows.findTab(id)));
    if (this.groupId_) for (const id of this.win.tabIds()) if (this.win.groupOf(id) === this.groupId_) ids.add(id);
    return [...ids];
  }

  private isBlank(id: TabId): boolean {
    const wc = pageOf(this.ctx.windows.findTab(id)?.tab.view);
    return Boolean(wc && isNewTabUrl(wc.getURL() || NEW_TAB_URL));
  }

  private takeBlank(): TabId | null {
    const id = this.blank;
    this.blank = null;
    return id && this.isBlank(id) ? id : null;
  }

  /** Puts the run's open tabs in this window into its group (created on first use). */
  private group(): void {
    const ids = [...this.own].filter((id) => this.win.hasTab(id));
    if (ids.length === 0) return;
    if (this.groupId_ && this.win.hasGroup(this.groupId_)) {
      const loose = ids.filter((id) => this.win.groupOf(id) !== this.groupId_);
      if (loose.length > 0) this.win.addToGroup(loose, this.groupId_);
      if (this.win.listGroups().find((g) => g.id === this.groupId_)?.title !== this.title) this.win.updateGroup(this.groupId_, { title: this.title });
      return;
    }
    this.groupId_ = this.win.createGroup(ids, { title: this.title })?.id ?? null;
    if (this.groupId_) this.win.setAgentGroup(this.groupId_, true);
  }
}
