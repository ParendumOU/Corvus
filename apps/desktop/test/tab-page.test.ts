import { describe, expect, it, vi } from "vitest";
import type { WebContents } from "electron";
import type { AppContext } from "../src/main/context";
import { ReaderService } from "../src/main/reader-service";
import { pageOf, pageUrl } from "../src/main/tab-page";
import { TranslateService } from "../src/main/translate-service";
import type { BrowserWindowCtl, TabRuntime } from "../src/main/window";
import { defaultSettings } from "../src/shared/settings";

vi.mock("electron", () => ({ app: { getLocale: () => "en-US" } }));

interface FakePage {
  url: string;
  destroyed: boolean;
  /** What the page answers to a script (the reader probe, the language read). */
  answer: () => Promise<unknown>;
}

function fakePage(url: string, answer: () => Promise<unknown> = async () => null): FakePage & { wc: WebContents } {
  const page: FakePage = { url, destroyed: false, answer };
  const wc = {
    isDestroyed: () => page.destroyed,
    getURL: () => {
      if (page.destroyed) throw new Error("Object has been destroyed");
      return page.url;
    },
    executeJavaScriptInIsolatedWorld: () => page.answer(),
  } as unknown as WebContents;
  return Object.assign(page, { wc });
}

/** A tab as the window keeps it; `close()` does what Electron does to a closed page. */
function fakeTab(page: { wc: WebContents; destroyed: boolean } | null, url = "https://example.com/article") {
  const view = { webContents: page?.wc as WebContents };
  const tab = { id: "t1", url, view } as unknown as TabRuntime;
  return {
    tab,
    close(): void {
      if (page) page.destroyed = true;
      (view as { webContents: WebContents | undefined }).webContents = undefined;
    },
  };
}

function fakeWindow(isOpen: () => boolean): BrowserWindowCtl & { pushes: number } {
  const win = {
    pushes: 0,
    hasTab: () => isOpen(),
    pushState() {
      win.pushes++;
    },
  };
  return win as unknown as BrowserWindowCtl & { pushes: number };
}

const ctx = { settings: { get: () => defaultSettings(), onChange: () => () => undefined } } as unknown as AppContext;

describe("a tab's page (pageOf, pageUrl)", () => {
  it("is the view's page while it is open", () => {
    const page = fakePage("https://example.com/a");
    expect(pageOf({ webContents: page.wc })).toBe(page.wc);
    expect(pageUrl(fakeTab(page).tab)).toBe("https://example.com/a");
  });

  it("is null once the page is destroyed, or dropped from its view (Electron 44), or there is no view", () => {
    const page = fakePage("https://example.com/a");
    page.destroyed = true;
    expect(pageOf({ webContents: page.wc })).toBeNull();
    expect(pageOf({ webContents: undefined as unknown as WebContents })).toBeNull();
    expect(pageOf(undefined)).toBeNull();
    expect(pageOf(null)).toBeNull();
  });

  it("falls back to the address the tab keeps when the page is closed or has not committed yet", () => {
    const { tab, close } = fakeTab(fakePage(""), "https://example.com/kept");
    expect(pageUrl(tab)).toBe("https://example.com/kept");
    close();
    expect(() => pageUrl(tab)).not.toThrow();
    expect(pageUrl(tab)).toBe("https://example.com/kept");
  });
});

describe("background work on a tab that closes meanwhile", () => {
  it("the reader probe keeps nothing and asks for no state when the tab closed while it ran", async () => {
    let open = true;
    const page = fakePage("https://example.com/article", async () => {
      closing.close();
      open = false;
      return { readerable: true, title: "Article", lang: "en" };
    });
    const closing = fakeTab(page);
    const win = fakeWindow(() => open);
    const reader = new ReaderService(ctx);
    await expect(reader.probe(win, closing.tab)).resolves.toBeUndefined();
    expect(win.pushes).toBe(0);
    expect(reader.isReaderable(closing.tab)).toBe(false);
  });

  it("the reader probe of a tab that is still open marks it readerable", async () => {
    const page = fakePage("https://example.com/article", async () => ({ readerable: true, title: "Article", lang: "en" }));
    const { tab } = fakeTab(page);
    const win = fakeWindow(() => true);
    const reader = new ReaderService(ctx);
    await reader.probe(win, tab);
    expect(reader.isReaderable(tab)).toBe(true);
    expect(win.pushes).toBe(1);
  });

  it("the reader probe and the translation offer do not throw on a tab whose page is already gone", async () => {
    const { tab, close } = fakeTab(fakePage("https://example.com/article"));
    close();
    const win = fakeWindow(() => false);
    await expect(new ReaderService(ctx).probe(win, tab)).resolves.toBeUndefined();
    await expect(new TranslateService(ctx).onPageLoad(win, tab)).resolves.toBeUndefined();
    await expect(new TranslateService(ctx).translate(win, tab)).resolves.toBeUndefined();
    expect(win.pushes).toBe(0);
  });

  it("the translation offer is not kept for a tab that closed while its language was read", async () => {
    let open = true;
    const page = fakePage("https://example.de/", async () => {
      closing.close();
      open = false;
      return "de";
    });
    const closing = fakeTab(page, "https://example.de/");
    const win = fakeWindow(() => open);
    const translate = new TranslateService(ctx);
    await translate.onPageLoad(win, closing.tab);
    expect(translate.barState(closing.tab)).toBeNull();
    expect(win.pushes).toBe(0);
  });

  it("the translation offer shows for an open tab in another language", async () => {
    const { tab } = fakeTab(fakePage("https://example.de/", async () => "de"), "https://example.de/");
    const win = fakeWindow(() => true);
    const translate = new TranslateService(ctx);
    await translate.onPageLoad(win, tab);
    expect(translate.barState(tab)).toMatchObject({ state: "offer", pageLang: "de", target: "en" });
  });
});
