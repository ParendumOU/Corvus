/**
 * The live page of each tab, for the toolbar and the menu: back, forward, reload, stop, running a
 * script in it. Registered by components/browser/web-page.tsx while the tab's WebView is mounted.
 */
export interface PageHandle {
  goBack(): void;
  goForward(): void;
  reload(): void;
  stopLoading(): void;
  injectJavaScript(script: string): void;
}

const views = new Map<string, PageHandle>();

export function registerPage(tabId: string, handle: PageHandle | null): void {
  if (handle) views.set(tabId, handle);
  else views.delete(tabId);
}

export function pageOf(tabId: string | null | undefined): PageHandle | null {
  return tabId ? (views.get(tabId) ?? null) : null;
}
