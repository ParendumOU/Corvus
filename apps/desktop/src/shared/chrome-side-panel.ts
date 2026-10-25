/**
 * chrome.sidePanel paths and options. Pure, for the main process and the tests.
 */
export interface SidePanelOptions {
  path?: string;
  enabled?: boolean;
}

/** An extension-relative side panel path as a URL inside that extension; throws for anything else. */
export function sidePanelUrl(extensionId: string, pathOrUrl: string): string {
  const url = new URL(pathOrUrl, `chrome-extension://${extensionId}/`);
  if (url.protocol !== "chrome-extension:" || url.host !== extensionId) throw new Error("The side panel path must be a page of the extension.");
  return url.href;
}

/** The options in force for a tab: its own over the extension's, the manifest's path last. */
export function effectiveOptions(global: SidePanelOptions | undefined, tab: SidePanelOptions | undefined, manifestPath: string | undefined): Required<SidePanelOptions> | null {
  const path = tab?.path ?? global?.path ?? manifestPath;
  const enabled = tab?.enabled ?? global?.enabled ?? true;
  return path ? { path, enabled } : null;
}
