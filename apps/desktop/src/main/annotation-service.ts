import type { TabId } from "@corvus/shared";
import { isAnnotatableUrl } from "../shared/annotations";
import { ANNOTATION_APPLY_CHANNEL, type AnnotationApplyMessage } from "../shared/annotations-ipc";
import type { AppContext } from "./context";
import type { ProfileRuntime } from "./profiles";
import { pageOf } from "./tab-page";
import type { BrowserWindowCtl, TabRuntime } from "./window";

/**
 * Re-applies saved highlights/notes to web pages and bridges the in-page selection toolbar to the
 * per-profile AnnotationStore. All DOM work happens in the tab preload (isolated world); this service
 * only reads/writes the store and tells the preload what to render. Nothing is persisted without an
 * explicit user action, re-validated against the sending tab in ipc-annotations.ts.
 */
export class AnnotationService {
  /** Tab -> annotation id to scroll into view once the page loads (set by the manager's "jump to page"). */
  private readonly pendingScroll = new Map<TabId, string>();

  constructor(private readonly ctx: AppContext) {}

  /** A web page finished loading: send it its saved annotations so the preload can re-anchor them. */
  onPageLoad(win: BrowserWindowCtl, tab: TabRuntime): void {
    this.applyTo(win.profile, tab);
  }

  forgetTab(id: TabId): void {
    this.pendingScroll.delete(id);
  }

  /** Re-render every loaded tab of a profile (after a create/edit/delete or a remote sync apply). */
  reapplyProfile(profileId: string): void {
    for (const win of this.ctx.windows.forProfile(profileId)) {
      for (const tab of win.tabRuntimes()) this.applyTo(win.profile, tab);
    }
  }

  /** Open an annotation's page in a new tab and scroll to that highlight once it loads. */
  openAnnotation(win: BrowserWindowCtl, id: string): void {
    const item = win.profile.annotations.get(id);
    if (!item) return;
    const tab = win.createTab(item.url, { activate: true });
    this.pendingScroll.set(tab.id, id);
  }

  private applyTo(profile: ProfileRuntime, tab: TabRuntime): void {
    const wc = pageOf(tab.view);
    if (!wc) return;
    const url = wc.getURL();
    if (!isAnnotatableUrl(url)) return;
    const scrollToId = this.pendingScroll.get(tab.id);
    this.pendingScroll.delete(tab.id);
    const message: AnnotationApplyMessage = {
      annotations: profile.annotations.forUrl(url),
      ...(scrollToId ? { scrollToId } : {}),
    };
    wc.send(ANNOTATION_APPLY_CHANNEL, message);
  }
}
