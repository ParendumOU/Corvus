import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** A fake page: `script` runs on loadURL and may redirect; reads report the title. */
let script: (wc: FakeContents) => void = () => {};
class FakeContents extends EventEmitter {
  url = "";
  read = vi.fn(async () => ({ title: "(3) Inbox", text: "" }));
  setAudioMuted(): void {}
  setWindowOpenHandler(): void {}
  getURL(): string {
    return this.url;
  }
  /** Emits a main-frame navigation event; returns whether Corvus let it through. */
  go(kind: "will-redirect" | "will-navigate", url: string): boolean {
    let prevented = false;
    this.emit(kind, { url, isMainFrame: true, preventDefault: () => (prevented = true) });
    if (!prevented) this.url = url;
    return !prevented;
  }
  async loadURL(url: string): Promise<void> {
    this.url = url;
    script(this);
    if (this.aborted) throw new Error("ERR_ABORTED (-3) loading");
  }
  aborted = false;
  executeJavaScriptInIsolatedWorld(): Promise<unknown> {
    return this.read();
  }
  close(): void {}
}
let last: FakeContents;
vi.mock("electron", () => ({
  WebContentsView: class {
    webContents = (last = new FakeContents());
  },
}));

const { PageSourceReader } = await import("../src/main/newtab-page-source");
const session = {} as Electron.Session;

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

async function read(url: string): Promise<unknown> {
  const pending = new PageSourceReader().read(session, url, "", 15, "p:w").catch((err: Error) => err);
  await vi.runAllTimersAsync();
  return pending;
}

describe("PageSourceReader", () => {
  it("reads a page that stays on the allowed site (www and sign-in subdomains included)", async () => {
    script = (wc) => void wc.go("will-redirect", "https://www.example.com/inbox");
    const snap = (await read("https://example.com/")) as { count: number; url: string };
    expect(snap.count).toBe(3);
    expect(snap.url).toBe("https://www.example.com/inbox");
  });

  it("refuses a redirect to another site and never reads it", async () => {
    script = (wc) => {
      if (!wc.go("will-redirect", "https://mail.example.org/")) wc.aborted = true;
    };
    const err = (await read("https://example.com/")) as Error;
    expect(err.message).toMatch(/went on to mail\.example\.org/);
    expect(last.read).not.toHaveBeenCalled();
  });

  it("refuses a page script that navigates to another site", async () => {
    script = (wc) => void wc.go("will-navigate", "https://example.net/");
    const err = (await read("https://example.com/")) as Error;
    expect(err.message).toMatch(/went on to example\.net/);
    expect(last.read).not.toHaveBeenCalled();
  });
});
