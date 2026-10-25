import { describe, expect, it } from "vitest";
import { registerSidePanelApis, type SidePanelAccess } from "../src/main/extension-apis";
import type { RouterCallback } from "../src/main/extensions";
import { effectiveOptions, sidePanelUrl } from "../src/shared/chrome-side-panel";

const EXT = "abcdefghijklmnopabcdefghijklmnop";

describe("chrome.sidePanel helpers", () => {
  it("keeps panel paths inside the extension", () => {
    expect(sidePanelUrl(EXT, "panel.html")).toBe(`chrome-extension://${EXT}/panel.html`);
    expect(sidePanelUrl(EXT, "/ui/side.html?x=1")).toBe(`chrome-extension://${EXT}/ui/side.html?x=1`);
    expect(() => sidePanelUrl(EXT, "https://evil.example/")).toThrow("must be a page of the extension");
    expect(() => sidePanelUrl(EXT, "chrome-extension://otherotherotherotherotherotherot/p.html")).toThrow();
  });

  it("uses the tab's options over the extension's, the manifest's path last", () => {
    expect(effectiveOptions(undefined, undefined, "default.html")).toEqual({ path: "default.html", enabled: true });
    expect(effectiveOptions({ path: "g.html" }, { enabled: false }, "default.html")).toEqual({ path: "g.html", enabled: false });
    expect(effectiveOptions(undefined, { path: "t.html" }, undefined)).toEqual({ path: "t.html", enabled: true });
    expect(effectiveOptions(undefined, undefined, undefined)).toBeNull();
  });
});

function harness(manifestPath: string | null = "panel.html") {
  const opened: Array<{ windowId: number; extensionId: string; url: string }> = [];
  let showing: { windowId: number; extensionId: string } | null = null;
  const closedListeners: Array<(w: number, e: string) => void> = [];
  const access: SidePanelAccess = {
    windowFor: ({ tabId, windowId }) => (tabId === 99 ? undefined : (windowId ?? 1)),
    activeTabId: () => 7,
    manifestPath: () => manifestPath ?? undefined,
    openIn: (w) => (showing && showing.windowId === w ? showing.extensionId : null),
    open: (windowId, extensionId, url) => {
      opened.push({ windowId, extensionId, url });
      showing = { windowId, extensionId };
    },
    close: (windowId) => {
      if (showing?.windowId !== windowId) return;
      const id = showing.extensionId;
      showing = null;
      closedListeners.forEach((l) => l(windowId, id));
    },
    onClosed: (l) => void closedListeners.push(l),
  };
  const handlers = new Map<string, { cb: RouterCallback; permission?: string }>();
  const sent: Array<{ id: string; event: string; args: unknown[] }> = [];
  let activate: RouterCallback = () => "popup";
  registerSidePanelApis(
    {
      handle: (name, cb, permission) => void handlers.set(name, { cb, ...(permission ? { permission } : {}) }),
      emit: () => undefined,
      sendTo: (id, event, ...args) => void sent.push({ id, event, args }),
      intercept: (name, wrap) => {
        if (name === "browserAction.activate") activate = wrap(activate);
      },
    },
    access,
  );
  const call = async (name: string, ...args: unknown[]): Promise<unknown> =>
    handlers.get(`sidePanel.${name}`)!.cb({ type: "frame", extension: { id: EXT } as Electron.Extension }, ...args);
  return { handlers, sent, opened, call, click: () => activate({ type: "frame" }, { extensionId: EXT, tabId: 7 }), showing: () => showing };
}

describe("chrome.sidePanel for extensions", () => {
  it("opens the manifest's page, tells the extension, and closes it", async () => {
    const h = harness();
    expect([...h.handlers.values()].every((x) => x.permission === "sidePanel")).toBe(true);
    await h.call("open", { windowId: 1 });
    expect(h.opened).toEqual([{ windowId: 1, extensionId: EXT, url: `chrome-extension://${EXT}/panel.html` }]);
    await h.call("close", { windowId: 1 });
    expect(h.showing()).toBeNull();
    expect(h.sent.map((s) => s.event)).toEqual(["sidePanel.onOpened", "sidePanel.onClosed"]);
    expect(h.sent[0]!.args[0]).toEqual({ windowId: 1, path: "panel.html" });
  });

  it("keeps options per extension and per tab, and refuses pages outside the extension", async () => {
    const h = harness(null);
    await expect(h.call("open", {})).rejects.toThrow("No active side panel");
    await h.call("setOptions", { path: "global.html" });
    await h.call("setOptions", { tabId: 7, path: "tab.html" });
    expect(await h.call("getOptions", {})).toEqual({ path: "global.html", enabled: true });
    expect(await h.call("getOptions", { tabId: 7 })).toEqual({ tabId: 7, path: "tab.html", enabled: true });
    await expect(h.call("setOptions", { path: "https://evil.example/" })).rejects.toThrow("must be a page of the extension");
    // The active tab (7) has its own page.
    await h.call("open", {});
    expect(h.opened.at(-1)!.url).toBe(`chrome-extension://${EXT}/tab.html`);
    // Disabling it where it shows closes it.
    await h.call("setOptions", { tabId: 7, enabled: false });
    expect(h.showing()).toBeNull();
  });

  it("toggles the panel from the toolbar button only with openPanelOnActionClick", async () => {
    const h = harness();
    expect(await h.click()).toBe("popup");
    await h.call("setPanelBehavior", { openPanelOnActionClick: true });
    expect(await h.call("getPanelBehavior")).toEqual({ openPanelOnActionClick: true });
    await h.click();
    expect(h.showing()).toEqual({ windowId: 1, extensionId: EXT });
    await h.click();
    expect(h.showing()).toBeNull();
  });
});
